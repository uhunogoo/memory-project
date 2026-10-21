import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { discoverBooks } from "../src/ingestion/books.js";
import { parseMarkdown } from "../src/ingestion/markdown.js";

const temporaryDirectories: string[] = [];
const normalOptions = { targetTokens: 800, overlapTokens: 100 };

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "book-ingestion-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function put(root: string, filename: string, content: string): Promise<void> {
  const absolutePath = path.join(root, filename);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("book discovery", () => {
  it("treats first-level folders as books and naturally sorts recursive Markdown paths", async () => {
    const root = await fixture();
    await put(root, "Книга/part-10/10-last.MD", "# Остання");
    await put(root, "Книга/part-2/2-first.md", "# Перша\r\nТекст 🧠");
    await put(root, "Книга/part-2/10-next.md", "# Друга");
    await put(root, "Книга/images/image.png", "not markdown");
    await put(root, "loose.md", "# Orphan");
    await mkdir(path.join(root, "Empty"));
    const discovered = await discoverBooks(root);
    expect(discovered.books).toHaveLength(2);
    const book = discovered.books.find((candidate) => candidate.directory === "Книга")!;
    expect(book.title).toBe("Книга");
    expect(book.files.map((file) => file.relativePath)).toEqual([
      "part-2/2-first.md",
      "part-2/10-next.md",
      "part-10/10-last.MD",
    ]);
    expect(book.files[0]!.markdown).toBe("# Перша\r\nТекст 🧠");
    expect(book.files.map((file) => file.order)).toEqual([0, 1, 2]);
    expect(discovered.books.find((candidate) => candidate.directory === "Empty")!.files).toEqual(
      [],
    );
    expect(discovered.warnings).toEqual([expect.stringContaining("loose.md")]);
    expect((await discoverBooks(root)).books).toEqual(discovered.books);
  });

  it("uses the exact manifest composition/order and metadata", async () => {
    const root = await fixture();
    await put(root, "folder/1.md", "# One");
    await put(root, "folder/nested/2.md", "# Two");
    await put(root, "folder/notes.md", "Do not index");
    await put(
      root,
      "folder/book.json",
      JSON.stringify({
        title: "Actual title",
        author: "Author",
        language: "uk",
        files: ["nested/2.md", "1.md"],
      }),
    );
    const { books } = await discoverBooks(root);
    expect(books[0]).toMatchObject({
      directory: "folder",
      title: "Actual title",
      author: "Author",
      language: "uk",
    });
    expect(books[0]!.files.map((file) => file.relativePath)).toEqual(["nested/2.md", "1.md"]);
  });

  it.each([
    { files: ["../outside.md"] },
    { files: ["/outside.md"] },
    { files: ["C:\\outside.md"] },
    { files: ["sub\\chapter.md"] },
    { files: ["./chapter.md"] },
    { files: ["chapter.md", "chapter.md"] },
    { files: ["missing.md"] },
    { files: ["image.png"] },
    { files: "chapter.md" },
    { title: "" },
    { unknown: "property" },
  ])("rejects invalid or unsafe manifests: %j", async (manifest) => {
    const root = await fixture();
    await put(root, "book/chapter.md", "Source");
    await put(root, "book/book.json", JSON.stringify(manifest));
    await expect(discoverBooks(root)).rejects.toThrow(/book\.json/);
  });

  it("rejects symbolic links in books, including links to directories", async () => {
    const root = await fixture();
    await put(root, "book/chapter.md", "Source");
    await symlink(path.join(root, "book"), path.join(root, "book", "linked-directory"));
    await expect(discoverBooks(root)).rejects.toThrow(/Symbolic links/);
  });

  it.each([null, [], { title: 123 }, { files: [1] }, { files: [null] }, { author: {} }])(
    "rejects a malformed manifest before applying file rules: %j",
    async (value) => {
      const root = await fixture();
      await put(root, "book/book.json", JSON.stringify(value));
      await expect(discoverBooks(root)).rejects.toThrow("invalid book.json structure");
    },
  );

  it("retains duplicate and path policies after the manifest passes structural validation", async () => {
    const root = await fixture();
    await put(root, "book/chapter.md", "Source");
    await put(root, "book/book.json", JSON.stringify({ files: ["chapter.md", "chapter.md"] }));
    await expect(discoverBooks(root)).rejects.toThrow('duplicate file "chapter.md"');
    await put(root, "book/book.json", JSON.stringify({ files: ["../other.md"] }));
    await expect(discoverBooks(root)).rejects.toThrow("without traversal");
  });
});

describe("Markdown AST sections and chunks", () => {
  it.each(["title: 123", "title: [one, two]", "title: null", "- one\n- two", "a scalar"])(
    "rejects unsupported frontmatter structure: %s",
    (yaml) => {
      expect(() =>
        parseMarkdown("doc", `---\n${yaml}\n---\n# Heading\nBody`, "Book", normalOptions),
      ).toThrow("Invalid Markdown frontmatter structure");
    },
  );

  it("accepts additional frontmatter metadata and keeps the source unchanged", () => {
    const markdown =
      '---\ntitle: "  Document title  "\ntags: [one, two]\ncustom:\n  enabled: true\n---\n# Heading\nBody';
    const parsed = parseMarkdown("doc", markdown, "Book", normalOptions);
    expect(parsed.title).toBe("Document title");
    expect(parsed.chunks.map((chunk) => chunk.markdown).join("")).toBe(markdown);
    expect(
      parseMarkdown("doc", '---\ntitle: "  "\n---\n# Fallback', "Book", normalOptions).title,
    ).toBe("Fallback");
    expect(
      parseMarkdown("doc", "---\n# Empty metadata\n---\n# Fallback", "Book", normalOptions).title,
    ).toBe("Fallback");
  });

  it("preserves CRLF/Unicode offsets and sections while ignoring headings inside code", () => {
    const markdown = [
      "---",
      'title: "Назва документа"',
      "---",
      "",
      "Передмова 🧠.",
      "",
      "# Частина",
      "",
      "Вступ із **виділенням**.",
      "",
      "## Розділ",
      "",
      "- перший пункт",
      "- другий пункт",
      "",
      "```md",
      "# Не розділ",
      "```",
      "",
      "## Розділ",
      "",
      "> Цитата",
      "",
      "| A | B |",
      "| - | - |",
      "| один | два |",
      "",
    ].join("\r\n");
    const parsed = parseMarkdown("document", markdown, "Книга", normalOptions);
    expect(parsed.title).toBe("Назва документа");
    expect(parsed.sections.map((section) => section.title)).toEqual([
      "Назва документа",
      "Частина",
      "Розділ",
      "Розділ",
    ]);
    expect(parsed.sections.map((section) => section.anchor)).toEqual([
      "top",
      "частина",
      "розділ",
      "розділ-1",
    ]);
    expect(parsed.sections[2]!.parentId).toBe(parsed.sections[1]!.id);
    expect(parsed.sections[2]!.headingPath).toEqual(["Частина", "Розділ"]);
    expect(parsed.sections[1]!.endOffset).toBe(markdown.length);
    expect(parsed.sections[2]!.endOffset).toBe(
      markdown.indexOf("## Розділ", markdown.indexOf("## Розділ") + 1),
    );
    expect(parsed.chunks.map((chunk) => chunk.markdown).join("")).toBe(markdown);
    for (const chunk of parsed.chunks) {
      expect(chunk.markdown).toBe(markdown.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.startLine).toBe(markdown.slice(0, chunk.startOffset).split("\r\n").length);
      expect(chunk.endLine).toBe(markdown.slice(0, chunk.endOffset - 1).split("\r\n").length);
    }
    const sectionChunk = parsed.chunks.find((chunk) => chunk.headingPath.at(-1) === "Розділ")!;
    expect(sectionChunk.text).toContain("# Не розділ");
    expect(sectionChunk.embeddingText).toContain("Book: Книга\nSection: Частина > Розділ");
    expect(parsed.chunks[1]!.text).toContain("із виділенням");
    expect(parsed.chunks[0]!.text).not.toContain("title:");
  });

  it("splits oversized blocks without gaps, broken surrogate pairs, or unbounded overlap", () => {
    const markdown =
      "# Heading\r\n\r\n" +
      "Український текст 🧠 із деталями. ".repeat(100) +
      "\r\n\r\n```text\r\n" +
      "code🧠".repeat(300) +
      "\r\n```\r\n";
    const options = { targetTokens: 90, overlapTokens: 12 };
    const parsed = parseMarkdown("document", markdown, "Book", options);
    expect(parsed.chunks.length).toBeGreaterThan(20);
    expect(parsed.chunks.length).toBeLessThan(150);
    let coveredThrough = 0;
    for (const [index, chunk] of parsed.chunks.entries()) {
      expect(chunk.startOffset).toBeLessThanOrEqual(coveredThrough);
      expect(chunk.endOffset).toBeGreaterThan(coveredThrough);
      expect(chunk.markdown).toBe(markdown.slice(chunk.startOffset, chunk.endOffset));
      expect(Buffer.from(chunk.markdown, "utf8").toString("utf8")).toBe(chunk.markdown);
      expect(chunk.markdown.startsWith("\n")).toBe(false);
      expect(chunk.markdown.endsWith("\r")).toBe(false);
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(options.targetTokens);
      if (index > 0) {
        expect(
          Buffer.byteLength(markdown.slice(chunk.startOffset, coveredThrough), "utf8"),
        ).toBeLessThanOrEqual(options.overlapTokens * 3);
      }
      coveredThrough = chunk.endOffset;
    }
    expect(coveredThrough).toBe(markdown.length);
    expect(
      parsed.chunks
        .filter((chunk) => chunk.markdown.includes("code"))
        .every((chunk) => chunk.text.includes("code")),
    ).toBe(true);
    expect(parsed.chunks.map((chunk) => chunk.text).join(" ")).not.toContain("```");
  });

  it("keeps a stable chunk identity while embedding input tracks book/context changes", () => {
    const markdown = "# Chapter\n\nSome source text.\n";
    const first = parseMarkdown("document", markdown, "Title one", normalOptions);
    expect(parseMarkdown("document", markdown, "Title one", normalOptions)).toEqual(first);
    const renamed = parseMarkdown("document", markdown, "Title two", normalOptions);
    expect(renamed.chunks[0]!.id).toBe(first.chunks[0]!.id);
    expect(renamed.chunks[0]!.contentHash).toBe(first.chunks[0]!.contentHash);
    expect(renamed.chunks[0]!.inputHash).not.toBe(first.chunks[0]!.inputHash);
  });

  it("bounds oversized image labels and dense tables without duplicating full labels", () => {
    const markdown =
      `![${"alt-text ".repeat(150)}](images/example.png)\n\n` +
      "a|b|c|d\n-|-|-|-\n" +
      "1|2|3|4\n".repeat(100);
    const parsed = parseMarkdown("document", markdown, "Book", {
      targetTokens: 70,
      overlapTokens: 8,
    });
    for (const chunk of parsed.chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(70);
      expect(chunk.text).not.toContain("images/example.png");
    }
    expect(parsed.chunks.map((chunk) => chunk.text).join(" ")).toContain("alt-text");
  });

  it("handles heading-free text, empty input, and headings named top", () => {
    expect(parseMarkdown("document", "", "Book", normalOptions).chunks).toEqual([]);
    const prose = parseMarkdown("document", "Just prose.\n", "Book", normalOptions);
    expect(prose.chunks[0]!.markdown).toBe("Just prose.\n");
    expect(prose.chunks[0]!.headingPath).toEqual([]);
    expect(
      parseMarkdown("document", "# top\n\ntext", "Book", normalOptions).sections.map(
        (section) => section.anchor,
      ),
    ).toEqual(["top", "top-1"]);
    const rootHeading = parseMarkdown("document", "# root\n\ntext", "Book", normalOptions);
    expect(new Set(rootHeading.sections.map((section) => section.id)).size).toBe(2);
    const punctuationHeadings = parseMarkdown(
      "document",
      "# !!!\n\n# ???\n",
      "Book",
      normalOptions,
    );
    expect(punctuationHeadings.sections.map((section) => section.anchor)).toEqual([
      "top",
      "section",
      "section-1",
    ]);
  });

  it("rejects impossible context budgets and invalid options instead of truncating silently", () => {
    expect(() =>
      parseMarkdown("document", "# " + "Long heading ".repeat(30), "Book", {
        targetTokens: 20,
        overlapTokens: 0,
      }),
    ).toThrow(/context/);
    expect(() =>
      parseMarkdown("document", "Text", "Book", { targetTokens: 0, overlapTokens: 0 }),
    ).toThrow(/targetTokens/);
    expect(() =>
      parseMarkdown("document", "Text", "Book", { targetTokens: 50, overlapTokens: -1 }),
    ).toThrow(/overlapTokens/);
    expect(() =>
      parseMarkdown("document", "Text", "Book", { targetTokens: 50, overlapTokens: 50 }),
    ).toThrow(/overlapTokens/);
  });
});
