import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_POLICY, planPrune, type Scorer } from "../src/core.js";
import { snapshotPi } from "../src/pi/adapter.js";
import type { Fixture } from "./fixtures.js";

function texts(messages: AgentMessage[]): string[] {
  return messages.flatMap(message => {
    if (!("content" in message)) return [];
    if (typeof message.content === "string") return [message.content];
    return message.content.filter(block => block.type === "text").map(block => block.text);
  });
}

export function measureRetention(fixture: Fixture, messages: AgentMessage[]) {
  const retained = fixture.constraints.filter(constraint => {
    const source = constraint.source === "tool"
      ? messages.filter(message => message.role === "toolResult" && message.toolCallId === constraint.itemId.slice("tool:".length))
      : messages.filter(message => {
        const original = fixture.messages[Number(constraint.itemId.slice("message:".length))];
        return message.role === "user" && JSON.stringify(message) === JSON.stringify(original);
      });
    return texts(source).some(text => text.includes(constraint.text));
  });
  return {
    retained: retained.length, constraints: fixture.constraints.length,
    toolConstraintsRetained: retained.filter(c => c.source === "tool").length,
    toolConstraints: fixture.constraints.filter(c => c.source === "tool").length,
  };
}

export async function evaluate(fixture: Fixture, scorer: Scorer) {
  const snapshot = snapshotPi(fixture.messages, "Preserve all task requirements verbatim.", "/work/rubric_llm", 2);
  const plan = await planPrune(snapshot.items, snapshot.context, scorer, DEFAULT_POLICY);
  const messages = snapshot.apply(plan.dropped);
  const beforeBytes = Buffer.byteLength(JSON.stringify(fixture.messages));
  const afterBytes = Buffer.byteLength(JSON.stringify(messages));
  return {
    fixture: fixture.id, ...measureRetention(fixture, messages),
    beforeBytes, afterBytes, byteReduction: 1 - afterBytes / beforeBytes,
    droppedTraces: plan.dropped.size, scoringRequests: plan.requests,
    scoringInputTokens: plan.inputTokens, scoringOutputTokens: plan.outputTokens,
    models: [...new Set(plan.decisions.flatMap(d => d.model ? [d.model] : []))],
    unscored: plan.outcome.skipped,
    failure: plan.failure ?? null,
  };
}
