import assert from "node:assert/strict";
import test from "node:test";
import { estimatePiUsage } from "../src/pi/usage.js";
import { PruneScheduler } from "../src/scheduler.js";
import { result, user } from "./helpers.js";

test("Pi pressure counts restored original messages even when previous provider usage was small", () => {
  const usage = estimatePiUsage([user("Continue"), result("old", "x".repeat(28_000))], "", [], 10_000,
    { tokens: 1000, contextWindow: 10_000, percent: 10 });
  assert.equal(usage.source, "estimated");
  assert.ok(usage.usedTokens! >= 7000);
});

test("Pi pressure includes system and tool overhead before the first provider response", () => {
  const usage = estimatePiUsage([user("Hi")], "x".repeat(12_000), [{ description: "x".repeat(16_000) }], 10_000);
  assert.equal(usage.source, "estimated");
  assert.ok(usage.usedTokens! >= 7000);
  assert.equal(estimatePiUsage([], "", [], undefined).source, "unknown");
});

test("a fresh snapshot can be estimated after compaction without using stale provider counts", () => {
  const usage = estimatePiUsage([user("New context")], "", [], 10_000,
    { tokens: null, contextWindow: 10_000, percent: null });
  assert.equal(usage.source, "estimated");
  assert.ok(usage.usedTokens! < 100);
});

test("scheduler permits fresh assessment near capacity but rejects invalid capacity", () => {
  const scheduler = new PruneScheduler();
  const input = { enabled: true, ready: true, usage: { capacityTokens: 1000, usedTokens: 700, source: "current" as const },
    pressureThreshold: 0.6, eligible: 2, eligibleBytes: 2000, minContextBytes: 0, cycleKey: "task", contentKey: "old" };
  scheduler.record("task", "old", { code: "success", eligible: 2, assessed: 2, dropped: 1, skipped: 0, requests: 1 });
  assert.equal(scheduler.decide({ ...input, contentKey: "new", usage: { ...input.usage, usedTokens: 950 } }), undefined);
  assert.equal(scheduler.decide({ ...input, usage: { ...input.usage, capacityTokens: Infinity } })?.code, "usage-unknown");
});
