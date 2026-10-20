import { createHash } from "node:crypto";
import GithubSlugger, { slug } from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import type { ChunkOptions, ParsedChunk, ParsedDocument, ParsedSection } from "../types.js";
import { frontmatterSchema, parseMarkdownInputSchema } from "./schemas.js";

// Revalidate previously indexed frontmatter once under the external metadata contract.
export const CHUNKER_VERSION = "markdown-ast-v2";

interface AstNode {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: AstNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"]);

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** A byte-based sizing heuristic, never an exact count for a provider's tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function startOf(node: AstNode): number {
  return node.position?.start.offset ?? 0;
}

function endOf(node: AstNode): number {
  return node.position?.end.offset ?? 0;
}

function lineLookup(markdown: string): (offset: number) => number {
  const starts = [0];
  const newlines = /\r\n|\r|\n/g;
  for (const match of markdown.matchAll(newlines)) starts.push(match.index + match[0].length);
  return (offset) => {
    let lo = 0;
    let hi = starts.length;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  };
}

function codePointWidth(markdown: string, offset: number): number {
  return markdown.codePointAt(offset)! > 0xffff ? 2 : 1;
}

function byteLimitedEnd(markdown: string, start: number, end: number, maxBytes: number): number {
  let cursor = start;
  let bytes = 0;
  while (cursor < end) {
    const width = codePointWidth(markdown, cursor);
    const size = Buffer.byteLength(markdown.slice(cursor, cursor + width), "utf8");
    if (bytes + size > maxBytes) break;
    cursor += width;
    bytes += size;
  }
  if (cursor < end && markdown[cursor] === "\n" && markdown[cursor - 1] === "\r") cursor--;
  return cursor;
}

function byteLimitedStart(markdown: string, start: number, end: number, maxBytes: number): number {
  let cursor = end;
  let bytes = 0;
  while (cursor > start) {
    let width = 1;
    const previous = markdown.charCodeAt(cursor - 1);
    if (previous >= 0xdc00 && previous <= 0xdfff && cursor - 2 >= start) width = 2;
    const size = Buffer.byteLength(markdown.slice(cursor - width, cursor), "utf8");
    if (bytes + size > maxBytes) break;
    cursor -= width;
    bytes += size;
  }
  if (markdown[cursor] === "\n" && markdown[cursor - 1] === "\r") cursor++;
  return cursor;
}

function preferredEnd(
  markdown: string,
  start: number,
  hardEnd: number,
  boundaries: number[],
): number {
  const minimum = start + Math.floor((hardEnd - start) * 0.55);
  let chosen = 0;
  for (const boundary of boundaries) {
    if (boundary > hardEnd) break;
    if (boundary > minimum) chosen = boundary;
  }
  if (chosen) return chosen;
  // When one AST block is too large, prefer a line or a word boundary near the limit.
  for (const pattern of [/\r\n|\r|\n/g, /\s+/gu]) {
    const window = markdown.slice(start, hardEnd);
    for (const match of window.matchAll(pattern)) {
      const offset = start + match.index + match[0].length;
      if (offset > minimum) chosen = offset;
    }
    if (chosen) return chosen;
  }
  return hardEnd;
}

function chunkSpans(
  markdown: string,
  start: number,
  end: number,
  maxBytes: number,
  overlapBytes: number,
  boundaries: number[],
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = start;
  while (cursor < end) {
    const hardEnd = byteLimitedEnd(markdown, cursor, end, maxBytes);
    if (hardEnd <= cursor)
      throw new Error("Chunk target is too small for a source character. Increase targetTokens.");
    const next = hardEnd === end ? end : preferredEnd(markdown, cursor, hardEnd, boundaries);
    spans.push([cursor, next]);
    if (next === end) break;
    let overlapStart = byteLimitedStart(markdown, cursor, next, overlapBytes);
    const boundary = boundaries.find(
      (candidate) => candidate >= overlapStart && candidate > cursor && candidate < next,
    );
    if (boundary !== undefined) overlapStart = boundary;
    // Progress is mandatory, even with an oversized overlap setting or tiny section.
    cursor = overlapStart > cursor ? overlapStart : next;
  }
  return spans;
}

/** Read text from the original AST, so slicing a fenced block never invents a new fence. */
function searchableText(node: AstNode, markdown: string, start: number, end: number): string {
  const nodeStart = startOf(node);
  const nodeEnd = node.type === "root" ? markdown.length : endOf(node);
  if (nodeEnd <= start || nodeStart >= end) return "";
  if (node.type === "yaml" || node.type === "definition" || node.type === "thematicBreak")
    return "";
  if (node.type === "break") return "\n";
  if (node.type === "image" || node.type === "imageReference") {
    if (start <= nodeStart && end >= nodeEnd) return node.alt ?? "";
    // An oversized image label may itself span chunks. Return only its intersecting
    // source text, without repeating the complete label or indexing the asset URL.
    const labelStart = nodeStart + 2;
    let labelEnd = labelStart;
    let depth = 1;
    for (; labelEnd < nodeEnd; labelEnd++) {
      if (markdown[labelEnd] === "\\") {
        labelEnd++;
      } else if (markdown[labelEnd] === "[") {
        depth++;
      } else if (markdown[labelEnd] === "]" && --depth === 0) {
        break;
      }
    }
    const intersectionStart = Math.max(labelStart, start);
    const intersectionEnd = Math.min(labelEnd, end);
    return intersectionStart < intersectionEnd
      ? markdown.slice(intersectionStart, intersectionEnd)
      : "";
  }
  if (node.type === "code") {
    if (start <= nodeStart && end >= nodeEnd) return node.value ?? "";
    const raw = markdown.slice(nodeStart, nodeEnd);
    const opening = /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n|$)/.exec(raw);
    let contentStart = nodeStart;
    let contentEnd = nodeEnd;
    if (opening) {
      contentStart += opening[0].length;
      const fence = opening[1]!;
      const closing = new RegExp(
        `(?:\\r\\n|\\r|\\n)[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`,
      ).exec(raw);
      if (closing) contentEnd = nodeStart + closing.index;
    }
    return markdown.slice(
      Math.max(contentStart, start),
      Math.max(Math.max(contentStart, start), Math.min(contentEnd, end)),
    );
  }
  if (node.children) {
    const inline = new Set([
      "paragraph",
      "heading",
      "emphasis",
      "strong",
      "delete",
      "link",
      "linkReference",
      "tableCell",
    ]);
    const separator = inline.has(node.type) ? "" : node.type === "tableRow" ? "\t" : "\n";
    return node.children
      .map((child) => searchableText(child, markdown, start, end))
      .filter(Boolean)
      .join(separator);
  }
  if (node.value !== undefined) {
    if (start <= nodeStart && end >= nodeEnd) return node.value;
    return markdown.slice(Math.max(nodeStart, start), Math.min(nodeEnd, end));
  }
  return "";
}

function documentTitle(tree: AstNode, bookTitle: string): string {
  const frontmatter = tree.children?.find((node) => node.type === "yaml");
  if (frontmatter?.value) {
    const metadata: unknown = parseYaml(frontmatter.value, { maxAliasCount: 100 });
    // An empty YAML document is valid and has no metadata. Other scalar/array
    // values or a non-string title do not match the supported frontmatter format.
    const validation = frontmatterSchema.safeParse(metadata ?? {});
    if (!validation.success)
      throw new Error(
        "Invalid Markdown frontmatter structure: expected a metadata object with an optional string title.",
      );
    if (validation.data.title?.trim()) return validation.data.title.trim();
  }
  const heading = tree.children?.find((node) => node.type === "heading" && node.depth === 1);
  return heading ? toString(heading).trim() || bookTitle : bookTitle;
}

export function parseMarkdown(
  documentIdInput: string,
  markdownInput: string,
  bookTitleInput: string,
  optionsInput: ChunkOptions,
): ParsedDocument {
  const validation = parseMarkdownInputSchema.safeParse({
    documentId: documentIdInput,
    markdown: markdownInput,
    bookTitle: bookTitleInput,
    options: optionsInput,
  });
  if (!validation.success) throw new Error("Invalid Markdown parser input structure.");
  const { documentId, markdown, bookTitle, options } = validation.data;
  if (options.targetTokens < 1) {
    throw new Error("targetTokens must be a positive integer.");
  }
  if (options.overlapTokens < 0 || options.overlapTokens >= options.targetTokens) {
    throw new Error("overlapTokens must be a non-negative integer smaller than targetTokens.");
  }
  const tree = parser.parse(markdown) as AstNode;
  const title = documentTitle(tree, bookTitle);
  const lineAt = lineLookup(markdown);
  const slugger = new GithubSlugger();
  const root: ParsedSection = {
    id: hash(documentId, "root-section"),
    parentId: null,
    title,
    level: 0,
    anchor: slugger.slug("top"),
    headingPath: [],
    startOffset: 0,
    endOffset: markdown.length,
    startLine: 1,
    endLine: lineAt(Math.max(0, markdown.length - 1)),
  };
  const sections = [root];
  const stack = [root];
  const headings = (tree.children ?? []).filter((node) => node.type === "heading");
  for (const heading of headings) {
    const startOffset = startOf(heading);
    const level = heading.depth!;
    while (stack.length > 1 && stack.at(-1)!.level >= level) {
      const closing = stack.pop()!;
      closing.endOffset = startOffset;
      closing.endLine = lineAt(Math.max(closing.startOffset, startOffset - 1));
    }
    const parent = stack.at(-1)!;
    const headingTitle = toString(heading).trim();
    const anchor = slugger.slug(slug(headingTitle) || "section");
    const section: ParsedSection = {
      id: hash(documentId, "heading-section", anchor),
      parentId: parent.id,
      title: headingTitle,
      level,
      anchor,
      headingPath: [...parent.headingPath, headingTitle],
      startOffset,
      endOffset: markdown.length,
      startLine: lineAt(startOffset),
      endLine: lineAt(Math.max(startOffset, markdown.length - 1)),
    };
    sections.push(section);
    stack.push(section);
  }
  const chunks: ParsedChunk[] = [];
  const occurrences = new Map<string, number>();
  const blockBoundaries = (tree.children ?? []).map(startOf).sort((a, b) => a - b);
  for (const [index, section] of sections.entries()) {
    const start = section.startOffset;
    const end = sections[index + 1]?.startOffset ?? markdown.length;
    if (start >= end || !markdown.slice(start, end).trim()) continue;
    const context =
      [
        `Book: ${bookTitle}`,
        ...(section.headingPath.length ? [`Section: ${section.headingPath.join(" > ")}`] : []),
      ].join("\n") + "\n\n";
    const maxBytes = options.targetTokens * 3 - Buffer.byteLength(context, "utf8");
    if (maxBytes < 12) {
      throw new Error(
        `Chunk target is too small for the book/section context "${section.headingPath.join(" > ") || bookTitle}". Increase targetTokens or shorten the title/headings.`,
      );
    }
    const overlapBytes = Math.min(options.overlapTokens * 3, Math.floor(maxBytes / 3));
    const boundaries = blockBoundaries.filter((offset) => offset > start && offset < end);
    for (const [startOffset, endOffset] of chunkSpans(
      markdown,
      start,
      end,
      maxBytes,
      overlapBytes,
      boundaries,
    )) {
      const raw = markdown.slice(startOffset, endOffset);
      const text = searchableText(tree, markdown, startOffset, endOffset).trim();
      const embeddingText = context + text;
      const contentHash = hash(raw);
      const duplicateKey = `${section.id}\0${contentHash}`;
      const occurrence = occurrences.get(duplicateKey) ?? 0;
      occurrences.set(duplicateKey, occurrence + 1);
      chunks.push({
        id: hash(documentId, section.id, contentHash, String(occurrence)),
        sectionId: section.id,
        ordinal: chunks.length,
        markdown: raw,
        text,
        embeddingText,
        contentHash,
        inputHash: hash(embeddingText),
        headingPath: section.headingPath,
        startOffset,
        endOffset,
        startLine: lineAt(startOffset),
        endLine: lineAt(Math.max(startOffset, endOffset - 1)),
        estimatedTokens: estimateTokens(embeddingText),
      });
    }
  }
  return { title, sections, chunks };
}
