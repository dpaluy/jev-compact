import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { assistant, call, result, user } from "../test/helpers.js";

export interface Fixture {
  id: string;
  messages: AgentMessage[];
  constraints: { source: "user" | "tool"; itemId: string; text: string }[];
  requiredTraceId: string;
}

// Hand-authored workloads based on public API names and rules inspected in rubric_llm.
// These are not captured user sessions. Labels never enter the scoring request.
const cases = [
  ["env-prohibition", "Never edit .env.", "Never serialize typesafe_api_key without redaction."],
  ["exact-error", "Preserve configuration error messages exactly.", "RUBRIC_CASCADE_NOUL_BAND must contain two comma-separated numbers"],
  ["source-path", "Keep the System One client path available.", "lib/rubric_llm/system_one/client.rb"],
  ["api-shape", "Do not change the judge call interface.", "def call(state:, questions:)"],
  ["offline-tests", "Tests must not make network calls.", "Stub LLM behavior through RubyLLMStub."],
  ["retry-contract", "Keep retry handling bounded.", "max_retries must be a non-negative integer"],
  ["backend-values", "Do not rename the supported backends.", "BACKENDS = %i[chat system_one cascade].freeze"],
  ["range-contract", "Preserve inclusive probability bounds.", "cascade_noul_band must be an inclusive range between 0.0 and 1.0"],
  ["style-guidance", "Use Minitest only.", "Use Ruby 3.4+ syntax and keep files # frozen_string_literal: true."],
  ["question-ids", "Reject duplicate question identifiers.", "System One question ids must be unique"],
] as const;

export function fixtures(): Fixture[] {
  return cases.map(([id, instruction, fact], i) => {
    const requiredTraceId = `${id}-required`;
    const messages: AgentMessage[] = [user(`Work on RubricLLM. ${instruction}`)];
    const addNoise = (n: number) => {
      const traceId = `${id}-noise-${n}`;
      messages.push(assistant([call(traceId, { path: "tmp/old-progress.log" })]), result(traceId, "Old completed progress: no work pending.\n".repeat(80)));
    };
    addNoise(0); addNoise(1);
    messages.push(assistant([call(requiredTraceId, { path: i === 8 ? "AGENTS.md" : "lib/rubric_llm/contract.rb" })]),
      result(requiredTraceId, `Relevant reference for this task:\n${fact}\nPreserve this contract in the fix.`));
    addNoise(2); addNoise(3);
    messages.push(user("Continue the fix. Keep the relevant contract available verbatim."));
    return { id, messages, requiredTraceId,
      constraints: [
        { source: "user", itemId: "message:0", text: instruction },
        { source: "tool", itemId: `tool:${requiredTraceId}`, text: fact },
      ],
    };
  });
}

/** Equalize pair sizes so recency cannot identify the required trace just because
 * it is the only small result. These remain synthetic, labeled contract checks.
 */
export function comparisonFixtures(): Fixture[] {
  return fixtures().map(fixture => {
    const pairs = fixture.messages.flatMap((message, index) => message.role === "toolResult"
      ? [{ call: fixture.messages[index - 1]!, result: message }] : []);
    const target = Math.max(...pairs.map(pair => estimateTokens(pair.call) + estimateTokens(pair.result)));
    for (const pair of pairs) {
      const block = pair.result.content[0];
      if (block?.type !== "text") throw new Error("Comparison fixtures require text results");
      const paddingTokens = target - estimateTokens(pair.call) - estimateTokens(pair.result);
      block.text += " ".repeat(paddingTokens * 4);
    }
    return fixture;
  });
}
