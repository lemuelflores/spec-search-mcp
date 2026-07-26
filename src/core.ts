import lancedb, { type VectorQuery } from "@lancedb/lancedb";
import { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chunkMarkdown } from "./chunker.js";
import {
  EMBEDDING_BACKEND,
  EMBEDDING_ID,
  EMBEDDING_MODEL,
  getBackend,
} from "./embeddings.js";

// --- Config (read at import time — CLI sets CLAUDE_PROJECT_DIR before importing) ---
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

export const PROJECT_NAME = path.basename(PROJECT_DIR);
export const SPECS_DIR = process.env.SPECS_DIR ?? path.join(PROJECT_DIR, "specs");

const DB_PATH = process.env.DB_PATH ?? path.join(PROJECT_DIR, ".mcp-search");

/**
 * Cosine-similarity floor below which a hit is treated as noise.
 *
 * Calibrated against the default backend (Ollama + qwen3-embedding:0.6b) over
 * two markdown corpora: on-topic queries put their best correct chunk at
 * 0.44-0.81, while queries the corpus cannot answer top out at 0.46. 0.44 is
 * the highest floor that still returns every on-topic query in those runs.
 *
 * The absolute scale is a property of the embedding model, not of the search:
 * a different backend, model, or dimension count shifts the whole distribution,
 * so MIN_SCORE should be re-measured after changing EMBEDDING_BACKEND.
 */
export const DEFAULT_MIN_SCORE = parseFloat(process.env.MIN_SCORE ?? "0.44");

const SCHEMA_VERSION = 3;

// --- Types ---
interface Document {
  id: string;
  filepath: string;
  filename: string;
  chunk: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  chunk_type: string;
  vector: number[];
}

interface ProjectMeta {
  specsPath: string;
  fileCount: number;
  chunkCount: number;
  indexedAt: string;
  contentHash: string;
  schemaVersion?: number;
  /** Vector space the stored embeddings belong to; see EMBEDDING_ID. */
  embeddingId?: string;
  /** Observed width of the stored vectors, recorded for diagnostics. */
  dimensions?: number;
}

export interface SearchParams {
  query: string;
  file?: string;
  section?: string;
  chunk_type?: string;
  limit?: number;
  min_score?: number;
}

export interface SearchHit {
  score: number;
  filename: string;
  section: string;
  chunk_type: string;
  chunk: string;
}

export interface SearchResult {
  text: string;
  hits: SearchHit[];
}

// --- Helpers ---

export async function contentHash(dir: string): Promise<string> {
  // Simple hash: concat filenames + mtimes + sizes for change detection
  const files = await findMarkdownFiles(dir);
  const parts: string[] = [];
  for (const f of files.sort()) {
    const stat = await fs.stat(f);
    parts.push(`${f}:${stat.mtimeMs}:${stat.size}`);
  }
  const { createHash } = await import("crypto");
  return createHash("md5").update(parts.join("\n")).digest("hex").slice(0, 12);
}

export async function loadMeta(): Promise<ProjectMeta | null> {
  try {
    const raw = await fs.readFile(path.join(DB_PATH, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveMeta(meta: ProjectMeta): Promise<void> {
  await fs.mkdir(DB_PATH, { recursive: true });
  await fs.writeFile(
    path.join(DB_PATH, "meta.json"),
    JSON.stringify(meta, null, 2),
  );
}

export async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(full);
      } else if (entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
  }
  await walk(dir);
  return files;
}

// --- Indexing logic ---

export async function doIndex(force = false): Promise<string> {
  // Check specs dir exists
  try {
    const stat = await fs.stat(SPECS_DIR);
    if (!stat.isDirectory()) throw new Error();
  } catch {
    return `No specs/ directory found at ${SPECS_DIR}`;
  }

  const hash = await contentHash(SPECS_DIR);
  const existing = await loadMeta();

  // Skip if unchanged, schema is current, and the vectors are still comparable
  if (
    !force &&
    existing &&
    existing.contentHash === hash &&
    existing.schemaVersion === SCHEMA_VERSION &&
    existing.embeddingId === EMBEDDING_ID
  ) {
    return `Already indexed and up to date (${existing.fileCount} files, ${existing.chunkCount} chunks). Use reindex to force.`;
  }

  const mdFiles = await findMarkdownFiles(SPECS_DIR);
  if (mdFiles.length === 0) {
    return `No .md files found in ${SPECS_DIR}`;
  }

  // Build chunks
  const BATCH = 20;
  const allDocs: Document[] = [];
  let pending: { text: string; doc: Omit<Document, "vector"> }[] = [];

  for (const fp of mdFiles) {
    const content = await fs.readFile(fp, "utf-8");
    const relativePath = path.relative(SPECS_DIR, fp);

    const chunkResults = chunkMarkdown(content, relativePath);

    for (let i = 0; i < chunkResults.length; i++) {
      const cr = chunkResults[i];
      pending.push({
        text: cr.text,
        doc: {
          id: `${fp}:${i}`,
          filepath: fp,
          filename: relativePath,
          chunk: cr.text,
          h1: cr.h1,
          h2: cr.h2,
          h3: cr.h3,
          h4: cr.h4,
          chunk_type: cr.chunk_type,
        },
      });

      if (pending.length >= BATCH) {
        const vectors = await getBackend().embed(
          pending.map((p) => p.text),
          "document",
        );
        for (let j = 0; j < pending.length; j++) {
          allDocs.push({ ...pending[j].doc, vector: vectors[j] });
        }
        pending = [];
      }
    }
  }

  if (pending.length > 0) {
    const vectors = await getBackend().embed(
      pending.map((p) => p.text),
      "document",
    );
    for (let j = 0; j < pending.length; j++) {
      allDocs.push({ ...pending[j].doc, vector: vectors[j] });
    }
  }

  // Write to LanceDB (replace entire table for this project)
  await fs.mkdir(DB_PATH, { recursive: true });
  const conn = await lancedb.connect(DB_PATH);
  const tableNames = await conn.tableNames();

  if (tableNames.includes("docs")) {
    await conn.dropTable("docs");
  }
  await conn.createTable(
    "docs",
    allDocs as unknown as Record<string, unknown>[],
  );

  await saveMeta({
    specsPath: SPECS_DIR,
    fileCount: mdFiles.length,
    chunkCount: allDocs.length,
    indexedAt: new Date().toISOString(),
    contentHash: hash,
    schemaVersion: SCHEMA_VERSION,
    embeddingId: EMBEDDING_ID,
    dimensions: allDocs[0]?.vector.length,
  });

  const fileList = mdFiles
    .map((f) => `  • ${path.relative(SPECS_DIR, f)}`)
    .join("\n");

  return [
    `Indexed ${mdFiles.length} files → ${allDocs.length} chunks`,
    "",
    fileList,
  ].join("\n");
}

// --- Search logic ---

export async function doSearch(params: SearchParams): Promise<SearchResult> {
  const {
    query,
    file,
    section,
    chunk_type: chunkTypeFilter,
    limit = 5,
    min_score = DEFAULT_MIN_SCORE,
  } = params;

  const meta = await loadMeta();
  if (!meta) {
    throw new Error("Not indexed yet. Run index first.");
  }
  // Querying across vector spaces fails deep inside LanceDB on a dimension
  // mismatch, so catch it here where the cause can still be named.
  if (meta.embeddingId !== EMBEDDING_ID) {
    throw new Error(
      `Index was built with a different embedding backend (${meta.embeddingId ?? "unknown"}) than the one now configured (${EMBEDDING_ID}). Run index to rebuild.`,
    );
  }

  await fs.mkdir(DB_PATH, { recursive: true });
  const conn = await lancedb.connect(DB_PATH);
  const tbl = await conn.openTable("docs");
  const [vector] = await getBackend().embed([query], "query");

  let vq = (tbl.search(vector) as VectorQuery)
    .distanceType("cosine")
    .limit(limit);

  const conditions: string[] = [];

  if (file) {
    conditions.push(`filename LIKE '%${file.replace(/'/g, "''")}%'`);
  }

  if (section && section.trim()) {
    const esc = section.replace(/'/g, "''");
    conditions.push(
      `(lower(h1) LIKE lower('%${esc}%') OR lower(h2) LIKE lower('%${esc}%') OR lower(h3) LIKE lower('%${esc}%') OR lower(h4) LIKE lower('%${esc}%'))`,
    );
  }

  if (chunkTypeFilter) {
    conditions.push(`chunk_type = '${chunkTypeFilter.replace(/'/g, "''")}'`);
  }

  if (conditions.length > 0) {
    vq = vq.where(conditions.join(" AND "));
  }

  const rows = (await vq.toArray()) as Record<string, any>[];
  const rawHits = rows.filter((r) => 1 - r._distance >= min_score);

  const hits: SearchHit[] = rawHits.map((r) => ({
    score: 1 - r._distance,
    filename: r.filename,
    section: [r.h1, r.h2, r.h3, r.h4].filter(Boolean).join(" > "),
    chunk_type: r.chunk_type,
    chunk: r.chunk,
  }));

  if (hits.length === 0) {
    // Naming the closest rejected score distinguishes "nothing matched" from
    // "the floor was slightly too high", which is otherwise invisible.
    const best = rows.reduce((max, r) => Math.max(max, 1 - r._distance), 0);
    const closest =
      rows.length > 0
        ? ` Closest match scored ${best.toFixed(3)}.`
        : "";
    return {
      text: `No results at or above min_score ${min_score}.${closest} Try a different query or a lower min_score.`,
      hits: [],
    };
  }

  const text = hits
    .map((h, i) => {
      return [
        `--- Result ${i + 1}  [${h.score.toFixed(3)}]  ${h.chunk_type} ---`,
        `file: ${h.filename}`,
        h.section ? `section: ${h.section}` : null,
        "",
        h.chunk,
      ]
        .filter((line) => line !== null)
        .join("\n");
    })
    .join("\n\n");

  return { text, hits };
}

// --- Status logic ---

export async function doStatus(): Promise<string> {
  const backendLine = `Backend: ${EMBEDDING_BACKEND} (${EMBEDDING_MODEL})`;

  const meta = await loadMeta();
  if (!meta) {
    return [
      `Project: ${PROJECT_NAME}`,
      `Specs:   ${SPECS_DIR}`,
      backendLine,
      `Status:  not indexed`,
    ].join("\n");
  }

  // Check if stale, from either changed files or a changed vector space
  const currentHash = await contentHash(SPECS_DIR).catch(() => null);
  const filesChanged = currentHash !== null && currentHash !== meta.contentHash;
  const backendChanged = meta.embeddingId !== EMBEDDING_ID;

  let status = "up to date";
  if (backendChanged) {
    status = "STALE — embedding backend or model changed since last index";
  } else if (filesChanged) {
    status = "STALE — files changed since last index";
  }

  return [
    `Project: ${PROJECT_NAME}`,
    `Specs:   ${SPECS_DIR}`,
    backendLine,
    `Vectors: ${meta.dimensions ?? "unknown"} dimensions`,
    `Status:  ${status}`,
    `Files:   ${meta.fileCount}`,
    `Chunks:  ${meta.chunkCount}`,
    `Indexed: ${meta.indexedAt}`,
  ].join("\n");
}
