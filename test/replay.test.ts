import assert from "node:assert/strict";
import test from "node:test";
import { parseReplaySnapshots, replaySnapshots, type ReplaySnapshot } from "../eval/replay.js";
import { replayFixtures } from "../eval/replay-fixtures.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { assistant, conversation, user } from "./helpers.js";

const config = { ...DEFAULT_CONFIG, enabled: true, preserveRecentMessages: 0, pressureThreshold: 0.1 };
function snapshot(): ReplaySnapshot {
  const messages = conversation();
  const result = messages.find(message => message.role === "toolResult")!;
  if (result.role === "toolResult") result.content = [{ type: "text", text: "x".repeat(5000) }];
  return { id: "fixture", cwd: "/offline", systemPrompt: "rules", contextWindow: 10_000, messages };
}

test("replay measures actual successive projections, including restored context on cadence deferral", async () => {
  const first = snapshot();
  const changed = { ...first, id: "changed", messages: [...first.messages, assistant([{ type: "text", text: "Working on the same task." }])] };
  const next = { ...changed, id: "next", messages: [...changed.messages, user("New task.")] };
  const inputs = [first, structuredClone(first), changed, next];
  const original = structuredClone(inputs);
  const report = await replaySnapshots(inputs, config);
  assert.equal(report.requests, 2);
  assert.equal(report.rows[0]!.assessed, 1);
  assert.ok(report.rows[0]!.afterBytes < report.rows[0]!.beforeBytes);
  assert.equal(report.rows[1]!.reusedProjection, true);
  assert.equal(report.rows[1]!.requests, 0);
  assert.equal(report.rows[1]!.newlyAssessed, 0);
  assert.equal(report.rows[2]!.outcome, "host-deferred");
  assert.equal(report.rows[2]!.afterBytes, report.rows[2]!.beforeBytes);
  assert.equal(report.rows[2]!.prefixRewritten, true);
  assert.ok(report.rows[3]!.afterBytes < report.rows[3]!.beforeBytes);
  assert.equal(report.totalSessionCostUsd, null);
  assert.equal(report.cacheReadTokens, null);
  assert.deepEqual(inputs, original);
});

test("structured system messages remain in scorer history instead of understating its size", async () => {
  const base = snapshot();
  const prompt = "project rules ".repeat(1300);
  const input = parseReplaySnapshots([{ ...base, systemPrompt: prompt,
    messages: [{ role: "system", content: prompt, timestamp: 0 }, ...base.messages] }])[0]!;
  const report = await replaySnapshots([input], config);
  assert.equal(report.requests, 0);
  assert.equal(report.rows[0]!.skipReasons["context-too-large"], 1);
  assert.equal(report.rows[0]!.afterBytes, report.rows[0]!.beforeBytes);
  assert.ok(report.rows[0]!.scorerEnvelopeBytes > 2 * prompt.length);
  assert.ok(!JSON.stringify(report).includes("project rules"));
});

test("a recorded model change cannot reuse the previous outgoing projection", async () => {
  const first = { ...snapshot(), model: { provider: "fixture", id: "first" } };
  const second = { ...first, model: { provider: "fixture", id: "second" } };
  const report = await replaySnapshots([first, second], config);
  assert.ok(report.rows[0]!.afterBytes < report.rows[0]!.beforeBytes);
  assert.equal(report.rows[1]!.reusedProjection, false);
  assert.equal(report.rows[1]!.prefixRewritten, true);
});

test("protected context over the request envelope assesses nothing", async () => {
  const input = { ...snapshot(), systemPrompt: "rules".repeat(6000) };
  const report = await replaySnapshots([input], config);
  const row = report.rows[0]!;
  assert.equal(report.requests, 0);
  assert.equal(row.assessed, 0);
  assert.equal(row.skipped, 1);
  assert.equal(row.skipReasons["context-too-large"], 1);
  assert.equal(row.afterBytes, row.beforeBytes);
  assert.ok(row.scorerEnvelopeBytes > config.maxRequestBytes);
});

test("oversized outputs stay intact and count as unassessed", async () => {
  const input = snapshot();
  const result = input.messages.find(message => message.role === "toolResult")!;
  if (result.role === "toolResult") result.content = [{ type: "text", text: "x".repeat(30_000) }];
  const row = (await replaySnapshots([input], config)).rows[0]!;
  assert.equal(row.skipped, 1);
  assert.equal(row.skipReasons["candidate-too-large"], 1);
  assert.equal(row.afterBytes, row.beforeBytes);
  assert.equal(row.requests, 0);
});

test("recorded host compaction replaces the input history rather than accumulating a text floor", async () => {
  const first = snapshot();
  const compacted: ReplaySnapshot = { ...first, id: "compacted", messages: [
    { role: "compactionSummary", summary: "Recorded host summary.", tokensBefore: 1200, timestamp: 4 }, user("Continue.")],
  };
  const report = await replaySnapshots([first, compacted], config);
  assert.equal(report.rows[1]!.eligible, 0);
  assert.equal(report.rows[1]!.beforeBytes, Buffer.byteLength(JSON.stringify(compacted.messages)));
  assert.ok(report.rows[1]!.afterBytes < report.rows[0]!.beforeBytes);
});

test("replay rejects invalid envelopes rather than silently changing the benchmark", () => {
  assert.throws(() => parseReplaySnapshots([]));
  assert.throws(() => parseReplaySnapshots([{ ...snapshot(), contextWindow: 0 }]));
  assert.throws(() => parseReplaySnapshots([{ ...snapshot(), systemPrompt: undefined }]));
  assert.throws(() => parseReplaySnapshots([{ ...snapshot(), messages: [{ role: "unsupported" }] }]));
  assert.throws(() => parseReplaySnapshots([{ ...snapshot(), tools: [{}] }]));
  assert.equal(parseReplaySnapshots([snapshot()]).length, 1);
});

test("long workload fixtures expose context and candidate size limits using default settings", async () => {
  const datasets = replayFixtures();
  const reports = new Map(await Promise.all(datasets.map(async dataset => [dataset.id, await replaySnapshots(dataset.snapshots)] as const)));
  assert.ok(reports.get("tool-heavy")!.rows.some(row => row.assessed > 0 && row.afterBytes < row.beforeBytes));
  assert.ok(reports.get("text-heavy")!.rows.some(row => row.skipReasons["context-too-large"]));
  assert.ok(reports.get("oversized-results")!.rows.some(row => row.skipReasons["candidate-too-large"]));
});
