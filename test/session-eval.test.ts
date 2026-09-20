import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { exportSession, modelWindowsFromStore } from "../eval/session.js";
import { loadSessionReader } from "../eval/session-sdk.js";
import { assistant, call, result, user } from "./helpers.js";

const reader = await loadSessionReader(process.env.PI_EVAL_SDK_PACKAGE);
const fallback = { systemPrompt: "Historical prompt", tools: [], contextWindow: 20_000 };
const header = { type: "session", version: 3, id: "fixture-session", cwd: "/work", timestamp: "2026-09-20T00:00:00Z" };
const entry = (id: string, parentId: string | null, message: unknown) => ({ type: "message", id, parentId, timestamp: header.timestamp, message });
const jsonl = (entries: unknown[]) => [header, ...entries].map(value => JSON.stringify(value)).join("\n");
const base = () => [
  entry("u1", null, user("Inspect the parser.")),
  entry("a1", "u1", assistant([call("read-parser")])),
  entry("t1", "a1", result("read-parser", "Required exact error: E913")),
  entry("a2", "t1", assistant([{ type: "text", text: "FUTURE_ANSWER" }])),
];

test("session export reconstructs pre-answer contexts on the selected branch only", () => {
  const content = jsonl([...base(), entry("u2", "u1", user("Different branch.")),
    entry("a3", "u2", assistant([{ type: "text", text: "Other answer" }]))]);
  const exported = exportSession(content, reader, { ...fallback, leafId: "a2" });
  assert.deepEqual(exported.snapshots.map(snapshot => snapshot.id), ["a1", "a2"]);
  assert.equal(exported.snapshots[0]!.messages.length, 1);
  assert.ok(JSON.stringify(exported.snapshots[1]).includes("Required exact error: E913"));
  assert.ok(!JSON.stringify(exported.snapshots).includes("FUTURE_ANSWER"));
  assert.ok(!JSON.stringify(exported.snapshots).includes("Different branch"));
  const latest = exportSession(content, reader, fallback);
  assert.deepEqual(latest.snapshots.map(snapshot => snapshot.id), ["a3"]);
  assert.ok(!JSON.stringify(latest.snapshots).includes("read-parser"));
});

test("session export applies the native compaction boundary, not the whole lineage", () => {
  const content = jsonl([...base(), entry("u2", "a2", user("Continue after summary.")),
    { type: "compaction", id: "c1", parentId: "u2", timestamp: header.timestamp, summary: "Recorded summary.", firstKeptEntryId: "u2", tokensBefore: 50_000 },
    entry("a3", "c1", assistant([{ type: "text", text: "New response" }]))]);
  const exported = exportSession(content, reader, fallback);
  const last = exported.snapshots.at(-1)!;
  assert.equal(exported.report.compactions, 1);
  assert.equal(last.messages[0]!.role, "compactionSummary");
  assert.ok(JSON.stringify(last).includes("Recorded summary"));
  assert.ok(!JSON.stringify(last).includes("Required exact error"));
  assert.ok(!JSON.stringify(last).includes("New response"));
});

test("missing historical prompt or tools cannot silently become empty context", () => {
  const content = jsonl(base());
  assert.throws(() => exportSession(content, reader, { contextWindow: 20_000 }), /not recorded/);
  assert.throws(() => exportSession(content, reader, { contextWindow: 20_000, systemPrompt: "rules" }), /not recorded/);
  const report = exportSession(content, reader, fallback).report;
  assert.equal(report.suppliedSystemSnapshots, 2);
  assert.ok(report.warnings.some(text => text.includes("supplied")));
});

test("model windows follow the recorded response model and are never guessed", () => {
  const other = { ...assistant([{ type: "text", text: "second" }]), provider: "other", model: "large" };
  const content = jsonl([...base(), entry("a3", "a2", other)]);
  const modelWindows = modelWindowsFromStore({ test: { models: [{ id: "test", contextWindow: 20_000 }] },
    other: { models: [{ id: "large", contextWindow: 100_000 }] } });
  const report = exportSession(content, reader, { systemPrompt: "rules", tools: [], modelWindows });
  assert.deepEqual(report.snapshots.map(snapshot => snapshot.contextWindow), [20_000, 20_000, 100_000]);
  assert.deepEqual(report.snapshots.at(-1)!.model, { provider: "other", id: "large" });
  assert.ok(report.report.models.every(model => model.windowSource === "local-catalog"));
  assert.throws(() => exportSession(content, reader, { systemPrompt: "rules", tools: [] }), /Unknown context window/);
  assert.throws(() => exportSession(content, reader, { ...fallback, contextWindow: 0 }), /positive integer/);
});

test("export rejects damaged JSON and tree structure rather than dropping data", () => {
  assert.throws(() => exportSession(jsonl(base()) + "\n{broken", reader, fallback), /Invalid session JSON/);
  assert.throws(() => exportSession(jsonl([...base(), entry("a1", "a2", user("duplicate"))]), reader, fallback), /invalid tree order/);
  assert.throws(() => exportSession(jsonl([entry("u1", "missing", user("bad"))]), reader, fallback), /missing parent/);
  assert.throws(() => exportSession(jsonl(base()), reader, { ...fallback, leafId: "absent" }), /leaf/);
  assert.throws(() => exportSession(jsonl([...base(),
    { type: "compaction", id: "c", parentId: "a2", timestamp: header.timestamp, summary: "bad", firstKeptEntryId: "absent", tokensBefore: 1 },
  ]), reader, fallback), /retained boundary/);
});

const tool = (name: string) => ({ name, description: `${name} tool`, parameters: { type: "object" } });
const systemBase = () => [
  entry("s1", null, { role: "system", content: "Base prompt", sections: { rules: "RULE_A", obsolete: "REMOVE_ME" }, toolsAdded: [tool("read"), tool("edit")], timestamp: 1 }),
  entry("u1", "s1", user("Inspect.")), entry("a1", "u1", assistant([{ type: "text", text: "first" }])),
  entry("s2", "a1", { role: "system", content: "Additional rule", sections: { rules: "RULE_B", obsolete: null }, toolsRemoved: [{ name: "edit" }], toolsAdded: [tool("bash")], timestamp: 2 }),
  entry("u2", "s2", user("Continue.")), entry("a2", "u2", assistant([{ type: "text", text: "second" }])),
];

test("a reader without system support refuses structured records", () => {
  assert.throws(() => exportSession(jsonl(systemBase()), { ...reader, systemState: undefined }, fallback), /matching Pi SDK/);
});

test("matching SDK restores prompt and tool deltas without removing system messages", { skip: !reader.systemState }, () => {
  const exported = exportSession(jsonl(systemBase()), reader, { contextWindow: 20_000 });
  const [first, second] = exported.snapshots;
  assert.ok(first!.systemPrompt.includes("RULE_A"));
  assert.deepEqual(first!.tools!.map(tool => tool.name), ["read", "edit"]);
  assert.ok(second!.systemPrompt.includes("RULE_B"));
  assert.ok(second!.systemPrompt.includes("Additional rule"));
  assert.ok(!second!.systemPrompt.includes("RULE_A"));
  assert.ok(!second!.systemPrompt.includes("REMOVE_ME"));
  assert.deepEqual(second!.tools!.map(tool => tool.name), ["read", "bash"]);
  assert.equal((second!.messages[0] as { role: string }).role, "system");
  assert.equal(exported.report.suppliedSystemSnapshots, 0);
});

test("matching SDK uses compaction's complete system checkpoint", { skip: !reader.systemState }, () => {
  const content = jsonl([...systemBase(), { type: "compaction", id: "c1", parentId: "a2", timestamp: header.timestamp,
    summary: "Summary.", tokensBefore: 1000, firstKeptEntryId: "s2",
    systemMessage: { role: "system", content: "CHECKPOINT", toolsAdded: [tool("read")], timestamp: 3 } },
    entry("a3", "c1", assistant([{ type: "text", text: "third" }]))]);
  const last = exportSession(content, reader, { contextWindow: 20_000 }).snapshots.at(-1)!;
  assert.equal(last.systemPrompt, "CHECKPOINT");
  assert.deepEqual(last.tools!.map(tool => tool.name), ["read"]);
  assert.equal(last.messages.filter(message => (message as { role: string }).role === "system").length, 1);
  assert.ok(!JSON.stringify(last.messages).includes("RULE_B"));
});

test("session CLI writes private snapshots without changing input or overwriting output", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-session-test-"));
  try {
    const source = join(root, "session.jsonl");
    const out = join(root, "snapshots.json");
    const prompt = join(root, "prompt.txt");
    const tools = join(root, "tools.json");
    const content = jsonl(base()); // No newline: SessionManager.open() could repair this.
    await writeFile(source, content);
    await writeFile(prompt, "PRIVATE_PROMPT");
    await writeFile(tools, "[]");
    const args = ["--import", "tsx", resolve("eval/run-session.ts"), source, "--out", out,
      "--system-prompt", prompt, "--tools", tools, "--context-window", "20000"];
    const { stdout } = await promisify(execFile)(process.execPath, args);
    assert.equal(JSON.parse(stdout).snapshots, 2);
    assert.ok(!stdout.includes("PRIVATE_PROMPT"));
    assert.equal(await readFile(source, "utf8"), content);
    assert.equal(JSON.parse(await readFile(out, "utf8")).length, 2);
    if (process.platform !== "win32") assert.equal((await stat(out)).mode & 0o077, 0);
    await assert.rejects(promisify(execFile)(process.execPath, args), /EEXIST/);
    assert.equal(await readFile(source, "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});
