import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import { DEFAULT_POLICY, hash, planPrune, type Scorer } from "../src/core.js";
import { createJevScorer } from "../src/jev.js";
import { registerPruner, type Dependencies } from "../src/pi/extension.js";
import { assistant, call, conversation, result, user } from "./helpers.js";

function transport(onRequest: (request: any) => number = () => 0.01): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const probability = onRequest(request);
    return Response.json({ model: "offline", usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: probability }])) });
  };
}

function harness(scorer: Scorer, audit: Dependencies["audit"] = async () => "offline-no-file") {
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notices: string[] = [];
  const ctx = {
    cwd: "/offline", hasUI: true, ui: { notify: (text: string) => notices.push(text) },
    model: { id: "offline", provider: "offline", contextWindow: 10_000 },
    getContextUsage: () => ({ tokens: 7000, contextWindow: 10_000, percent: 70 }),
    getSystemPrompt: () => "fixture", signal: undefined as AbortSignal | undefined,
    sessionManager: { getSessionFile: () => "/offline/session", getSessionId: () => "offline" },
  };
  registerPruner({ registerFlag() {}, getFlag() {},
    getActiveTools: () => [], getAllTools: () => [],
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as unknown as ExtensionAPI, {
    config: { ...DEFAULT_CONFIG, enabled: true, preserveRecentMessages: 0 }, scorer, audit,
  });
  return {
    ctx, notices,
    start: () => hooks.get("session_start")!({}, ctx as unknown as ExtensionContext),
    shutdown: () => hooks.get("session_shutdown")!({}, ctx as unknown as ExtensionContext),
    project: (messages: AgentMessage[]): Promise<{ messages: AgentMessage[] } | undefined> =>
      hooks.get("context")!({ messages }, ctx as unknown as ExtensionContext),
    status: async () => { await commands.get("jev-prune")!.handler("status", ctx); return notices.at(-1)!; },
    command: (text: string) => commands.get("jev-prune")!.handler(text, ctx),
  };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("identical outgoing context keeps its audited projection without scoring or logging again", async () => {
  let requests = 0;
  let audits = 0;
  const h = harness(createJevScorer({ apiKey: "offline", fetch: transport(() => { requests++; return 0.01; }) }),
    async () => { audits++; return "offline"; });
  await h.start();
  const messages = conversation();
  const first = await h.project(messages);
  const second = await h.project(structuredClone(messages));
  assert.ok(first!.messages.length < messages.length);
  assert.deepEqual(second, first);
  assert.equal(requests, 1);
  assert.equal(audits, 1);
  await h.command("off");
  assert.equal(await h.project(messages), undefined);
  await h.start();
  await h.project(messages);
  assert.equal(requests, 2, "lifecycle reset clears reusable judgments");
});

test("changed tool-loop context cannot use an old projection and emergency pressure bypasses cadence", async () => {
  let requests = 0;
  const h = harness(createJevScorer({ apiKey: "offline", fetch: transport(() => ++requests === 1 ? 0.01 : 1) }));
  await h.start();
  const messages = conversation();
  await h.project(messages);
  const changed = [...messages, assistant([{ type: "text", text: "New evidence requires the earlier trace." }])];
  assert.equal(await h.project(changed), undefined);
  assert.equal(requests, 1);
  h.ctx.getContextUsage = () => ({ tokens: 9500, contextWindow: 10_000, percent: 95 });
  const emergency = await h.project(changed);
  assert.deepEqual(emergency!.messages, changed);
  assert.equal(requests, 2);
});

test("an evolving conversation reaches later traces without reusing stale judgments", async () => {
  const seen = new Set<string>();
  let requests = 0;
  const h = harness(createJevScorer({ apiKey: "offline", fetch: transport(request => {
    requests++;
    for (const candidate of request.state.candidates) seen.add(candidate.input.path);
    return 0.01;
  }) }));
  await h.start();
  const messages: AgentMessage[] = [user("Preserve requirements.")];
  for (let i = 0; i < 6; i++) messages.push(assistant([call(`trace-${i}`, { path: `trace-${i}` })]), result(`trace-${i}`, "x".repeat(13_000)));
  await h.project(messages);
  assert.equal(seen.size, 4);
  messages.push(user("New task: reconsider all earlier evidence."));
  await h.project(messages);
  assert.equal(seen.size, 6);
  assert.equal(requests, 8, "the new task gets fresh judgments, not old drops");
});

test("audit failure retains context and retries after repair on the next task", async () => {
  let blocked = true;
  let requests = 0;
  const h = harness(createJevScorer({ apiKey: "offline", fetch: transport(() => { requests++; return 0.01; }) }),
    async () => { if (blocked) throw new Error("offline failure"); return "offline"; });
  await h.start();
  const messages = conversation();
  assert.equal(await h.project(messages), undefined);
  assert.match(await h.status(), /audit failed/);
  blocked = false;
  const next = [...messages, user("Continue after repairing audit storage.")];
  const recovered = await h.project(next);
  assert.ok(recovered!.messages.length < next.length);
  assert.equal(requests, 2);
  assert.match(await h.status(), /pruned successfully/);
});

for (const phase of ["scoring", "audit"] as const) {
  test(`cancellation during ${phase} records cancellation, never a previous success`, async () => {
    const started = latch();
    const finish = latch();
    let pause = false;
    const h = harness(createJevScorer({ apiKey: "offline", fetch: async (_url, init) => {
      if (pause && phase === "scoring") { started.release(); await finish.promise; }
      return transport()(_url, init);
    } }), async () => {
      if (pause && phase === "audit") { started.release(); await finish.promise; }
      return "offline";
    });
    await h.start();
    const messages = conversation();
    await h.project(messages);
    assert.match(await h.status(), /pruned successfully/);
    pause = true;
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    const pending = h.project([...messages, user("A new task.")]);
    await started.promise;
    controller.abort();
    finish.release();
    assert.equal(await pending, undefined);
    assert.match(await h.status(), /pruning cancelled/);
  });
}

test("a pending old audit cannot overwrite off or a new session outcome", async () => {
  const started = latch();
  const finish = latch();
  const h = harness(createJevScorer({ apiKey: "offline", fetch: transport() }), async () => {
    started.release(); await finish.promise; throw new Error("old audit failure");
  });
  await h.start();
  const pending = h.project(conversation());
  await started.promise;
  await h.command("off");
  h.shutdown();
  await h.start();
  await h.command("off");
  finish.release();
  assert.equal(await pending, undefined);
  assert.match(await h.status(), /off: disabled/);
});

test("impossible protected context reports why it cannot prune and deduplicates the no-op", async () => {
  let requests = 0;
  let audits = 0;
  const h = harness(createJevScorer({ apiKey: "offline", fetch: transport(() => { requests++; return 0.01; }) }),
    async () => { audits++; return "offline"; });
  h.ctx.getSystemPrompt = () => "x".repeat(30_000);
  await h.start();
  const messages = conversation();
  assert.deepEqual((await h.project(messages))!.messages, messages);
  assert.match(await h.status(), /protected scorer context exceeds/);
  assert.deepEqual((await h.project(messages))!.messages, messages);
  assert.equal(requests, 0);
  assert.equal(audits, 1);
});

test("peer candidates, source positions, and snapshot identity invalidate old judgments", async () => {
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "offline", fetch: transport(() => ++requests === 1 ? 0.01 : 1) });
  const a = { id: "a", hash: hash("a"), trace: { tool: "read", input: {}, output: "A", sourceIndex: 1 } };
  const b = { id: "b", hash: hash("b"), trace: { tool: "read", input: {}, output: "B", sourceIndex: 3 } };
  assert.equal((await planPrune([a, b], {}, scorer, DEFAULT_POLICY)).dropped.size, 2);
  const changed = { ...b, hash: hash("new B"), trace: { ...b.trace, output: "B now requires A" } };
  assert.equal((await planPrune([a, changed], {}, scorer, DEFAULT_POLICY)).dropped.size, 0);
  await planPrune([{ ...a, trace: { ...a.trace, sourceIndex: 2 } }, changed], {}, scorer, DEFAULT_POLICY);
  await planPrune([a, changed], {}, scorer, DEFAULT_POLICY, undefined, "new-adapter-snapshot");
  assert.equal(requests, 4);
});

test("selection advances beyond cache capacity without starving the last candidates", { timeout: 20_000 }, async () => {
  const seen = new Set<string>();
  const scorer = createJevScorer({ apiKey: "offline", maxRequests: 16, maxRequestBytes: 2400,
    fetch: transport(request => { for (const candidate of request.state.candidates) seen.add(candidate.input.id); return 0.01; }) });
  const items = Array.from({ length: 1026 }, (_, index) => ({ id: String(index), hash: hash(index),
    trace: { tool: "read", input: { id: String(index) }, output: "x".repeat(500) } }));
  for (let pass = 0; pass < 65; pass++) await scorer.score({}, items);
  assert.equal(seen.size, 1026);
});
