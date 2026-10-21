#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = ["lexical", "vector", "hybrid"];
const STRATEGIES = ["score", "blend"];
const SCHEMA_VERSION = 1;
const LIMITATIONS = [
  "Historical expected sections are target-section labels, not exhaustive per-chunk relevance judgments. A section hit is a proxy for relevance, not an answer-quality judgment.",
  "Section matching uses the most specific numbered heading and exact normalized codes: 3.1 and 3.1.1 are distinct. A relevant chunk from an unlabelled section may count as a miss.",
  "Both ranking strategies reuse the same complete scored candidate pool for each query and retrieval mode. No additional model call is made for blending or replay.",
  "No-answer aggregates describe the distribution of one maximum reranker score per successful query, not a pooled distribution of chunk scores. Scores are not calibrated answerability probabilities; these labels alone do not establish a cutoff.",
  "Runs with search warnings, failed requests, no candidates, or missing scores are excluded from metrics and reported separately. Hit-rate denominators contain only successful runs.",
];

class EvaluationError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new EvaluationError(message);
}

function parseArguments(argv) {
  const options = { mode: "all" };
  const flags = new Set(["queries", "output", "config", "book", "mode", "replay"]);
  const supplied = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") return { help: true };
    const key = argv[i].slice(2);
    requireCondition(argv[i].startsWith("--") && flags.has(key), "Unknown command-line option. Use --help.");
    requireCondition(!supplied.has(key), "A command-line option was repeated.");
    const value = argv[++i];
    requireCondition(typeof value === "string" && value.trim() && !value.startsWith("--"), "An option is missing its value.");
    supplied.add(key);
    options[key] = value;
  }
  requireCondition(options.output, "Specify --output for the JSON report.");
  requireCondition(options.mode === "all" || MODES.includes(options.mode), "Mode must be lexical, vector, hybrid, or all.");
  if (options.replay) {
    requireCondition(!options.config && !options.book && !options.queries, "Replay does not accept --config, --book, or --queries.");
    requireCondition(resolve(options.replay) !== resolve(options.output), "Use a different output path to preserve the saved replay source.");
  } else {
    requireCondition(options.queries, "Specify --queries for the query-set JSON file.");
  }
  return options;
}

function usage() {
  return `Compare pure rerank scores and position-aware blending on one scored pool.

Live evaluation (uses already configured process environment; never loads .env):
  node scripts/evaluate-reranking.mjs --queries evaluations/rerank-queries.json --output evaluations/rerank-results.json [--config path] [--book ID] [--mode lexical|vector|hybrid|all]

Offline replay (no configuration loading or network requests):
  node scripts/evaluate-reranking.mjs --replay evaluations/rerank-results.json --output evaluations/rerank-replayed.json [--mode lexical|vector|hybrid|all]

Build the library first. Live vector/hybrid runs require configured embeddings.
Every live query/mode is searched once with the full configured rerank candidate limit.
Warning/failure rows are saved but excluded from metrics. Partial reports are saved after every run.`;
}

async function readJson(path, message) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new EvaluationError(message);
  }
}

function sectionCode(value) {
  return value.replace(/\.$/, "");
}

/** Only the deepest numbered heading labels the chunk; parent labels do not match children. */
export function candidateSection(headingPath) {
  for (let i = headingPath.length - 1; i >= 0; i--) {
    const match = /^\s*(\d+(?:\.\d+)*)(?:\.)?(?=\s|$)/u.exec(headingPath[i]);
    if (match) return match[1];
  }
  return null;
}

function validateCorpus(value) {
  requireCondition(value && typeof value === "object" && Array.isArray(value.cases) && value.cases.length > 0,
    "The query set must contain a non-empty cases array.");
  const ids = new Set();
  const cases = value.cases.map((entry) => {
    requireCondition(entry && typeof entry === "object" && typeof entry.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(entry.id) && !ids.has(entry.id),
      "Query IDs must be unique, short letters/numbers/underscores/hyphens.");
    requireCondition(typeof entry.query === "string" && entry.query.trim() && entry.query.length <= 8192 && typeof entry.answerable === "boolean",
      "Every query must have non-empty text and a boolean answerable label.");
    requireCondition(Array.isArray(entry.expectedSections) && entry.expectedSections.every((section) => typeof section === "string" && /^\d+(?:\.\d+)*\.?$/.test(section)) && (entry.answerable ? entry.expectedSections.length > 0 : entry.expectedSections.length === 0),
      "Answerable queries need numeric expected section codes; no-answer queries need an empty label list.");
    ids.add(entry.id);
    return { id: entry.id, query: entry.query, answerable: entry.answerable, expectedSections: [...entry.expectedSections] };
  });
  return { source: value.source ?? null, cases };
}

/** Quantiles use linear interpolation at (n - 1) * p; values remain available for plots. */
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (fraction) => {
    if (sorted.length === 0) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
  };
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median: quantile(0.5),
    p90: quantile(0.9),
    values: [...values],
  };
}

function candidateSnapshots(results) {
  requireCondition(Array.isArray(results) && results.length > 0, "Candidate scores are unavailable.");
  const ordered = [...results].sort((a, b) => a.retrievalRank - b.retrievalRank);
  const ids = new Set();
  return ordered.map((result, index) => {
    requireCondition(result && typeof result.id === "string" && result.id && !ids.has(result.id) && result.retrievalRank === index + 1 && Number.isFinite(result.rrfScore) && Number.isFinite(result.rerankScore) && result.rerankScore >= 0 && result.rerankScore <= 1,
      "Candidate scores or retrieval ranks are missing or invalid.");
    requireCondition(Array.isArray(result.headingPath) && result.headingPath.every((heading) => typeof heading === "string") && typeof result.relativePath === "string" && Number.isInteger(result.startLine) && result.startLine > 0 && Number.isInteger(result.endLine) && result.endLine >= result.startLine,
      "Candidate source references are missing or invalid.");
    ids.add(result.id);
    return {
      id: result.id,
      bookId: result.bookId,
      sectionId: result.sectionId,
      section: candidateSection(result.headingPath),
      headingPath: [...result.headingPath],
      relativePath: result.relativePath,
      startLine: result.startLine,
      endLine: result.endLine,
      anchor: result.anchor,
      matches: Array.isArray(result.matches) ? [...result.matches] : [],
      retrievalRank: result.retrievalRank,
      rrfScore: result.rrfScore,
      rerankScore: result.rerankScore,
    };
  });
}

function scoredRun(entry, mode, snapshots, rankRerankedResults) {
  const candidates = candidateSnapshots(snapshots);
  const original = candidates.map(({ retrievalRank: _rank, rrfScore, rerankScore: _rerank, ...candidate }) => ({ ...candidate, score: rrfScore }));
  const scores = candidates.map((candidate, index) => ({ index, score: candidate.rerankScore }));
  const expected = new Set(entry.expectedSections.map(sectionCode));
  const rankings = {};
  const hits = {};
  for (const strategy of STRATEGIES) {
    const ranked = rankRerankedResults(original, scores, strategy);
    rankings[strategy] = ranked.map((candidate, index) => ({
      rank: index + 1,
      id: candidate.id,
      section: candidate.section,
      score: candidate.score,
      rrfScore: candidate.rrfScore,
      rerankScore: candidate.rerankScore,
      retrievalRank: candidate.retrievalRank,
    }));
    hits[strategy] = entry.answerable ? {
      top1: rankings[strategy].slice(0, 1).some((candidate) => expected.has(candidate.section)),
      top3: rankings[strategy].slice(0, 3).some((candidate) => expected.has(candidate.section)),
    } : null;
  }
  return {
    caseId: entry.id,
    mode,
    status: "success",
    candidateCount: candidates.length,
    candidates,
    rankings,
    hits,
    rerankScoreDistribution: distribution(candidates.map((candidate) => candidate.rerankScore)),
  };
}

function failedRun(entry, mode, code, warningCount = 0) {
  const messages = {
    search_failed: "Search failed. No provider error body or query text is logged.",
    search_warnings: "Search returned warnings; possible fallback or incomplete retrieval is excluded.",
    no_candidates: "Search returned no candidates, so reranker scores are unavailable.",
    invalid_scores: "Candidate scores, retrieval ranks, or source references are missing or invalid.",
    missing_saved_run: "The saved report has no completed run for this query and mode.",
  };
  return {
    caseId: entry.id,
    mode,
    status: code === "search_failed" ? "failed" : "excluded",
    failure: { code, message: messages[code], ...(warningCount ? { warningCount } : {}) },
  };
}

function summarize(report) {
  return Object.fromEntries(report.metadata.modes.map((mode) => {
    const rows = report.runs.filter((run) => run.mode === mode);
    const byId = new Map(rows.map((run) => [run.caseId, run]));
    const group = (answerable) => {
      const cohort = report.cases.filter((entry) => entry.answerable === answerable);
      const successes = cohort.map((entry) => byId.get(entry.id)).filter((run) => run?.status === "success");
      const maxima = successes.map((run) => ({ caseId: run.caseId, max: run.rerankScoreDistribution.max }));
      return {
        total: cohort.length,
        evaluated: successes.length,
        excluded: cohort.length - successes.length,
        queryMaxima: { ...distribution(maxima.map((entry) => entry.max)), perQuery: maxima },
        ...(answerable ? { strategies: Object.fromEntries(STRATEGIES.map((strategy) => {
          const top1Hits = successes.filter((run) => run.hits[strategy].top1).length;
          const top3Hits = successes.filter((run) => run.hits[strategy].top3).length;
          return [strategy, {
            top1Hits,
            top3Hits,
            denominator: successes.length,
            top1Rate: successes.length ? top1Hits / successes.length : null,
            top3Rate: successes.length ? top3Hits / successes.length : null,
          }];
        })) } : {}),
      };
    };
    return [mode, {
      planned: report.cases.length,
      completed: rows.length,
      successful: rows.filter((run) => run.status === "success").length,
      failed: rows.filter((run) => run.status === "failed").length,
      excluded: rows.filter((run) => run.status === "excluded").length,
      answerable: group(true),
      noAnswer: group(false),
    }];
  }));
}

async function saveReport(path, report) {
  report.summary = summarize(report);
  const output = resolve(path);
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporary, output);
  } catch {
    throw new EvaluationError("Unable to save the evaluation report. Check the output path and permissions.");
  }
}

function initialReport(corpus, metadata) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: corpus.source,
    limitations: [...LIMITATIONS],
    quantileMethod: "Linear interpolation at (n - 1) * p over ascending values.",
    metadata,
    cases: corpus.cases,
    runs: [],
    summary: {},
  };
}

async function replay(options, api, log) {
  const saved = await readJson(options.replay, "Unable to read the saved evaluation JSON.");
  requireCondition(saved?.schemaVersion === SCHEMA_VERSION && Array.isArray(saved.runs) && Array.isArray(saved.metadata?.modes), "Unsupported or malformed replay report.");
  const corpus = validateCorpus(saved);
  const modes = options.mode === "all" ? saved.metadata.modes : [options.mode];
  requireCondition(modes.length > 0 && new Set(modes).size === modes.length && modes.every((mode) => MODES.includes(mode) && saved.metadata.modes.includes(mode)), "The requested modes are not available in the saved report.");
  const report = initialReport(corpus, {
    kind: "replay",
    replayedFrom: resolve(options.replay),
    originalGeneratedAt: saved.generatedAt,
    rerankModel: saved.metadata.rerankModel ?? null,
    embeddingModel: saved.metadata.embeddingModel ?? null,
    candidateLimit: saved.metadata.candidateLimit ?? null,
    bookId: saved.metadata.bookId ?? null,
    modes,
  });
  const savedRuns = new Map();
  for (const row of saved.runs) {
    requireCondition(row && corpus.cases.some((entry) => entry.id === row.caseId) && MODES.includes(row.mode), "The saved report contains an invalid query or mode reference.");
    const key = `${row.caseId}:${row.mode}`;
    requireCondition(!savedRuns.has(key), "The saved report contains duplicate query/mode runs.");
    savedRuns.set(key, row);
  }
  for (const entry of corpus.cases) {
    for (const mode of modes) {
      const row = savedRuns.get(`${entry.id}:${mode}`);
      if (!row) {
        report.runs.push(failedRun(entry, mode, "missing_saved_run"));
      } else if (row.status !== "success") {
        const code = ["search_failed", "search_warnings", "no_candidates", "invalid_scores", "missing_saved_run"].includes(row.failure?.code) ? row.failure.code : "invalid_scores";
        report.runs.push(failedRun(entry, mode, code, row.failure?.warningCount));
      } else {
        try {
          report.runs.push(scoredRun(entry, mode, row.candidates, api.rankRerankedResults));
        } catch {
          report.runs.push(failedRun(entry, mode, "invalid_scores"));
        }
      }
    }
  }
  report.completedAt = new Date().toISOString();
  await saveReport(options.output, report);
  log(`Replayed ${report.runs.length} saved query/mode runs without loading configuration or calling models.`);
  return report;
}

/** Injectable dependencies let the harness be verified without credentials or live model calls. */
export async function runEvaluation(argv = process.argv.slice(2), dependencies) {
  const options = parseArguments(argv);
  const log = dependencies?.log ?? console.error;
  if (options.help) {
    log(usage());
    return null;
  }
  const api = dependencies ?? await import("../dist/index.mjs");
  requireCondition(typeof api.rankRerankedResults === "function", "Build the library with rankRerankedResults exported before running this script.");
  if (options.replay) return replay(options, api, log);

  const corpus = validateCorpus(await readJson(options.queries, "Unable to read the query-set JSON."));
  let config;
  try {
    // loadConfig reads the existing process environment. This script never loads .env.
    config = await api.loadConfig(options.config);
  } catch {
    throw new EvaluationError("Unable to load a valid configuration. Check the config and required process environment variables.");
  }
  const modes = options.mode === "all" ? [...MODES] : [options.mode];
  requireCondition(config.rerank, "A reranker must be configured before evaluation.");
  requireCondition(!modes.some((mode) => mode !== "lexical") || config.embedding, "Vector and hybrid evaluation require configured embeddings; fallback is not an evaluation.");
  const report = initialReport(corpus, {
    kind: "live",
    rerankModel: config.rerank.model,
    embeddingModel: config.embedding?.model ?? null,
    candidateLimit: config.rerank.candidateLimit,
    bookId: options.book ?? null,
    modes,
  });
  await saveReport(options.output, report);
  const library = new api.BookLibrary(config);
  try {
    for (const entry of corpus.cases) {
      for (const mode of modes) {
        log(`Evaluating ${entry.id} [${mode}]`);
        let row;
        try {
          const response = await library.search(entry.query, {
            mode,
            limit: config.rerank.candidateLimit,
            rerank: true,
            rerankStrategy: "score",
            ...(options.book ? { bookId: options.book } : {}),
          });
          if (!Array.isArray(response.warnings) || response.warnings.length > 0) {
            row = failedRun(entry, mode, "search_warnings", Array.isArray(response.warnings) ? response.warnings.length : 1);
          } else if (Array.isArray(response.results) && response.results.length === 0) {
            row = failedRun(entry, mode, "no_candidates");
          } else {
            try {
              row = scoredRun(entry, mode, response.results, api.rankRerankedResults);
            } catch {
              row = failedRun(entry, mode, "invalid_scores");
            }
          }
        } catch {
          row = failedRun(entry, mode, "search_failed");
        }
        report.runs.push(row);
        if (row.status !== "success") log(`Excluded ${entry.id} [${mode}]: ${row.failure.code}`);
        await saveReport(options.output, report);
      }
    }
  } finally {
    library.close();
  }
  report.completedAt = new Date().toISOString();
  await saveReport(options.output, report);
  log(`Saved ${report.runs.length} query/mode runs; warning and failure rows are excluded from metrics.`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runEvaluation();
  } catch (error) {
    console.error(error instanceof EvaluationError ? error.message : "Evaluation failed. Check the library build, local index, and output path; provider details were not logged.");
    process.exitCode = 1;
  }
}
