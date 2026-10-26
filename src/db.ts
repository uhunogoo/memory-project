import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schemas/schema.js";

mkdirSync(".data", { recursive: true });

const sqlite = new Database("./.data/memory.sqlite");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
