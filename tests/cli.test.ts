import { describe, expect, it } from "vite-plus/test";
import { parseCliArguments } from "../src/cli-args.js";

describe("CLI argument parsing", () => {
  it.each(["lexical", "vector", "hybrid"])("accepts the %s search mode", (mode) => {
    expect(
      parseCliArguments([
        "search",
        "Пошуковий запит",
        `--mode=${mode}`,
        "--limit=3",
        "--book=book-id",
        "--json",
      ]),
    ).toMatchObject({
      command: "search",
      args: ["Пошуковий запит"],
      values: { mode, limit: "3", book: "book-id", json: true },
    });
  });

  it.each(["", "invalid", "private-mode-input"])("rejects an invalid --mode=%s", (mode) => {
    const parse = () => parseCliArguments(["search", "query", `--mode=${mode}`]);
    expect(parse).toThrow("--mode must be lexical, vector or hybrid.");
    expect(parse).not.toThrow("private-mode-input");
  });

  it("leaves omitted options for application defaults", () => {
    expect(parseCliArguments(["search", "query"])).toEqual({
      command: "search",
      args: ["query"],
      values: { mode: undefined, rerankStrategy: undefined },
    });
  });

  it("supports bypassing reranking for a single search", () => {
    expect(parseCliArguments(["search", "query", "--no-rerank"])?.values["no-rerank"]).toBe(true);
  });

  it.each(["score", "blend"])("accepts the %s rerank strategy", (rerankStrategy) => {
    expect(
      parseCliArguments(["search", "query", "--rerank-strategy", rerankStrategy]),
    ).toMatchObject({
      command: "search",
      args: ["query"],
      values: { rerankStrategy },
    });
  });

  it.each(["", "SCORE", "private-strategy-input"])(
    "rejects invalid rerank strategies without exposing their values %#",
    (rerankStrategy) => {
      const parse = () =>
        parseCliArguments(["search", "query", `--rerank-strategy=${rerankStrategy}`]);
      expect(parse).toThrow("--rerank-strategy must be score or blend.");
      expect(parse).not.toThrow("private-strategy-input");
    },
  );

  it.each(["score", "blend"])(
    "rejects --no-rerank combined with the %s strategy",
    (rerankStrategy) => {
      expect(() =>
        parseCliArguments([
          "search",
          "query",
          "--no-rerank",
          `--rerank-strategy=${rerankStrategy}`,
        ]),
      ).toThrow("--no-rerank cannot be combined with --rerank-strategy.");
    },
  );

  it("delegates flag types and unknown flags to node parseArgs", () => {
    expect(() => parseCliArguments(["search", "query", "--mode"])).toThrow();
    expect(() => parseCliArguments(["search", "query", "--rerank-strategy"])).toThrow();
    expect(() => parseCliArguments(["search", "query", "--json=true"])).toThrow();
    expect(() => parseCliArguments(["search", "query", "--unknown"])).toThrow();
  });

  it("keeps command arity separate from structural enum parsing", () => {
    expect(() => parseCliArguments(["unknown"])).toThrow("Unknown command: unknown.");
    expect(() => parseCliArguments(["search"])).toThrow("Invalid arguments for search.");
    expect(() => parseCliArguments(["search", "two", "arguments"])).toThrow(
      "Invalid arguments for search.",
    );
    expect(() => parseCliArguments(["status", "extra"])).toThrow("Invalid arguments for status.");
  });

  it("shows help without requiring a command or validating command-specific values", () => {
    expect(parseCliArguments([])).toBeUndefined();
    expect(parseCliArguments(["--help"])).toBeUndefined();
    expect(parseCliArguments(["unknown", "--mode=", "--help"])).toBeUndefined();
    expect(parseCliArguments(["search", "--rerank-strategy=", "--help"])).toBeUndefined();
  });
});
