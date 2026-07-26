import { unified } from "unified";
import remarkParse from "remark-parse";

type MdNode = {
  type: string;
  depth?: number;
  children?: MdNode[];
  value?: string;
  position?: { start: { offset: number }; end: { offset: number } };
};

export interface ChunkResult {
  text: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  chunk_type: string;
}

export function chunkMarkdown(
  raw: string,
  filePath: string,
  maxLen = 1200,
): ChunkResult[] {
  const tree = unified().use(remarkParse).parse(raw) as MdNode;

  const chunks: ChunkResult[] = [];
  const headingStack: string[] = [];
  let context = `# File: ${filePath}`;

  const currentHeadings: Record<string, string> = { h1: "", h2: "", h3: "", h4: "" };
  const allHeadings: { depth: number; text: string }[] = [];

  const cleanHeadingText = (raw: string): string => raw.replace(/^#+\s*/, "");

  const currentMeta = (chunkType: string): Omit<ChunkResult, "text"> => ({
    h1: currentHeadings.h1,
    h2: currentHeadings.h2,
    h3: currentHeadings.h3,
    h4: currentHeadings.h4,
    chunk_type: chunkType,
  });

  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = () => {
    const text = buffer.join("\n\n").trim();
    if (text.length > 20) {
      chunks.push({ text: `${context}\n\n${text}`, ...currentMeta("content") });
    }
    buffer = [];
    bufferLen = 0;
  };

  const addBlock = (blockText: string) => {
    const len = blockText.length;

    if (len > maxLen) {
      flush();
      chunks.push({ text: `${context}\n\n${blockText}`, ...currentMeta("content") });
      return;
    }

    if (bufferLen + len > maxLen && buffer.length > 0) {
      flush();
    }

    buffer.push(blockText);
    bufferLen += len;
  };

  const extractRaw = (node: MdNode): string => {
    if (!node.position) return "";
    return raw.slice(node.position.start.offset, node.position.end.offset);
  };

  const walk = (nodes: MdNode[]) => {
    for (const node of nodes) {
      if (node.type === "heading" && node.depth != null) {
        flush();

        while (headingStack.length >= node.depth!) {
          headingStack.pop();
        }

        const text = extractRaw(node).trim();
        headingStack.push(text);
        context = `# File: ${filePath}\n${headingStack.join(" > ")}`;

        // Update depth-keyed heading tracker, clearing deeper levels
        const clean = cleanHeadingText(text);
        if (node.depth! <= 4) {
          currentHeadings[`h${node.depth}`] = clean;
          for (let d = node.depth! + 1; d <= 4; d++) {
            currentHeadings[`h${d}`] = "";
          }
        }
        allHeadings.push({ depth: node.depth!, text: clean });
        continue;
      }

      if (
        node.type === "code" ||
        node.type === "table" ||
        node.type === "html"
      ) {
        flush();
        const chunkType = node.type === "code" ? "code" : node.type === "table" ? "table" : "content";
        chunks.push({ text: `${context}\n\n${extractRaw(node)}`, ...currentMeta(chunkType) });
        continue;
      }

      if (
        node.type === "paragraph" ||
        node.type === "list" ||
        node.type === "blockquote"
      ) {
        addBlock(extractRaw(node));
        continue;
      }

      if (node.position) {
        addBlock(extractRaw(node));
      }
    }
  };

  walk(tree.children ?? []);
  flush();

  if (allHeadings.length > 0) {
    const tocLines = allHeadings.map(({ depth, text }) => {
      const indent = "  ".repeat(Math.max(0, depth - 1));
      return `${indent}- ${text}`;
    });
    const tocText = [
      `# File: ${filePath}`,
      "",
      "## Document Structure",
      "",
      ...tocLines,
    ].join("\n");

    chunks.push({
      text: tocText,
      h1: "",
      h2: "",
      h3: "",
      h4: "",
      chunk_type: "toc",
    });
  }

  return chunks;
}
