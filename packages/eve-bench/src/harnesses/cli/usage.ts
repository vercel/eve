import { join } from "node:path";

import type { Usage } from "../../core/result.ts";
import { count, readJsonlUsage, record, type UsageRecord } from "../../core/usage.ts";
import type { SupportedCliName } from "./plan.ts";

/** Reads usage from the native JSON event stream the runner saves as `<name>.jsonl`. */
export function readCliUsage(
  name: SupportedCliName,
  agentLogsDir: string,
): Promise<Usage | undefined> {
  return readJsonlUsage(join(agentLogsDir, `${name}.jsonl`), CLI_USAGE[name]);
}

export const CLI_USAGE: Record<SupportedCliName, (event: unknown) => UsageRecord | undefined> = {
  // pi --mode json: one assistant `message_end` per model call; `input` excludes cache reads.
  pi(event) {
    const value = record(event);
    const message = record(value.message);
    if (value.type !== "message_end" || message.role !== "assistant") return undefined;
    const usage = record(message.usage);
    const cached = count(usage.cacheRead);
    return {
      input: count(usage.input) + cached,
      output: count(usage.output),
      cached,
      cost: count(record(usage.cost).total),
    };
  },
  // opencode run --format=json: one `step_finish` per model call; reasoning is reported apart from output.
  opencode(event) {
    const value = record(event);
    if (value.type !== "step_finish") return undefined;
    const part = record(value.part);
    const tokens = record(part.tokens);
    const cached = count(record(tokens.cache).read);
    return {
      input: count(tokens.input) + cached,
      output: count(tokens.output) + count(tokens.reasoning),
      cached,
      cost: count(part.cost),
    };
  },
  // codex exec --json: one `turn.completed` per turn; input_tokens already include cached input.
  codex(event) {
    const value = record(event);
    if (value.type !== "turn.completed") return undefined;
    const usage = record(value.usage);
    return {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cached: count(usage.cached_input_tokens),
    };
  },
};
