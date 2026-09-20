import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_POLICY, planPrune } from "../src/core.js";
import { snapshotPi } from "../src/pi/adapter.js";
import { assistant, call, fakeScorer, result, user } from "../test/helpers.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run eval:project -- /path/to/rubric_llm");
const cwd = resolve(path);
const read = createReadTool(cwd);
const files = ["AGENTS.md", "lib/rubric_llm/config.rb", "lib/rubric_llm/system_one/client.rb"];
const messages: AgentMessage[] = [user("Inspect RubricLLM configuration and System One validation. Never edit .env. Preserve exact errors and API contracts.")];
for (const [i, file] of files.entries()) {
  const id = `source-${i}`;
  const output = await read.execute(id, { path: file });
  messages.push(assistant([call(id, { path: file })]), {
    role: "toolResult", toolCallId: id, toolName: "read", content: output.content,
    details: output.details, isError: false, timestamp: i + 10,
  });
  messages.push(assistant([call(`noise-${i}`, { path: "tmp/old-progress.log" })]),
    result(`noise-${i}`, "Old completed progress, no task evidence.\n".repeat(150)));
}
messages.push(user("Continue using the inspected interfaces."));
const original = structuredClone(messages);
const snapshot = snapshotPi(messages, "Keep all project rules.", cwd, 0);
const plan = await planPrune(snapshot.items, snapshot.context,
  fakeScorer(item => item.id.startsWith("tool:source-") ? { keep: 1, constraint: 1 } : { keep: 0, constraint: 0 }), DEFAULT_POLICY);
const output = snapshot.apply(plan.dropped);
assert.deepEqual(messages, original);
const expected = ["Never edit .env.", "Tests use Minitest only.",
  "RUBRIC_CASCADE_NOUL_BAND must contain two comma-separated numbers", "System One question ids must be unique"];
const text = output.flatMap(message => {
  if (!("content" in message)) return [];
  return typeof message.content === "string" ? [message.content] : message.content.filter(b => b.type === "text").map(b => b.text);
}).join("\n");
for (const constraint of expected) assert.ok(text.includes(constraint), `Missing: ${constraint}`);
assert.equal(plan.dropped.size, 3);
const before = Buffer.byteLength(JSON.stringify(messages));
const after = Buffer.byteLength(JSON.stringify(output));
console.log(JSON.stringify({
  mode: "offline-project-contract", cwd, sourceFilesRead: files.length,
  retention: `${expected.length}/${expected.length}`, droppedTraces: plan.dropped.size,
  byteReduction: 1 - after / before,
  note: "Real Pi read-tool outputs; scripted conversation and fixture-label scores. No project writes, network calls, or Jev accuracy claim.",
}, null, 2));
