import { hash, type Item } from "../src/core.js";
import { createJevScorer } from "../src/jev.js";

/** Offline transport check for bounded fair coverage and exact-call deduplication. */
export async function evaluateScheduleCoverage() {
  let remoteRequests = 0;
  const scorer = createJevScorer({
    apiKey: "offline-fixture",
    maxRequestBytes: 2400,
    maxRequests: 1,
    fetch: async (_url, init) => {
      remoteRequests++;
      const request = JSON.parse(String(init?.body));
      return Response.json({
        model: "offline-coverage",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.01 }])),
      });
    },
  });
  const items: Item[] = Array.from({ length: 6 }, (_, index) => {
    const trace = { tool: "read", input: { path: `file-${index}` }, output: "x".repeat(500) };
    return { id: `coverage-${index}`, hash: hash(trace), trace };
  });
  const covered = new Set<string>();
  for (let pass = 0; pass < items.length; pass++) {
    const result = await scorer.score({ task: "unchanged offline coverage fixture" }, items, undefined, "fixed-policy-branch");
    for (const id of result.judgments.keys()) covered.add(id);
  }
  const duplicate = await scorer.score({ task: "unchanged offline coverage fixture" }, items, undefined, "fixed-policy-branch");
  return {
    candidates: items.length,
    covered: covered.size,
    passes: items.length,
    remoteRequests,
    duplicateRemoteRequests: duplicate.requests,
    passed: covered.size === items.length && duplicate.requests === 0,
  };
}
