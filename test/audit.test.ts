import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAudit, type AuditRun } from "../src/audit.js";
import { DEFAULT_POLICY, hash, planPrune } from "../src/core.js";
import { snapshotPi } from "../src/pi/adapter.js";
import { conversation, fakeScorer } from "./helpers.js";

test("writes durable, private JSONL with a decision per item and no raw text", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-audit-"));
  try {
    const input = conversation();
    const snapshot = snapshotPi(input, "", root, 0);
    const plan = await planPrune(snapshot.items, snapshot.context, fakeScorer(), DEFAULT_POLICY);
    const output = snapshot.apply(plan.dropped);
    const run: AuditRun = {
      host: "pi", sessionId: "session", inputHash: hash(input), outputHash: hash(output), policy: DEFAULT_POLICY,
      requestedModel: "fake", beforeBytes: 1000, afterBytes: 500, plan,
    };
    const directory = join(root, "log");
    const [path, concurrent] = await Promise.all([writeAudit(directory, run), writeAudit(directory, run)]);
    assert.notEqual(path, concurrent);
    const text = await readFile(path, "utf8");
    const records = text.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records[0].byteReduction, 0.5);
    assert.equal(records.at(-1).type, "ready");
    const decisions = records.filter(row => row.type === "decision");
    assert.equal(decisions.length, snapshot.items.length);
    assert.equal(decisions.find(row => row.action === "drop").model, "fake-offline");
    assert.ok(decisions.every(row => row.snippetHash.length === 64 && row.timestamp && row.sessionId === "session"));
    assert.ok(!text.includes("Never edit"));
    assert.ok(!text.includes("old progress output"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    // Decisions plus an unchanged original input can reproduce the projection.
    const replay = snapshot.apply(new Set(decisions.filter(row => row.action === "drop").map(row => row.itemId)));
    assert.deepEqual(replay, output);
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "fixture");
    await assert.rejects(writeAudit(blocked, run));
  } finally { await rm(root, { recursive: true, force: true }); }
});
