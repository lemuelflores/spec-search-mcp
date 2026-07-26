// --- Config (read at import time — the CLI sets env before importing this module's graph) ---

const BACKEND_NAMES = ["ollama", "gemini"] as const;
type BackendName = (typeof BACKEND_NAMES)[number];

function resolveBackendName(): BackendName {
  const raw = (process.env.EMBEDDING_BACKEND ?? "ollama").trim().toLowerCase();
  if (!(BACKEND_NAMES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown EMBEDDING_BACKEND "${raw}". Valid values: ${BACKEND_NAMES.join(", ")}.`,
    );
  }
  return raw as BackendName;
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding:0.6b";

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";

// The dimension gemini-embedding-001 emits when outputDimensionality is omitted.
const GEMINI_NATIVE_DIMENSIONS = 3072;
const GEMINI_MIN_DIMENSIONS = 128;

function resolveGeminiDimensions(): number {
  const raw = process.env.GEMINI_EMBEDDING_DIMENSIONS;
  if (raw === undefined) return 768;

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < GEMINI_MIN_DIMENSIONS ||
    parsed > GEMINI_NATIVE_DIMENSIONS
  ) {
    throw new Error(
      `GEMINI_EMBEDDING_DIMENSIONS must be an integer between ${GEMINI_MIN_DIMENSIONS} and ${GEMINI_NATIVE_DIMENSIONS} (got "${raw}"). 768, 1536, and 3072 are the sizes the model is trained to truncate to.`,
    );
  }
  return parsed;
}

const GEMINI_EMBEDDING_DIMENSIONS = resolveGeminiDimensions();

export const EMBEDDING_BACKEND = resolveBackendName();

/** The active backend's model, for status output and index metadata. */
export const EMBEDDING_MODEL =
  EMBEDDING_BACKEND === "gemini" ? GEMINI_EMBEDDING_MODEL : OLLAMA_EMBEDDING_MODEL;

/**
 * Identifies the vector space an index was built in. Vectors are only
 * comparable to others produced by the same backend, model, and dimension, so
 * a change here means an existing index has to be rebuilt from scratch.
 */
export const EMBEDDING_ID = [
  EMBEDDING_BACKEND,
  EMBEDDING_MODEL,
  EMBEDDING_BACKEND === "gemini" ? String(GEMINI_EMBEDDING_DIMENSIONS) : "native",
].join(":");

// --- Types ---

/**
 * Which side of a retrieval pair the text belongs to. Some providers embed
 * stored documents and search queries asymmetrically, and give noticeably
 * better retrieval when told which is which.
 */
export type EmbedPurpose = "document" | "query";

export interface EmbeddingBackend {
  embed(texts: string[], purpose: EmbedPurpose): Promise<number[][]>;
}

// --- Backends ---

function assertCount(
  received: number,
  expected: number,
  provider: string,
): void {
  if (received !== expected) {
    throw new Error(
      `${provider} returned ${received} embeddings for ${expected} inputs.`,
    );
  }
}

function ollamaBackend(): EmbeddingBackend {
  return {
    async embed(texts) {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_EMBEDDING_MODEL, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama embed failed (${res.status}): ${body}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      assertCount(data.embeddings.length, texts.length, "Ollama");
      return data.embeddings;
    },
  };
}

const GEMINI_TASK_TYPES: Record<EmbedPurpose, string> = {
  document: "RETRIEVAL_DOCUMENT",
  query: "RETRIEVAL_QUERY",
};

/**
 * Scales a vector to unit length. gemini-embedding-001 truncates its
 * Matryoshka embeddings without renormalizing, so anything below the model's
 * native dimension has to be normalized before magnitudes mean anything.
 */
function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

function geminiBackend(): EmbeddingBackend {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required when EMBEDDING_BACKEND=gemini.",
    );
  }

  // Gemini requires the model on every sub-request, matching the one in the URL.
  const model = `models/${GEMINI_EMBEDDING_MODEL}`;
  const truncated = GEMINI_EMBEDDING_DIMENSIONS < GEMINI_NATIVE_DIMENSIONS;

  return {
    async embed(texts, purpose) {
      const res = await fetch(`${GEMINI_BASE_URL}/${model}:batchEmbedContents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model,
            content: { parts: [{ text }] },
            taskType: GEMINI_TASK_TYPES[purpose],
            outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        const hint =
          res.status === 429
            ? " — rate limited; wait and retry, or raise your quota"
            : "";
        throw new Error(`Gemini embed failed (${res.status})${hint}: ${body}`);
      }
      const data = (await res.json()) as { embeddings: { values: number[] }[] };
      assertCount(data.embeddings.length, texts.length, "Gemini");
      return data.embeddings.map((e) =>
        truncated ? normalize(e.values) : e.values,
      );
    },
  };
}

let backend: EmbeddingBackend | null = null;

/**
 * Returns the configured backend, constructing it on first use so that
 * commands which never embed anything (such as status on an existing index)
 * do not require the backend's credentials to be present.
 */
export function getBackend(): EmbeddingBackend {
  if (!backend) {
    backend = EMBEDDING_BACKEND === "gemini" ? geminiBackend() : ollamaBackend();
  }
  return backend;
}
