# 🔍 mcp-semantic-search

**Ask your specs a question instead of grepping them.**

An MCP server & CLI that gives AI agents local semantic search over markdown docs — running 100% on your machine by default.

---

## Why use this?

Traditional `grep` misses ideas that don't match exact keywords.

`mcp-semantic-search` understands intent across your local specs, RFCs, and internal docs.

```sh
$ mcp-semantic-search search "how do we stop repeated failed logins"

--- Result 1  [0.688]  content ---
file: auth.md
section: Sessions > Credential attempts

After five consecutive bad passwords the account enters a 15-minute
cooling-off period. The counter resets on any successful sign-in.

--- Result 2  [0.541]  content ---
file: gateway.md
section: Rate limits > Edge throttling

A single IP address is capped at 20 requests per minute against
/session endpoints. Anything beyond that receives a 429 before it
ever reaches the application.
```

> **Notice:** Neither chunk contains the words _"failed"_ or _"login"_ — `grep -ri "failed login"` returns nothing at all. Semantic search finds both halves of the answer: the account lockout in the auth spec, and the network throttle that backs it up in a different file with entirely different vocabulary.

---

## Key Features

- 🧱 **Structure-Aware Chunking** — Splits markdown on heading boundaries (`H1`–`H4`) without breaking code blocks or tables.
- 🔒 **Local & Private** — Runs via [LanceDB](https://lancedb.com) & [Ollama](https://ollama.com). Zero docs leave your machine.
- 🗺️ **Document Maps** — Generates outline (`toc`) chunks so agents can scan doc structures before reading details.
- ⚡ **Zero-Overhead Indexing** — File hashes ensure re-indexing only happens when files actually change.
- 🎯 **Targeted Filtering** — Filter search by filename, heading, or chunk type (`content`, `code`, `table`, `toc`).

---

## Quick Start

### 1. Requirements & Build

Requires **Node.js 22+** and **Ollama** (or a Gemini API key).

```sh
# Pull default model
ollama pull qwen3-embedding:0.6b

# Clone & Build
git clone <repo-url> mcp-semantic-search
cd mcp-semantic-search
npm install && npm run build
```

### 2. Run locally (CLI)

Inside the target repository you want to index:

```sh
cd ~/projects/my-app
echo '.mcp-search/' >> .gitignore

/path/to/mcp-semantic-search index
/path/to/mcp-semantic-search search "how are expired sessions cleaned up"
```

---

## Setup as an MCP Server

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "specs": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-semantic-search/dist/index.js"]
    }
  }
}
```

### MCP Tools Exposed

- **`index`** — Indexes your markdown specs directory (set `reindex: true` to force rebuild).
- **`search`** — Queries indexed documents (`query`, `file`, `section`, `chunk_type`, `limit`, `min_score`).
- **`status`** — Checks index health, chunk counts, and staleness.

> **Agent Prompting Tip (`CLAUDE.md`):**
> Add this to your project's `CLAUDE.md`:
> _"Search specs using the `specs` MCP server. Run `index` first if `status` shows the index as missing or stale."_

---

## Configuration

Set environment variables in your shell or directly inside `.mcp.json` under the `"env"` block.

### Global Settings

| Variable            | Default                 | Purpose                               |
| :------------------ | :---------------------- | :------------------------------------ |
| `EMBEDDING_BACKEND` | `ollama`                | Vector provider: `ollama` or `gemini` |
| `SPECS_DIR`         | `<project>/specs`       | Absolute path to markdown specs       |
| `DB_PATH`           | `<project>/.mcp-search` | Where LanceDB index is stored         |
| `MIN_SCORE`         | `0.7`                   | Default similarity threshold          |

### Ollama Backend (Default)

| Variable                 | Default                  | Purpose                    |
| :----------------------- | :----------------------- | :------------------------- |
| `OLLAMA_BASE_URL`        | `http://localhost:11434` | Endpoint for Ollama daemon |
| `OLLAMA_EMBEDDING_MODEL` | `qwen3-embedding:0.6b`   | Embedding model to use     |

### Gemini Backend (Cloud Option)

| Variable                      | Default                | Purpose                                  |
| :---------------------------- | :--------------------- | :--------------------------------------- |
| `GEMINI_API_KEY`              | _(Required)_           | Required when `EMBEDDING_BACKEND=gemini` |
| `GEMINI_EMBEDDING_MODEL`      | `gemini-embedding-001` | Embedding model to use                   |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768`                  | Vector width (128–3072)                  |

_Note: Changing backends automatically triggers a clean index rebuild on the next run._

### Example `.mcp.json` with Custom Config

```json
{
  "mcpServers": {
    "specs": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-semantic-search/dist/index.js"],
      "env": {
        "SPECS_DIR": "/absolute/path/to/my-app/docs",
        "EMBEDDING_BACKEND": "gemini",
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

## CLI Options

```sh
mcp-semantic-search search <query> [options]
```

| Flag                  | Description                             | Default |
| :-------------------- | :-------------------------------------- | :------ |
| `--file <str>`        | Filter by matching filename             | —       |
| `--section <str>`     | Filter by matching section heading      | —       |
| `--chunk-type <type>` | `content` \| `code` \| `table` \| `toc` | All     |
| `--limit <n>`         | Max results to return                   | `5`     |
| `--min-score <f>`     | Similarity floor (0.0–1.0)              | `0.7`   |
| `--json`              | Output raw JSON instead of plain text   | `false` |

---

## License

MIT
