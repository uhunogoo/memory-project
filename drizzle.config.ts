import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schemas/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./.data/memory.sqlite",
  },
});
