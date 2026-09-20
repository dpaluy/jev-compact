import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { eligibleItems, hash, type Plan } from "../src/core.js";
import { buildRequest, createJevScorer, isObject } from "../src/jev.js";
import { snapshotPi } from "../src/pi/adapter.js";
import { registerPruner } from "../src/pi/extension.js";
import { estimatePiUsage } from "../src/pi/usage.js";
import { estimatedTokens } from "./compare.js";

export interface ReplaySnapshot {
  id: string;
  cwd: string;
  systemPrompt: string;
  contextWindow: number;
  model?: { provider: string; id: string };
  // Newer Pi SDKs include system messages. Preserve them at runtime even when
  // this checkout's older AgentMessage type does not yet declare that role.
  messages: AgentMessage[];
  tools?: { name: string; description: string; parameters: unknown }[];
}

/** Input is captured context-hook snapshots, not a flattened session tree. This
 * preserves the caller's actual branch, compaction, tool and prompt boundaries.
 */
export function parseReplaySnapshots(raw: unknown): ReplaySnapshot[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("Expected a non-empty array of context snapshots");
  const validMessage = (message: unknown) => {
    if (!isObject(message)) return false;
    const blocks = Array.isArray(message.content) && message.content.every(block => isObject(block) && typeof block.type === "string");
    switch (message.role) {
      case "system": return (typeof message.content === "string" || blocks) &&
        (message.sections === undefined || isObject(message.sections) && Object.values(message.sections).every(value => value === null || typeof value === "string"));
      case "user": case "custom": return typeof message.content === "string" || blocks;
      case "assistant": return blocks;
      case "toolResult": return blocks && typeof message.toolCallId === "string" && typeof message.toolName === "string";
      case "branchSummary": case "compactionSummary": return typeof message.summary === "string";
      case "bashExecution": return typeof message.command === "string" && typeof message.output === "string";
      default: return false;
    }
  };
  for (const snapshot of raw) {
    if (!isObject(snapshot) || typeof snapshot.id !== "string" || !snapshot.id ||
      typeof snapshot.cwd !== "string" || typeof snapshot.systemPrompt !== "string" ||
      typeof snapshot.contextWindow !== "number" || !Number.isSafeInteger(snapshot.contextWindow) || snapshot.contextWindow <= 0 ||
      !Array.isArray(snapshot.messages) || !snapshot.messages.every(validMessage)) {
      throw new Error("Each snapshot needs id, cwd, systemPrompt, positive contextWindow, and Pi context messages");
    }
    if (snapshot.model !== undefined && (!isObject(snapshot.model) || typeof snapshot.model.provider !== "string" || typeof snapshot.model.id !== "string")) {
      throw new Error("Snapshot model needs provider and id");
    }
    if (snapshot.tools !== undefined && (!Array.isArray(snapshot.tools) || !snapshot.tools.every(tool =>
      isObject(tool) && typeof tool.name === "string" && typeof tool.description === "string" && isObject(tool.parameters)))) {
      throw new Error("Snapshot tools need name, description, and parameters");
    }
  }
  return raw as ReplaySnapshot[];
}

/** All assessment runs through the production scorer and context hook, with a
 * local transport that votes to drop every assessed pair. Reduction is an upper
 * bound for these snapshots, not Jev quality, provider usage, or a task rollout.
 * No files, credentials, tools, or external services are accessed by this function.
 */
export async function replaySnapshots(snapshots: ReplaySnapshot[], config: Config = { ...DEFAULT_CONFIG, enabled: true }) {
  if (!snapshots.length) throw new Error("At least one replay snapshot is required");
  type Hook = (event: any, ctx: ExtensionContext) => any;
  const hooks = new Map<string, Hook>();
  let current = snapshots[0]!;
  let requests = 0;
  let lastAudit: { inputHash: string; plan: Plan } | undefined;
  let audited = false;
  const scorer = createJevScorer({ ...config, apiKey: "offline-capacity-probe", fetch: async (_url, init) => {
    requests++;
    const request = JSON.parse(String(init?.body));
    return Response.json({
      model: "offline-capacity-probe", usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0 }])),
    });
  } });
  const ctx = {
    get cwd() { return current.cwd; },
    hasUI: true, ui: { notify() {} },
    get model() { return { ...(current.model ?? { id: "offline", provider: "offline" }), contextWindow: current.contextWindow }; },
    getContextUsage: () => undefined,
    getSystemPrompt: () => current.systemPrompt,
    sessionManager: { getSessionFile: () => "/offline/replay", getSessionId: () => "offline-replay" },
  } as unknown as ExtensionContext;
  registerPruner({
    registerFlag() {}, getFlag() {}, registerCommand() {},
    getActiveTools: () => (current.tools ?? []).map(tool => tool.name),
    getAllTools: () => current.tools ?? [],
    on: (name: string, hook: Hook) => hooks.set(name, hook),
  } as unknown as ExtensionAPI, {
    config, scorer, audit: async (_directory, run) => {
      audited = true;
      lastAudit = { inputHash: run.inputHash, plan: run.plan };
      return "offline-no-file";
    },
  });
  await hooks.get("session_start")!({}, ctx);
  const rows: {
    snapshot: string; eligible: number; assessed: number; skipped: number; newlyAssessed: number;
    dropped: number; skipReasons: Record<string, number>; outcome: string; reusedProjection: boolean;
    requests: number; scorerEnvelopeBytes: number; beforeBytes: number; afterBytes: number;
    beforeEstimatedTokens: number; afterEstimatedTokens: number; prefixRewritten: boolean; sharedPrefixEstimatedTokens: number;
  }[] = [];
  let previous: AgentMessage[] | undefined;
  let previousEnvelope: string | undefined;
  try {
    for (const snapshot of snapshots) {
      current = snapshot;
      audited = false;
      const beforeRequests = requests;
      const input = structuredClone(snapshot.messages);
      const analysis = snapshotPi(input, snapshot.systemPrompt, snapshot.cwd, config.preserveRecentMessages);
      const eligible = eligibleItems(analysis.items, config);
      const projected: { messages: AgentMessage[] } | undefined = await hooks.get("context")!({ messages: input }, ctx);
      const messages = projected?.messages ?? input;
      const inputHash = hash({ messages: input, systemPrompt: snapshot.systemPrompt });
      const plan = projected && lastAudit?.inputHash === inputHash ? lastAudit.plan : undefined;
      const reasons: Record<string, number> = {};
      const eligibleIds = new Set(eligible.map(item => item.id));
      if (plan) {
        for (const decision of plan.decisions) {
          if (eligibleIds.has(decision.itemId) && decision.scores === null) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
        }
      } else if (eligible.length) reasons[config.enabled ? "host-deferred" : "disabled"] = eligible.length;
      const tools = snapshot.tools ?? [];
      const envelope = hash({ systemPrompt: snapshot.systemPrompt, tools, model: snapshot.model, contextWindow: snapshot.contextWindow });
      let common = 0;
      if (previous && previousEnvelope === envelope) {
        while (common < previous.length && common < messages.length && hash(previous[common]) === hash(messages[common])) common++;
      }
      rows.push({
        snapshot: snapshot.id, eligible: eligible.length,
        assessed: plan?.outcome.assessed ?? 0, skipped: eligible.length - (plan?.outcome.assessed ?? 0),
        newlyAssessed: audited ? plan?.outcome.assessed ?? 0 : 0,
        dropped: plan?.dropped.size ?? 0, skipReasons: reasons,
        outcome: plan?.outcome.code ?? (config.enabled ? "host-deferred" : "disabled"),
        reusedProjection: Boolean(projected && plan && !audited), requests: requests - beforeRequests,
        scorerEnvelopeBytes: Buffer.byteLength(JSON.stringify(buildRequest(analysis.context, [], config.model))),
        beforeBytes: Buffer.byteLength(JSON.stringify(input)), afterBytes: Buffer.byteLength(JSON.stringify(messages)),
        beforeEstimatedTokens: estimatePiUsage(input, snapshot.systemPrompt, tools, snapshot.contextWindow).usedTokens!,
        afterEstimatedTokens: estimatePiUsage(messages, snapshot.systemPrompt, tools, snapshot.contextWindow).usedTokens!,
        prefixRewritten: previous !== undefined && (previousEnvelope !== envelope || common < previous.length),
        sharedPrefixEstimatedTokens: estimatedTokens(messages.slice(0, common)),
      });
      previous = messages;
      previousEnvelope = envelope;
    }
  } finally {
    await hooks.get("session_shutdown")!({}, ctx);
  }
  const sum = (key: "beforeBytes" | "afterBytes" | "beforeEstimatedTokens" | "afterEstimatedTokens" | "newlyAssessed") =>
    rows.reduce((total, row) => total + row[key], 0);
  return {
    mode: "offline-capacity-upper-bound", snapshots: rows.length, requests, newlyAssessed: sum("newlyAssessed"),
    cumulativeBeforeBytes: sum("beforeBytes"), cumulativeAfterBytes: sum("afterBytes"),
    cumulativeBeforeEstimatedTokens: sum("beforeEstimatedTokens"), cumulativeAfterEstimatedTokens: sum("afterEstimatedTokens"),
    prefixRewrites: rows.filter(row => row.prefixRewritten).length,
    totalSessionCostUsd: null, providerLatencyMs: null, cacheReadTokens: null,
    note: "Local drop-all transport, not Jev judgments. Token and prefix figures are estimates, not billed tokens or cache hits. Supplied snapshots keep original host compaction/recovery boundaries; no counterfactual summaries or task responses are generated.",
    rows,
  };
}
