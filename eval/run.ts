import { createJevScorer, DEFAULT_MODEL, JEV_ENDPOINT } from "../src/jev.js";
import { fakeScorer } from "../test/helpers.js";
import { fixtures } from "./fixtures.js";
import { evaluate } from "./evaluate.js";
import { evaluateScheduleCoverage } from "./coverage.js";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--live")) throw new Error("Usage: npm run eval -- [--live]");
const live = args.includes("--live");
if (live && !process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Live evaluation requires TYPESAFE_API_KEY");
const dataset = fixtures();
const required = new Set(dataset.map(f => `tool:${f.requiredTraceId}`));
const scorer = live
  ? createJevScorer({ apiKey: process.env.TYPESAFE_API_KEY!, maxRequests: 8, timeoutMs: 60_000 })
  : fakeScorer(item => required.has(item.id) ? { keep: 0.99, constraint: 0.99 } : { keep: 0.01, constraint: 0.01 });
console.log(live
  ? `Live scoring: ${JEV_ENDPOINT}, model ${DEFAULT_MODEL}. Sends only synthetic fixture text.`
  : "Offline contract evaluation with fixture-label scores. This does NOT measure Jev accuracy.");
const results: Awaited<ReturnType<typeof evaluate>>[] = [];
for (const fixture of dataset) results.push(await evaluate(fixture, scorer));
const sum = (key: "retained" | "constraints" | "beforeBytes" | "afterBytes" | "toolConstraintsRetained" | "toolConstraints") =>
  results.reduce((total, row) => total + row[key], 0);
const scheduleCoverage = await evaluateScheduleCoverage();
const report = {
  mode: live ? "live-model" : "offline-contract", fixtures: results.length,
  retention: `${sum("retained")}/${sum("constraints")}`,
  toolRetention: `${sum("toolConstraintsRetained")}/${sum("toolConstraints")}`,
  byteReduction: 1 - sum("afterBytes") / sum("beforeBytes"),
  tokenSavings: "not measured; bytes are not billed tokens", scheduleCoverage, results,
};
console.log(JSON.stringify(report, null, 2));
if (!scheduleCoverage.passed || results.some(row => row.retained !== row.constraints || row.droppedTraces === 0 || row.failure || row.unscored)) process.exitCode = 1;
