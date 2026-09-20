import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_POLICY, planPrune } from "../src/core.js";
import { snapshotPi } from "../src/pi/adapter.js";
import { assistant, call, conversation, fakeScorer, result, user } from "./helpers.js";

async function prune(messages: AgentMessage[], recent = 0) {
  const snapshot = snapshotPi(messages, "system rules", "/repo", recent);
  const plan = await planPrune(snapshot.items, snapshot.context, fakeScorer(), DEFAULT_POLICY);
  return { output: snapshot.apply(plan.dropped), plan, snapshot };
}

test("prunes a pair, preserving user text, assistant text, metadata, order and source objects", async () => {
  const input = conversation();
  const original = structuredClone(input);
  const { output } = await prune(input);
  assert.deepEqual(input, original);
  assert.equal(output.length, 3);
  assert.equal(output[0], input[0]);
  assert.equal(output[2], input[3]);
  const message = output[1]!;
  assert.equal(message.role, "assistant");
  if (message.role === "assistant") {
    assert.deepEqual(message.content, [{ type: "text", text: "Inspecting the implementation." }]);
    assert.equal(message.usage, (input[1] as typeof message).usage);
  }
});

test("parallel calls are removed by ID, not tool name or result order", async () => {
  const input = [user("Inspect"), assistant([call("a"), call("b", { path: ".env" })]), result("b", "pinned"), result("a")];
  const { output, plan } = await prune(input);
  assert.deepEqual([...plan.dropped], ["tool:a"]);
  assert.equal(output[2], input[2]);
  assert.ok(JSON.stringify(output).includes('"id":"b"'));
  assert.ok(!JSON.stringify(output).includes('"id":"a"'));
});

test("empty assistant wrappers disappear only when all their calls disappear", async () => {
  const { output } = await prune([user("keep"), assistant([call("a")]), result("a")]);
  assert.deepEqual(output, [user("keep")]);
});

test("incomplete, duplicate, orphan, out-of-order, mismatched and multimodal traces stay", async () => {
  const cases: AgentMessage[][] = [
    [assistant([call("a")])],
    [assistant([call("a"), call("a")]), result("a")],
    [assistant([call("a")]), result("a"), result("a")],
    [result("orphan")],
    [result("a"), assistant([call("a")])],
    [assistant([call("a")]), { ...result("a"), toolName: "other" }],
    [assistant([call("a")]), { ...result("a"), content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }],
    [assistant([call("a")]), { ...result("a"), addedToolNames: ["discovered"] }],
    [assistant([{ type: "thinking", thinking: "", thinkingSignature: "opaque" }, call("a")]), result("a")],
    [assistant([{ ...call("a"), thoughtSignature: "opaque" }]), result("a")],
  ];
  for (const input of cases) {
    const { output, plan } = await prune(input);
    assert.deepEqual(output, input);
    assert.equal(plan.dropped.size, 0);
  }
});

test("recent boundary protects either side of a call/result pair", async () => {
  const input = conversation();
  const { output, plan } = await prune(input, 2);
  assert.deepEqual(output, input);
  assert.equal(plan.decisions.find(d => d.itemId === "tool:old")!.reason, "recent");
});

test("absolute and normalized paths obey project-relative pins", async () => {
  for (const path of ["/repo/.env", "src/../.env", ".\\.env"]) {
    const { output, plan } = await prune([assistant([call("a", { path })]), result("a")]);
    assert.equal(output.length, 2);
    assert.equal(plan.decisions[0]!.reason, "path-pin");
  }
});

test("image-dependent tasks keep all traces rather than score without visual evidence", async () => {
  const input = conversation();
  input.push({ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 5 });
  const { output, plan } = await prune(input);
  assert.deepEqual(output, input);
  assert.equal(plan.decisions.find(d => d.itemId === "tool:old")!.reason, "non-text-context");
});

test("no policy result can remove user or unknown items", () => {
  const snapshot = snapshotPi(conversation(), "", "/repo", 0);
  assert.throws(() => snapshot.apply(new Set(["message:0"])), /protected/);
  assert.throws(() => snapshot.apply(new Set(["unknown"])), /unknown/);
});

test("new tasks and branches are assessed from their own input, without sticky drops", async () => {
  const input = conversation();
  const first = snapshotPi(input, "", "/repo", 0);
  const dropped = await planPrune(first.items, first.context, fakeScorer(), DEFAULT_POLICY);
  assert.equal(first.apply(dropped.dropped).length, 3);
  const second = snapshotPi([...input, user("Use that old trace again")], "", "/repo", 0);
  const kept = await planPrune(second.items, second.context, fakeScorer(() => ({ keep: 1, constraint: 1 })), DEFAULT_POLICY);
  assert.equal(second.apply(kept.dropped).length, 5);
});
