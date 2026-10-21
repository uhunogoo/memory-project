import { parseArgs } from "node:util";
import { z } from "zod";
import { searchModeSchema } from "./storage/search.js";

const commandSchema = z.enum([
  "init",
  "index",
  "embed",
  "status",
  "books",
  "sections",
  "chunks",
  "get",
  "document",
  "search",
]);

export function parseCliArguments(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      mode: { type: "string" },
      limit: { type: "string" },
      book: { type: "string" },
      json: { type: "boolean" },
      "no-embed": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [rawCommand, ...args] = positionals;
  if (values.help || !rawCommand) return undefined;
  const command = commandSchema.safeParse(rawCommand);
  if (!command.success) throw new Error(`Unknown command: ${rawCommand}. Use --help.`);
  const takesArgument = ["get", "document", "search"].includes(command.data);
  if ((takesArgument && args.length !== 1) || (!takesArgument && args.length !== 0))
    throw new Error(`Invalid arguments for ${command.data}. Use --help; quote the search query.`);
  const mode = searchModeSchema.optional().safeParse(values.mode);
  if (!mode.success) throw new Error("--mode must be lexical, vector or hybrid.");
  return { command: command.data, args, values: { ...values, mode: mode.data } };
}
