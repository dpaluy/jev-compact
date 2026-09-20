import { readFile } from "node:fs/promises";
import { replayFixtures } from "./replay-fixtures.js";
import { parseReplaySnapshots, replaySnapshots } from "./replay.js";

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg.startsWith("--"))) throw new Error("Usage: npm run eval:replay -- [snapshots.json] (offline only)");
const datasets = args[0]
  ? [{ id: "supplied-snapshots", snapshots: parseReplaySnapshots(JSON.parse(await readFile(args[0], "utf8"))) }]
  : replayFixtures();
const results = [];
for (const dataset of datasets) results.push({ dataset: dataset.id, ...await replaySnapshots(dataset.snapshots) });
console.log(JSON.stringify({ source: args[0] ? "supplied-context-snapshots" : "synthetic-workloads", results }, null, 2));
