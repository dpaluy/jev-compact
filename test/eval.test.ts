import assert from "node:assert/strict";
import test from "node:test";
import { fixtures } from "../eval/fixtures.js";
import { evaluate } from "../eval/evaluate.js";
import { evaluateScheduleCoverage } from "../eval/coverage.js";
import { fakeScorer } from "./helpers.js";
import type { Scorer } from "../src/core.js";

for (const fixture of fixtures()) {
  test(`retention contract: ${fixture.id}`, async () => {
    const scorer = fakeScorer(item => item.id === `tool:${fixture.requiredTraceId}`
      ? { keep: 0.9, constraint: 0.9 } : { keep: 0.01, constraint: 0.01 });
    const result = await evaluate(fixture, scorer);
    assert.equal(result.retained, 2);
    assert.equal(result.toolConstraintsRetained, 1);
    assert.ok(result.droppedTraces >= 2);
    assert.ok(result.byteReduction > 0.4);
  });
}

test("offline evaluation exercises bounded fair coverage and exact-request deduplication", async () => {
  const result = await evaluateScheduleCoverage();
  assert.equal(result.passed, true);
  assert.equal(result.covered, result.candidates);
  assert.equal(result.duplicateRemoteRequests, 0);
});

for (const reason of ["context-too-large", "candidate-too-large", "request-budget"]) {
  test(`evaluation counts unassessed candidates: ${reason}`, async () => {
    const scorer: Scorer = { async score(_context, items) {
      const result = await fakeScorer().score({}, items.slice(1));
      result.skipped.set(items[0]!.id, reason);
      return result;
    } };
    const result = await evaluate(fixtures()[0]!, scorer);
    assert.equal(result.unscored, 1);
    assert.ok(result.droppedTraces > 0, "partial assessment must not hide skipped candidates");
  });
}

test("evaluation counts all eligible candidates after scoring fails", async () => {
  const result = await evaluate(fixtures()[0]!, { async score() { throw new Error("offline failure"); } });
  assert.equal(result.unscored, 4);
  assert.equal(result.failure, "scoring-failed");
  assert.equal(result.droppedTraces, 0);
});

test("evaluation detects a bad model drop rather than passing on pinned user text alone", async () => {
  const result = await evaluate(fixtures()[1]!, fakeScorer());
  assert.equal(result.retained, 1);
  assert.equal(result.toolConstraintsRetained, 0);
});
