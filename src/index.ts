#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { doIndex, doSearch, doStatus, PROJECT_NAME } from "./core.js";

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
      description: `Semantic search over indexed specs in ${PROJECT_NAME}. Returns relevant markdown chunks ranked by similarity. Optionally filter by file, section heading, or chunk type.`,
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
          section: {
            type: "string",
            description:
              "Filter to chunks under a specific heading/section. Case-insensitive substring match against all heading levels (h1–h4). Example: 'authentication' matches chunks under '## Authentication Flow'.",
          },
          chunk_type: {
            type: "string",
            description:
              "Filter by chunk type: 'content', 'code', 'table', or 'toc'. Use 'toc' to retrieve a document's structure map.",
          },
          limit: {
            type: "number",
            description: "Max results (default 5)",
          },
          min_score: {
            type: "number",
            description:
              "Minimum cosine similarity 0-1. Overrides the MIN_SCORE env var (default 0.44). Lower for rough search, higher for precise matches. Scores are model-relative: with the default embedding model, on-topic chunks land around 0.45-0.80 and unrelated ones below 0.45.",
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
          const result = await doSearch((args ?? {}) as any);
          return { content: [{ type: "text", text: result.text }] };
        }

        case "status": {
          const result = await doStatus();
          return { content: [{ type: "text", text: result }] };
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
