import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

type DiscoveredBook = {
  name: string;
  directory: string;
  files: string[];
};

const collator = new Intl.Collator(undefined, { numeric: true });

function comparePaths(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

async function collectMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => comparePaths(a.name, b.name));

  const files: string[] = [];

  for (const entry of entries) {
    const filePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectMarkdown(filePath));
    } else if (
      entry.isFile() &&
      extname(entry.name).toLowerCase() === ".md"
    ) {
      files.push(filePath);
    }
  }

  return files;
}

export async function discoverBooks(
  booksDirectory = "books",
): Promise<DiscoveredBook[]> {
  const root = resolve(booksDirectory);
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => comparePaths(a.name, b.name));

  const books: DiscoveredBook[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = join(root, entry.name);
    const files = await collectMarkdown(directory);

    if (files.length === 0) continue;

    books.push({
      name: entry.name,
      directory,
      files,
    });
  }

  return books;
}
