#!/usr/bin/env node
import * as path from "node:path";

const USAGE = `Usage: mcp-semantic-search <command> [options]

Commands:
  index [--reindex]                 Index the specs/ directory
  search <query> [options]          Semantic search over indexed specs
  status                            Show index status

Global options:
  --project <dir>                   Project directory (default: $CLAUDE_PROJECT_DIR or cwd)

search options:
  --file <substr>                   Filter results to filenames containing <substr>
  --section <substr>                Filter to chunks under a matching heading (h1-h4)
  --chunk-type <type>                Filter by chunk type: content | code | table | toc
  --limit <n>                       Max results (default 5)
  --min-score <f>                   Minimum similarity 0-1 (default 0.44)
  --json                            Emit structured JSON instead of formatted text

  -h, --help                         Show this help
`;

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "-h" || tok === "--help") {
      flags.help = true;
      i++;
      continue;
    }
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const boolFlags = new Set(["reindex", "json", "help"]);
      if (boolFlags.has(key)) {
        flags[key] = true;
        i++;
      } else {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`Missing value for --${key}`);
        }
        flags[key] = value;
        i += 2;
      }
      continue;
    }
    if (!command) {
      command = tok;
    } else {
      positionals.push(tok);
    }
    i++;
  }

  return { command, positionals, flags };
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (!parsed.command) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  if (typeof parsed.flags.project === "string") {
    process.env.CLAUDE_PROJECT_DIR = path.resolve(parsed.flags.project);
  }

  // Dynamic import so core.ts reads config (CLAUDE_PROJECT_DIR) after we've set it above.
  const core = await import("./core.js");

  switch (parsed.command) {
    case "index": {
      const result = await core.doIndex(Boolean(parsed.flags.reindex));
      console.log(result);
      break;
    }

    case "search": {
      const query = parsed.positionals.join(" ").trim();
      if (!query) {
        throw new Error("search requires a query, e.g. `search \"auth flow\"`");
      }

      const result = await core.doSearch({
        query,
        file: typeof parsed.flags.file === "string" ? parsed.flags.file : undefined,
        section: typeof parsed.flags.section === "string" ? parsed.flags.section : undefined,
        chunk_type:
          typeof parsed.flags["chunk-type"] === "string"
            ? (parsed.flags["chunk-type"] as string)
            : undefined,
        limit: typeof parsed.flags.limit === "string" ? Number(parsed.flags.limit) : undefined,
        min_score:
          typeof parsed.flags["min-score"] === "string"
            ? Number(parsed.flags["min-score"])
            : undefined,
      });

      if (parsed.flags.json) {
        console.log(JSON.stringify(result.hits, null, 2));
      } else {
        console.log(result.text);
      }
      break;
    }

    case "status": {
      const result = await core.doStatus();
      console.log(result);
      break;
    }

    default: {
      process.stderr.write(`Unknown command: ${parsed.command}\n\n${USAGE}`);
      process.exit(1);
    }
  }
}

run().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
