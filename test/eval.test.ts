import assert from "node:assert/strict";
import test from "node:test";
import { fixtures } from "../eval/fixtures.js";
import { evaluate } from "../eval/evaluate.js";
import { evaluateScheduleCoverage } from "../eval/coverage.js";
import { fakeScorer } from "./helpers.js";

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

test("evaluation detects a bad model drop rather than passing on pinned user text alone", async () => {
  const result = await evaluate(fixtures()[1]!, fakeScorer());
  assert.equal(result.retained, 1);
  assert.equal(result.toolConstraintsRetained, 0);
});
