import { e2eAgentConfig, e2eModel } from "@eve-e2e/config";
import { defineAgent, type DefinedAgent } from "eve";
import type { CompactionStrategy } from "eve/compaction";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import { codeOf, CONTEXT_WINDOW_TOKENS, FILES, SCALE, type StrategyName } from "../constants";
import { codexCompaction, COMPACT_USER_MESSAGE_MAX_TOKENS } from "../strategies/codex";
import { opencodeCompaction, OUTPUT_TOKEN_MAX } from "../strategies/opencode";

const strategies: Record<StrategyName, CompactionStrategy | undefined> = {
  codex: codexCompaction({ userMessageBudget: COMPACT_USER_MESSAGE_MAX_TOKENS * SCALE }),
  default: undefined,
  // The declared window hides the model's output limit, so reserve opencode's 32k cap, scaled.
  opencode: opencodeCompaction({ reserved: OUTPUT_TOKEN_MAX * SCALE }),
};
const strategy = strategies[(process.env.EVE_COMPACTION_STRATEGY ?? "default") as StrategyName];

/** Plays the replay without a provider: reads the file each turn asks for, then answers. */
function respond(request: MockModelRequest): MockModelResponse | string {
  const conversation = request.messages.map((message) => message.text).join("\n");
  const last = request.messages.at(-1);
  if (last?.role === "user" && /summar/i.test(last.text)) {
    const code = codeOf(FILES[0]!);
    return `Alice is reviewing project files.${conversation.includes(code) ? ` The access code in ${FILES[0]} is ${code}.` : ""}`;
  }
  const asked = request.lastUserMessage ?? "";
  const file = /^Read (\S+) with read-file/.exec(asked)?.[1];
  if (file !== undefined) {
    return last?.role === "tool" ? "done" : { toolCalls: [{ input: { file }, name: "read-file" }] };
  }
  const code = codeOf(FILES[0]!);
  if (conversation.includes(code)) return code;
  // Like a model that lost the fact: read the file again, then give up if that didn't help.
  return last?.role === "tool"
    ? "CODE_LOST"
    : { toolCalls: [{ input: { file: FILES[0] }, name: "read-file" }] };
}

const agent: DefinedAgent = defineAgent({
  ...e2eAgentConfig(),
  model: process.env.EVE_E2E_MODEL === "mock" ? mockModel({ respond }) : e2eModel(),
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  compaction: strategy === undefined ? { threshold: 0.6 } : { compact: strategy, threshold: 0.6 },
});

export default agent;
