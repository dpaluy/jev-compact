import assert from "node:assert/strict";
import test from "node:test";
import { compareRetention, estimatedTokens, retainRecent } from "../eval/compare.js";
import { comparisonFixtures, type Fixture } from "../eval/fixtures.js";
import { snapshotPi } from "../src/pi/adapter.js";
import { assistant, call, fakeScorer, result, user } from "./helpers.js";

function fixture(newSize = 1000): Fixture {
  return {
    id: "equal-budget", requiredTraceId: "old", constraints: [
      { source: "user", itemId: "message:0", text: "Never remove a constraint." },
      { source: "tool", itemId: "tool:old", text: "Required exact error: E913" },
    ],
    messages: [user("Never remove a constraint."),
      assistant([call("old")]), result("old", "Required exact error: E913".padEnd(1000, ".")),
      assistant([call("mid")]), result("mid", "Completed progress.".padEnd(1000, ".")),
      assistant([call("new")]), result("new", "Completed progress.".padEnd(newSize, ".")),
      user("Continue the fix."), assistant([{ type: "text", text: "Working." }])],
  };
}

test("comparison fixtures use equal estimated pair sizes and preserve their evidence labels", async () => {
  for (const input of comparisonFixtures()) {
    const sizes = input.messages.flatMap((message, index) => message.role === "toolResult"
      ? [estimatedTokens([input.messages[index - 1]!, message])] : []);
    assert.equal(new Set(sizes).size, 1);
    const report = await compareRetention(input, fakeScorer(item => ({ keep: item.id === `tool:${input.requiredTraceId}` ? 1 : 0, constraint: 0 })));
    assert.equal(report.exactlyMatched, true);
    assert.equal(report.jev.retained, report.jev.constraints);
  }
});

test("matched-budget comparison distinguishes evidence retention from recency", async () => {
  const input = fixture();
  const original = structuredClone(input);
  const report = await compareRetention(input, fakeScorer(item => ({ keep: item.id === "tool:old" ? 1 : 0, constraint: 0 })));
  assert.equal(report.exactlyMatched, true);
  assert.equal(report.fullyAssessed, true);
  assert.equal(report.jev.retainedEstimatedTokens, report.recency.retainedEstimatedTokens);
  assert.equal(report.jev.toolConstraintsRetained, 1);
  assert.equal(report.recency.toolConstraintsRetained, 0);
  assert.deepEqual(input, original);
});

test("indivisible-pair slack is reported instead of claiming an exact match", async () => {
  const report = await compareRetention(fixture(1500), fakeScorer(item => ({ keep: item.id !== "tool:new" ? 1 : 0, constraint: 0 })));
  assert.ok(report.recencyBudgetSlackTokens > 0);
  assert.equal(report.exactlyMatched, false);
  assert.ok(report.recency.retainedEstimatedTokens < report.budgetEstimatedTokens);
});

test("unassessed evidence and path pins are protected in both arms", async () => {
  const input = fixture();
  input.messages.splice(7, 0, assistant([call("pin", { path: "AGENTS.md" })]), result("pin", "Project rule."));
  const report = await compareRetention(input, { async score(_context, items) {
    const result = await fakeScorer().score({}, items.filter(item => item.id !== "tool:old"));
    result.skipped.set("tool:old", "candidate-too-large");
    return result;
  } });
  assert.equal(report.unscored, 1);
  assert.equal(report.fullyAssessed, false);
  assert.equal(report.jev.toolConstraintsRetained, 1);
  assert.equal(report.recency.toolConstraintsRetained, 1);
  assert.equal(report.jev.droppedTraces, 2);
  assert.equal(report.recency.droppedTraces, 2);
});

test("failed scoring cannot produce a positive comparison result", async () => {
  const report = await compareRetention(fixture(), { async score() { throw new Error("offline"); } });
  assert.equal(report.fullyAssessed, false);
  assert.equal(report.failure, "scoring-failed");
  assert.equal(report.unscored, 3);
  assert.equal(report.jev.droppedTraces, 0);
  assert.equal(report.recency.droppedTraces, 0);
});

test("recency selection keeps full pairs and all assistant text without exam truncation", () => {
  const text = "a".repeat(400_000) + "MIDDLE_FACT" + "b".repeat(400_000);
  const messages = [user("Work"), assistant([{ type: "text", text }, call("old"), call("new")]),
    result("old", "old output"), result("new", "new output")];
  const snapshot = snapshotPi(messages, "rules", "/work", 0);
  const budget = estimatedTokens(snapshot.apply(new Set(["tool:old"])));
  const output = retainRecent(snapshot, new Set(["tool:old", "tool:new"]), budget).messages;
  assert.equal(output[1]!.role, "assistant");
  assert.ok(JSON.stringify(output).includes("MIDDLE_FACT"));
  assert.ok(JSON.stringify(output).includes("new output"));
  assert.ok(!JSON.stringify(output).includes("old output"));
  if (output[1]!.role === "assistant") assert.equal(output[1]!.content.filter(block => block.type === "toolCall").length, 1);
  assert.ok(estimatedTokens(output) <= budget);
});
