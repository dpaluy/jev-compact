import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLICY, planPrune, type Scorer } from "../src/core.js";
import { snapshotPi, type Snapshot } from "../src/pi/adapter.js";
import { measureRetention } from "./evaluate.js";
import type { Fixture } from "./fixtures.js";

export function estimatedTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Whole pairs only. Unassessed pairs get the same protection in both arms. */
export function retainRecent(snapshot: Snapshot, assessedIds: ReadonlySet<string>, budgetTokens: number) {
  const dropped = new Set(assessedIds);
  const ranked = snapshot.items.filter(item => assessedIds.has(item.id)).reverse()
    .sort((a, b) => (b.trace?.sourceIndex ?? -1) - (a.trace?.sourceIndex ?? -1));
  for (const item of ranked) {
    dropped.delete(item.id);
    if (estimatedTokens(snapshot.apply(dropped)) > budgetTokens) dropped.add(item.id);
  }
  const messages = snapshot.apply(dropped);
  return { messages, dropped };
}

/** Compare the shipping threshold policy with recency at its retained-token ceiling.
 * No retrieval or new summary is added to either arm. Budget slack is not hidden.
 */
export async function compareRetention(fixture: Fixture, scorer: Scorer) {
  const snapshot = snapshotPi(fixture.messages, "Preserve all task requirements verbatim.", "/work/rubric_llm", 2);
  const started = performance.now();
  const plan = await planPrune(snapshot.items, snapshot.context, scorer, DEFAULT_POLICY);
  const jevElapsedMs = performance.now() - started;
  const jevMessages = snapshot.apply(plan.dropped);
  const budgetTokens = estimatedTokens(jevMessages);
  const assessedIds = new Set(plan.decisions.filter(d => d.scores !== null).map(d => d.itemId));
  const recentStarted = performance.now();
  const recent = retainRecent(snapshot, assessedIds, budgetTokens);
  const recentElapsedMs = performance.now() - recentStarted;
  const metrics = (messages: AgentMessage[], dropped: number, elapsedMs: number) => ({
    ...measureRetention(fixture, messages), retainedEstimatedTokens: estimatedTokens(messages),
    retainedBytes: Buffer.byteLength(JSON.stringify(messages)), droppedTraces: dropped, elapsedMs,
  });
  const slack = budgetTokens - estimatedTokens(recent.messages);
  return {
    fixture: fixture.id,
    budgetEstimatedTokens: budgetTokens,
    recencyBudgetSlackTokens: slack,
    exactlyMatched: slack === 0,
    fullyAssessed: plan.outcome.skipped === 0 && !plan.failure,
    assessed: plan.outcome.assessed, unscored: plan.outcome.skipped,
    failure: plan.failure ?? null,
    scoringRequests: plan.requests, scoringInputTokens: plan.inputTokens, scoringOutputTokens: plan.outputTokens,
    models: [...new Set(plan.decisions.flatMap(d => d.model ? [d.model] : []))],
    jev: metrics(jevMessages, plan.dropped.size, jevElapsedMs),
    recency: metrics(recent.messages, recent.dropped.size, recentElapsedMs),
  };
}
