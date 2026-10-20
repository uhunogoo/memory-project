import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { DiscoveredBook, DiscoveryResult } from "../types.js";
import { bookManifestSchema } from "./schemas.js";
import type { BookManifest } from "./schemas.js";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });

/** Natural order with an exact tie-breaker, independent of directory enumeration. */
function comparePaths(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function isMarkdown(file: string): boolean {
  return /\.md$/i.test(file);
}

function validateRelativePath(file: string, manifestPath: string): void {
  if (
    !file ||
    file.includes("\\") ||
    file.includes("\0") ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..") ||
    !isMarkdown(file)
  ) {
    throw new Error(
      `${manifestPath}: files must contain relative Markdown paths using /, without traversal.`,
    );
  }
}

function parseManifest(source: string, manifestPath: string): BookManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${manifestPath}: invalid JSON.`, { cause: error });
  }
  const validation = bookManifestSchema.safeParse(value);
  if (!validation.success) {
    throw new Error(
      `${manifestPath}: invalid book.json structure; expected title/author/language strings and a files array of strings, with no unknown properties.`,
    );
  }
  const record = validation.data;
  const manifest: BookManifest = {};
  for (const key of ["title", "author", "language"] as const) {
    const field = record[key];
    if (field !== undefined) {
      if (!field.trim()) {
        throw new Error(`${manifestPath}: ${key} must be a non-empty string.`);
      }
      manifest[key] = field.trim();
    }
  }
  if (record.files !== undefined) {
    const seen = new Set<string>();
    manifest.files = record.files.map((file) => {
      validateRelativePath(file, manifestPath);
      if (seen.has(file)) throw new Error(`${manifestPath}: duplicate file "${file}".`);
      seen.add(file);
      return file;
    });
  }
  return manifest;
}

async function readRegularFile(filename: string): Promise<string> {
  const stat = await lstat(filename);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${filename}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${filename}`);
  return readFile(filename, "utf8");
}

async function collectMarkdown(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => comparePaths(a.name, b.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not supported: ${absolutePath}`);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdown(absolutePath, relativePath)));
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      files.push(relativePath);
    }
  }
  return files.sort(comparePaths);
}

/** A first-level directory is one book; its files are always relative to that directory. */
export async function discoverBooks(booksDir: string): Promise<DiscoveryResult> {
  const root = path.resolve(booksDir);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Books directory must be a real directory, not a symbolic link: ${root}`);
  }
  const result: DiscoveryResult = { books: [], warnings: [] };
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => comparePaths(a.name, b.name));
  for (const entry of entries) {
    const directoryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not supported: ${directoryPath}`);
    if (!entry.isDirectory()) {
      if (entry.isFile() && isMarkdown(entry.name)) {
        result.warnings.push(
          `Ignored ${entry.name}: place Markdown files inside a book directory under books/.`,
        );
      }
      continue;
    }
    const availableFiles = await collectMarkdown(directoryPath);
    const manifestPath = path.join(directoryPath, "book.json");
    let manifest: BookManifest = {};
    try {
      manifest = parseManifest(await readRegularFile(manifestPath), manifestPath);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    const orderedFiles = manifest.files ?? availableFiles;
    const available = new Set(availableFiles);
    const book: DiscoveredBook = {
      id: createHash("sha256").update(`book\0${entry.name}`).digest("hex"),
      directory: entry.name,
      title: manifest.title ?? entry.name,
      ...(manifest.author === undefined ? {} : { author: manifest.author }),
      ...(manifest.language === undefined ? {} : { language: manifest.language }),
      files: [],
    };
    for (const [order, relativePath] of orderedFiles.entries()) {
      if (!available.has(relativePath)) {
        throw new Error(
          `${manifestPath}: Markdown file "${relativePath}" does not exist in this book.`,
        );
      }
      book.files.push({
        relativePath,
        markdown: await readRegularFile(path.join(directoryPath, ...relativePath.split("/"))),
        order,
      });
    }
    result.books.push(book);
  }
  return result;
}
