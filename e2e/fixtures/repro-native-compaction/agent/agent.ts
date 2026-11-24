import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineAgent, type DefinedAgent } from "eve";
import { openaiCompaction, type CompactionRewrite } from "eve/compaction";
import { openai } from "eve/models/openai";

const arm = process.env.COMPACTION_ARM ?? "native";
if (arm !== "text" && arm !== "native") {
  throw new Error(`COMPACTION_ARM must be "text" or "native", got "${arm}".`);
}

function record(entry: unknown): void {
  const dir = process.env.REPRO_OUT;
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "compaction.jsonl"), `${JSON.stringify(entry)}\n`);
}

function estimate(value: unknown, keepEncrypted: boolean): number {
  const json = JSON.stringify(value, (key, candidate: unknown) =>
    !keepEncrypted && key === "encryptedContent" ? undefined : candidate,
  );
  return Math.ceil(Buffer.byteLength(json ?? "") / 4);
}

const native = openaiCompaction();

const measuredNative: CompactionRewrite = async (history, ctx) => {
  const result = await native(history, ctx);
  record({
    arm,
    reason: ctx.reason,
    historyMessages: history.length,
    historyEstimatedTokens: estimate(history, false),
    result:
      result === undefined
        ? "unchanged"
        : {
            messages: result.map((message) => ({
              role: message.role,
              kind: (message as { kind?: unknown }).kind,
              parts: Array.isArray(message.content)
                ? message.content.map((part) => (part as { type?: string }).type)
                : "text",
            })),
            estimatedTokensWithoutEncryptedContent: estimate(result, false),
            estimatedTokensIfEncryptedContentWereText: estimate(result, true),
          },
  });
  return result;
};

const model = process.env.REPRO_MODEL ?? "gpt-6.1-sol";

const agent: DefinedAgent = defineAgent({
  model: openai(model),
  reasoning: "medium",
  modelOptions:
    process.env.REPRO_STORE === "false"
      ? { providerOptions: { openai: { store: false } } }
      : undefined,
  modelContextWindowTokens: 272_000,
  compaction: arm === "native" ? { threshold: 0.35, compact: measuredNative } : { threshold: 0.35 },
});

export default agent;
