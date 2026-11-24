import type { SystemModelMessage, ToolSet } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type {
  CompactionCallRequest,
  CompactionCallResult,
  CompactionContext,
  CompactionStrategy,
} from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

export type RequestInstructions = string | SystemModelMessage | SystemModelMessage[] | undefined;

export interface RequestPrefix {
  readonly instructions: RequestInstructions;
  readonly tools?: ToolSet;
}

export interface StrategyRun extends Pick<
  CompactionContext,
  "abortSignal" | "estimateRatio" | "fixedTokens" | "overflow" | "recompacting" | "requested"
> {
  readonly model: Pick<CompactionContext["model"], "contextWindowTokens" | "maxOutputTokens">;
  readonly sessionId: string;
  call(request: CompactionCallRequest): Promise<CompactionCallResult>;
  identity(): Promise<Pick<CompactionContext["model"], "provider" | "modelId">>;
}

export function strategyHistory(
  strategy: CompactionStrategy,
  run: StrategyRun,
): (input: {
  readonly history: readonly HarnessModelMessage[];
  readonly tokens: number;
}) => Promise<readonly HarnessModelMessage[] | undefined> {
  return async ({ history, tokens }) => {
    if (run.requested && run.overflow) {
      throw new Error("A compaction is either requested or an overflow retry, never both.");
    }
    const ctx: CompactionContext = {
      abortSignal: run.abortSignal,
      call: (request) => run.call(request),
      estimate: (messages: readonly StoredHistoryMessage[]) =>
        estimateTokens(messages as HarnessModelMessage[]),
      estimateRatio: run.estimateRatio,
      fixedTokens: run.fixedTokens,
      model: { ...run.model, ...(await run.identity()) },
      overflow: run.overflow,
      recompacting: run.recompacting,
      requested: run.requested,
      session: { id: run.sessionId },
      tokens,
    };
    return (await strategy(cloneValue(history) as StoredHistoryMessage[], ctx)) as
      | readonly HarnessModelMessage[]
      | undefined;
  };
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value instanceof URL) return new URL(value.href) as T;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
  ) as T;
}
