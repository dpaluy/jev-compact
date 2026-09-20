import assert from "node:assert/strict";
import test from "node:test";
import { PruneScheduler, type ScheduleInput } from "../src/scheduler.js";

const input = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  enabled: true,
  ready: true,
  usage: { capacityTokens: 100_000, usedTokens: 70_000, source: "current" as const },
  pressureThreshold: 0.6,
  eligible: 3,
  eligibleBytes: 12_000,
  minContextBytes: 0,
  cycleKey: "task-a",
  contentKey: "content-a",
  ...overrides,
});

test("automatic scheduling does no remote work below pressure or for unknown/stale usage", () => {
  const scheduler = new PruneScheduler();
  assert.equal(scheduler.decide(input({ usage: { capacityTokens: 100_000, usedTokens: 59_999, source: "current" } }))?.code, "waiting-pressure");
  assert.equal(scheduler.decide(input({ usage: { capacityTokens: 100_000, usedTokens: null, source: "unknown" } }))?.code, "usage-unknown");
  assert.equal(scheduler.decide(input({ usage: { capacityTokens: 100_000, usedTokens: 90_000, source: "stale" } }))?.code, "usage-unknown");
});

test("scheduler requires eligible work and bounds changing tool-loop snapshots per task", () => {
  const scheduler = new PruneScheduler();
  assert.equal(scheduler.decide(input({ eligible: 0 }))?.code, "no-eligible");
  assert.equal(scheduler.decide(input()), undefined);
  scheduler.record("task-a", "content-a", { code: "success", eligible: 3, assessed: 3, dropped: 1, skipped: 0, requests: 1 });
  assert.equal(scheduler.decide(input())?.code, "waiting-cadence");
  assert.equal(scheduler.decide(input({ contentKey: "tool-loop-changed" }))?.code, "waiting-cadence");
  assert.equal(scheduler.decide(input({ cycleKey: "task-b", contentKey: "task-b-content" })), undefined);
});

test("request-budget outcomes alone permit exact-snapshot continuation for fair coverage", () => {
  const scheduler = new PruneScheduler();
  scheduler.record("task-a", "content-a", { code: "request-budget", eligible: 8, assessed: 4, dropped: 0, skipped: 4, requests: 4 });
  assert.equal(scheduler.decide(input()), undefined);
  assert.equal(scheduler.decide(input({ contentKey: "changed" }))?.code, "waiting-cadence");
});
