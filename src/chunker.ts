import { unified } from "unified";
import remarkParse from "remark-parse";

type MdNode = {
  type: string;
  depth?: number;
  children?: MdNode[];
  value?: string;
  position?: { start: { offset: number }; end: { offset: number } };
};

export function chunkMarkdown(
  raw: string,
  filePath: string,
  maxLen = 1200,
): string[] {
  const tree = unified().use(remarkParse).parse(raw) as MdNode;

  const chunks: string[] = [];
  const headingStack: string[] = [];
  let context = `# File: ${filePath}`;

  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = () => {
    const text = buffer.join("\n\n").trim();
    if (text.length > 20) {
      chunks.push(`${context}\n\n${text}`);
    }
    buffer = [];
    bufferLen = 0;
  };

  const addBlock = (blockText: string) => {
    const len = blockText.length;

    // If single block exceeds limit, flush current buffer and isolate it
    if (len > maxLen) {
      flush();
      chunks.push(`${context}\n\n${blockText}`);
      return;
    }

    // If adding it would exceed limit, flush first
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
      // --- Headings: flush buffer, update context ---
      if (node.type === "heading" && node.depth != null) {
        flush();

        while (headingStack.length >= node.depth!) {
          headingStack.pop();
        }

        const text = extractRaw(node).trim(); // keeps the ## marks
        headingStack.push(text);
        context = `# File: ${filePath}\n${headingStack.join(" > ")}`;
        continue;
      }

      // --- Atomic blocks: never merge, never split ---
      if (
        node.type === "code" ||
        node.type === "table" ||
        node.type === "html"
      ) {
        flush();
        chunks.push(`${context}\n\n${extractRaw(node)}`);
        continue;
      }

      // --- Mergeable blocks: paragraphs, lists, blockquotes ---
      if (
        node.type === "paragraph" ||
        node.type === "list" ||
        node.type === "blockquote"
      ) {
        addBlock(extractRaw(node));
        continue;
      }

      // Catch-all for anything else (e.g., thematic breaks)
      if (node.position) {
        addBlock(extractRaw(node));
      }
    }
  };

  walk(tree.children ?? []);
  flush();

  return chunks;
}
