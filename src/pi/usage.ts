import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, type ContextUsage } from "@earendil-works/pi-coding-agent";
import type { HostContextUsage } from "../scheduler.js";

/** Recount the actual outgoing snapshot, not the last (possibly pruned) request. */
export function estimatePiUsage(
  messages: readonly AgentMessage[], systemPrompt: string, tools: readonly unknown[],
  contextWindow: number | undefined, reported?: ContextUsage,
): HostContextUsage {
  const capacity = contextWindow ?? reported?.contextWindow;
  if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) {
    return { capacityTokens: null, usedTokens: null, source: "unknown" };
  }
  // Match Pi's character-based estimator; overhead is an estimate, not billed tokens.
  const overhead = Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4);
  const snapshotTokens = messages.reduce((sum, message) => sum + estimateTokens(message), overhead);
  // Reported usage may include provider overhead, but must never hide restored traces.
  const previousTokens = reported?.contextWindow === capacity && Number.isFinite(reported.tokens)
    ? Math.max(0, reported.tokens ?? 0) : 0;
  return { capacityTokens: capacity, usedTokens: Math.max(snapshotTokens, previousTokens), source: "estimated" };
}
