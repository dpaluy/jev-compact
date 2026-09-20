import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY, hash, planPrune, type Item } from "../src/core.js";
import { buildRequest, createJevScorer, JEV_ENDPOINT } from "../src/jev.js";

const item = (id = "one", size = 100): Item => ({ id, hash: hash(id), trace: { tool: "read", input: { path: "file.rb" }, output: "x".repeat(size) } });
function answer(body: string, edit?: (response: Record<string, any>) => void): Response {
  const request = JSON.parse(body);
  const response: Record<string, any> = { model: "jev-test-resolved", usage: { input_tokens: 100, output_tokens: 4 },
    answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.01 }])) };
  edit?.(response);
  return Response.json(response);
}

test("sends full candidate content and records resolved model and actual scorer usage", async () => {
  const evidence = item();
  evidence.trace!.output = "first\n" + "noise\n".repeat(1500) + "EXACT_CONSTRAINT_AT_END";
  const scorer = createJevScorer({ apiKey: "test-only", fetch: async (url, init) => {
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init?.redirect, "error");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.candidates[0].output, evidence.trace!.output);
    assert.equal(request.state.context.systemPrompt, "rules");
    assert.equal(Object.keys(request.questions).length, 2);
    return answer(String(init?.body));
  } });
  const result = await scorer.score({ systemPrompt: "rules" }, [evidence]);
  assert.equal(result.judgments.get("one")!.model, "jev-test-resolved");
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 4);
});

test("request byte limits include questions and UTF-8 data; full oversize outputs stay", async () => {
  const oversized = item("huge", 24_000);
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "test", maxRequestBytes: 3000, fetch: async (_url, init) => {
    requests++;
    assert.ok(Buffer.byteLength(String(init?.body)) <= 3000);
    return answer(String(init?.body));
  } });
  const normal = item("small", 500);
  normal.trace!.output = "日本語".repeat(100);
  const result = await scorer.score({}, [oversized, normal]);
  assert.equal(result.skipped.get("huge"), "candidate-too-large");
  assert.equal(requests, 1);
});

test("large context is not silently truncated", async () => {
  const scorer = createJevScorer({ apiKey: "test", fetch: async () => { throw new Error("must not call"); } });
  const result = await scorer.score({ user: "x".repeat(30_000) }, [item()]);
  assert.equal(result.requests, 0);
  assert.equal(result.skipped.get("one"), "context-too-large");
});

test("request count is bounded and unscored candidates stay", async () => {
  const scorer = createJevScorer({ apiKey: "test", maxRequestBytes: 2400, maxRequests: 1,
    fetch: async (_url, init) => answer(String(init?.body)) });
  const result = await scorer.score({}, [item("one", 500), item("two", 500)]);
  assert.equal(result.requests, 1);
  assert.equal(result.judgments.size, 1);
  assert.equal(result.skipped.get("two"), "request-budget");
});

test("response validation rejects bad data and atomically keeps every trace", async () => {
  const mutations = [
    (r: Record<string, any>) => { delete r.answers.keep_0; },
    (r: Record<string, any>) => { r.answers.keep_0.noul = "0"; },
    (r: Record<string, any>) => { r.answers.keep_0.noul = 2; },
    (r: Record<string, any>) => { r.answers.keep_0.type = "score"; },
    (r: Record<string, any>) => { r.model = ""; },
    (r: Record<string, any>) => { r.usage.input_tokens = -1; },
    (r: Record<string, any>) => { r.answers.extra = { type: "noul", noul: 0 }; },
  ];
  for (const mutation of mutations) {
    const scorer = createJevScorer({ apiKey: "test", fetch: async (_url, init) => answer(String(init?.body), mutation) });
    const plan = await planPrune([item()], {}, scorer, DEFAULT_POLICY);
    assert.equal(plan.dropped.size, 0);
    assert.equal(plan.failure, "scoring-failed");
  }
});

test("late batch failure does not apply earlier drop decisions", async () => {
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "test", maxRequestBytes: 2400,
    fetch: async (_url, init) => ++requests === 1 ? answer(String(init?.body)) : new Response("private data", { status: 429 }) });
  const plan = await planPrune([item("one", 500), item("two", 500)], {}, scorer, DEFAULT_POLICY);
  assert.equal(requests, 2);
  assert.equal(plan.dropped.size, 0);
});

test("deadline aborts the request and keeps the trace", async () => {
  const scorer = createJevScorer({ apiKey: "test", timeoutMs: 10, fetch: async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("deadline not honored")), 1000);
      init!.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
  } });
  const plan = await planPrune([item()], {}, scorer, DEFAULT_POLICY);
  assert.equal(plan.failure, "scoring-failed");
  assert.equal(plan.dropped.size, 0);
});

test("exact-input cache deduplicates calls and fairly reaches candidates beyond the first four batches", async () => {
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "test", maxRequestBytes: 2400, maxRequests: 1,
    fetch: async (_url, init) => { requests++; return answer(String(init?.body)); } });
  const items = Array.from({ length: 6 }, (_, index) => item(`item-${index}`, 500));
  const seen = new Set<string>();
  for (let pass = 0; pass < 6; pass++) {
    const result = await scorer.score({ task: "same" }, items, undefined, "same-policy-task-branch");
    for (const id of result.judgments.keys()) seen.add(id);
  }
  assert.equal(requests, 6);
  assert.equal(seen.size, 6);
  const cached = await scorer.score({ task: "same" }, items, undefined, "same-policy-task-branch");
  assert.equal(cached.requests, 0);
  assert.equal(cached.judgments.size, 6);
  assert.equal(requests, 6);
});

test("cache identity includes context, policy identity, model and source hash", async () => {
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "test", fetch: async (_url, init) => { requests++; return answer(String(init?.body)); } });
  const original = item("same", 100);
  await scorer.score({ task: "a" }, [original], undefined, "policy-a");
  await scorer.score({ task: "a" }, [original], undefined, "policy-a");
  await scorer.score({ task: "b" }, [original], undefined, "policy-a");
  await scorer.score({ task: "b" }, [original], undefined, "policy-b");
  const changed = item("same", 101);
  changed.hash = hash({ changed: changed.trace });
  await scorer.score({ task: "b" }, [changed], undefined, "policy-b");
  assert.equal(requests, 4);
});

test("task, branch, policy and source changes cannot reapply stale drops", async () => {
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "test", fetch: async (_url, init) => {
    requests++;
    return answer(String(init?.body), response => {
      const value = requests === 1 ? 0.01 : 0.9;
      for (const answerValue of Object.values(response.answers)) (answerValue as { noul: number }).noul = value;
    });
  } });
  const original = item("same", 100);
  const first = await planPrune([original], { task: "a", branch: "main" }, scorer, DEFAULT_POLICY);
  assert.equal(first.dropped.size, 1);
  const newTask = await planPrune([original], { task: "b", branch: "main" }, scorer, DEFAULT_POLICY);
  assert.equal(newTask.dropped.size, 0);
  const newBranch = await planPrune([original], { task: "a", branch: "fork" }, scorer, DEFAULT_POLICY);
  assert.equal(newBranch.dropped.size, 0);
  const newPolicy = await planPrune([original], { task: "a", branch: "main" }, scorer, { ...DEFAULT_POLICY, keepThreshold: 0.1 });
  assert.equal(newPolicy.dropped.size, 0);
  const changed = item("same", 101);
  changed.hash = hash(changed.trace);
  const newSource = await planPrune([changed], { task: "a", branch: "main" }, scorer, DEFAULT_POLICY);
  assert.equal(newSource.dropped.size, 0);
  assert.equal(requests, 5);
});

test("a failed pass does not cache or apply partial proposals", async () => {
  let requests = 0;
  let failSecond = true;
  const scorer = createJevScorer({ apiKey: "test", maxRequestBytes: 2400, maxRequests: 2,
    fetch: async (_url, init) => {
      requests++;
      if (failSecond && requests === 2) return new Response("private", { status: 500 });
      return answer(String(init?.body));
    } });
  const items = [item("one", 500), item("two", 500)];
  const failed = await planPrune(items, { task: "same" }, scorer, DEFAULT_POLICY);
  assert.equal(failed.dropped.size, 0);
  failSecond = false;
  const recovered = await planPrune(items, { task: "same" }, scorer, DEFAULT_POLICY);
  assert.equal(recovered.dropped.size, 2);
  assert.equal(requests, 4, "the first partial judgment was not retained after failure");
});

test("impossible protected context makes zero remote calls and reports context-too-large", async () => {
  let requests = 0;
  const scorer = createJevScorer({ apiKey: "test", fetch: async () => { requests++; throw new Error("must not call"); } });
  const context = { systemPrompt: "s".repeat(30_000), history: "h".repeat(19_046) };
  const plan = await planPrune([item()], context, scorer, DEFAULT_POLICY);
  assert.equal(requests, 0);
  assert.equal(plan.dropped.size, 0);
  assert.equal(plan.outcome.code, "context-too-large");
  assert.equal(plan.outcome.skipped, 1);
});

test("questions address content by position, not by invisible question IDs", () => {
  const request = buildRequest({}, [item()], "test");
  assert.match(request.questions.keep_0!.instructions, /candidates\[0\]/);
  assert.match(request.questions.constraint_0!.instructions, /candidates\[0\]/);
});
