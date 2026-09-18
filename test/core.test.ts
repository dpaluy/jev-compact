import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY, hash, planPrune, type Item, type Scorer } from "../src/core.js";
import { parseConfig } from "../src/pi/config.js";
import { fakeScorer } from "./helpers.js";

const item = (id = "t1"): Item => ({ id, hash: hash(id), trace: { tool: "read", input: {}, output: "old output" } });

test("drops only when both retention scores are below threshold", async () => {
  for (const [keep, constraint, expected] of [[0.1, 0.1, "drop"], [0.2, 0, "keep"], [0, 0.2, "keep"], [0.5, 0, "keep"], [0.9, 0, "keep"]] as const) {
    const plan = await planPrune([item()], {}, fakeScorer(() => ({ keep, constraint })), DEFAULT_POLICY);
    assert.equal(plan.decisions[0]!.action, expected);
  }
});

test("user and path pins bypass even a drop-everything scorer", async () => {
  const items = [
    { ...item("u"), protectedReason: "user-message" },
    { ...item("path"), paths: [".env"] },
    { ...item("nested"), paths: ["/repo/lib/AGENTS.md"] },
    { ...item("custom"), paths: ["lib/generated/api.rb"] },
  ];
  const scorer: Scorer = { async score() { throw new Error("Pinned content must not be scored"); } };
  const plan = await planPrune(items, {}, scorer, { ...DEFAULT_POLICY, pinPaths: [...DEFAULT_POLICY.pinPaths, "lib/generated/**"] });
  assert.equal(plan.dropped.size, 0);
  assert.equal(plan.failure, undefined);
  assert.deepEqual(plan.decisions.map(d => d.reason), ["user-message", "path-pin", "path-pin", "path-pin"]);
});

test("malformed, missing, extra, or conflicting judgments retain the full input", async () => {
  for (const scenario of ["missing", "extra", "nan", "range", "model", "conflict", "throw"]) {
    const scorer: Scorer = { async score(context, items) {
      const result = await fakeScorer().score(context, items);
      if (scenario === "missing") result.judgments.delete("t2");
      if (scenario === "extra") result.judgments.set("other", result.judgments.get("t1")!);
      if (scenario === "nan") result.judgments.get("t2")!.scores.keep = NaN;
      if (scenario === "range") result.judgments.get("t2")!.scores.constraint = -1;
      if (scenario === "model") result.judgments.get("t2")!.model = "";
      if (scenario === "conflict") result.skipped.set("t2", "request-budget");
      if (scenario === "throw") throw new Error("sensitive provider text");
      return result;
    } };
    const plan = await planPrune([item("t1"), item("t2")], {}, scorer, DEFAULT_POLICY);
    assert.equal(plan.dropped.size, 0, scenario);
    assert.equal(plan.failure, "scoring-failed");
    assert.equal(plan.outcome.code, "scoring-error");
    assert.equal(plan.inputTokens, null, "Failed scoring usage is unknown, not zero");
    assert.ok(!JSON.stringify(plan).includes("sensitive"));
  }
});

test("abort retains all candidates", async () => {
  const controller = new AbortController();
  controller.abort();
  const plan = await planPrune([item()], {}, fakeScorer(), DEFAULT_POLICY, controller.signal);
  assert.equal(plan.dropped.size, 0);
  assert.equal(plan.failure, "cancelled");
  assert.equal(plan.outcome.code, "cancelled");
});

test("configuration rejects unsafe thresholds, unknown keys and invalid limits", () => {
  for (const config of [{ keepThreshold: 0.8 }, { keepThreshold: NaN }, { pinPaths: [1] }, { model: "" },
    { maxRequests: 0 }, { timeoutMs: -1 }, { maxRequestBytes: 32_000 }, { preserveRecentMessages: 0.5 }, { typo: 1 }, { constructor: "bad" }]) {
    assert.throws(() => parseConfig(config));
  }
  assert.equal(parseConfig({ keepThreshold: 0 }).keepThreshold, 0);
});

test("duplicate IDs cannot produce an ambiguous plan", async () => {
  await assert.rejects(planPrune([item(), item()], {}, fakeScorer(), DEFAULT_POLICY), /Duplicate/);
});
