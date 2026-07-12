#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import lancedb, { type VectorQuery } from "@lancedb/lancedb";
import { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chunkMarkdown } from "./chunker.js";

// --- Auto-detect project from Claude Code ---
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;
if (!PROJECT_DIR) {
  console.error(
    "FATAL: CLAUDE_PROJECT_DIR not set. This server must be run from Claude Code.",
  );
  process.exit(1);
}

const PROJECT_NAME = path.basename(PROJECT_DIR);
const SPECS_DIR = process.env.SPECS_DIR ?? path.join(PROJECT_DIR, "specs");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "qwen3-embedding:0.6b";
const DB_PATH = process.env.DB_PATH ?? path.join(PROJECT_DIR, ".mcp-search");
const DEFAULT_MIN_SCORE = parseFloat(process.env.MIN_SCORE ?? "0.7");

// --- Types ---
interface Document {
  id: string;
  filepath: string;
  filename: string;
  chunk: string;
  vector: number[];
}

interface ProjectMeta {
  specsPath: string;
  fileCount: number;
  chunkCount: number;
  indexedAt: string;
  contentHash: string;
}

// --- Helpers ---

async function contentHash(dir: string): Promise<string> {
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

async function loadMeta(): Promise<ProjectMeta | null> {
  try {
    const raw = await fs.readFile(path.join(DB_PATH, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveMeta(meta: ProjectMeta): Promise<void> {
  await fs.mkdir(DB_PATH, { recursive: true });
  await fs.writeFile(
    path.join(DB_PATH, "meta.json"),
    JSON.stringify(meta, null, 2),
  );
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama batch embed failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
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

async function doIndex(force = false): Promise<string> {
  // Check specs dir exists
  try {
    const stat = await fs.stat(SPECS_DIR);
    if (!stat.isDirectory()) throw new Error();
  } catch {
    return `No specs/ directory found at ${SPECS_DIR}`;
  }

  const hash = await contentHash(SPECS_DIR);
  const existing = await loadMeta();

  // Skip if unchanged
  if (!force && existing && existing.contentHash === hash) {
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

    // New AST-based chunker handles file headers & heading breadcrumbs
    const chunks = chunkMarkdown(content, relativePath);

    for (let i = 0; i < chunks.length; i++) {
      pending.push({
        text: chunks[i],
        doc: {
          id: `${fp}:${i}`,
          filepath: fp,
          filename: relativePath,
          chunk: chunks[i],
        },
      });

      if (pending.length >= BATCH) {
        const vectors = await embedBatch(pending.map((p) => p.text));
        for (let j = 0; j < pending.length; j++) {
          allDocs.push({ ...pending[j].doc, vector: vectors[j] });
        }
        pending = [];
      }
    }
  }

  if (pending.length > 0) {
    const vectors = await embedBatch(pending.map((p) => p.text));
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

  // Save metadata
  await saveMeta({
    specsPath: SPECS_DIR,
    fileCount: mdFiles.length,
    chunkCount: allDocs.length,
    indexedAt: new Date().toISOString(),
    contentHash: hash,
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

// --- Server ---

async function main() {
  const server = new Server(
    { name: "semantic-search", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const tools: Tool[] = [
    {
      name: "index",
      description: `Index the specs/ directory in the current project (${PROJECT_NAME}). Automatically skips if content hasn't changed since last index.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          reindex: {
            type: "boolean",
            description:
              "Force re-index even if content unchanged (default false)",
          },
        },
      },
    },
    {
      name: "search",
      description: `Semantic search over indexed specs in ${PROJECT_NAME}. Returns relevant markdown chunks ranked by similarity. Optionally scope results to a specific file.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Natural language search query",
          },
          file: {
            type: "string",
            description:
              "Filter results to a specific file (e.g. 'auth-v2.md'). Matches if the filename contains this string, so partial names work.",
          },
          limit: {
            type: "number",
            description: "Max results (default 5)",
          },
          min_score: {
            type: "number",
            description:
              "Minimum similarity 0-1. Overrides the MIN_SCORE env var (default 0.7). Lower for rough search, higher for precise matches.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "status",
      description: "Show index status for the current project.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "index": {
          const { reindex = false } = (args ?? {}) as any;
          const result = await doIndex(reindex);
          return { content: [{ type: "text", text: result }] };
        }

        case "search": {
          const {
            query,
            file,
            limit = 5,
            min_score = DEFAULT_MIN_SCORE,
          } = (args ?? {}) as any;

          const meta = await loadMeta();
          if (!meta) {
            return {
              content: [
                { type: "text", text: "Not indexed yet. Run index first." },
              ],
              isError: true,
            };
          }

          await fs.mkdir(DB_PATH, { recursive: true });
          const conn = await lancedb.connect(DB_PATH);
          const tbl = await conn.openTable("docs");
          const vector = await embed(query);

          let vq = (tbl.search(vector) as VectorQuery)
            .distanceType("cosine")
            .limit(limit);

          if (file) {
            vq = vq.where(`filename LIKE '%${file.replace(/'/g, "''")}%'`);
          }

          const rows = (await vq.toArray()) as Record<string, any>[];
          const hits = rows.filter((r) => 1 - r._distance >= min_score);

          if (hits.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No results above threshold. Try a different query or lower min_score.",
                },
              ],
            };
          }

          const output = hits
            .map((r, i) => {
              const score = (1 - r._distance).toFixed(3);
              return [
                `--- Result ${i + 1}  [${score}] ---`,
                `file: ${r.filename}`,
                "",
                r.chunk,
              ].join("\n");
            })
            .join("\n\n");

          return { content: [{ type: "text", text: output }] };
        }

        case "status": {
          const meta = await loadMeta();
          if (!meta) {
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `Project: ${PROJECT_NAME}`,
                    `Specs:   ${SPECS_DIR}`,
                    `Status:  not indexed`,
                  ].join("\n"),
                },
              ],
            };
          }

          // Check if stale
          const currentHash = await contentHash(SPECS_DIR).catch(() => null);
          const stale =
            currentHash !== null && currentHash !== meta.contentHash;

          return {
            content: [
              {
                type: "text",
                text: [
                  `Project: ${PROJECT_NAME}`,
                  `Specs:   ${SPECS_DIR}`,
                  `Status:  ${stale ? "STALE — files changed since last index" : "up to date"}`,
                  `Files:   ${meta.fileCount}`,
                  `Chunks:  ${meta.chunkCount}`,
                  `Indexed: ${meta.indexedAt}`,
                ].join("\n"),
              },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err.message ?? JSON.stringify(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
