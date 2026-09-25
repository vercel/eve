import type { Harness } from "../../core/harness.ts";
import { prepareCliBundle } from "./prepare.ts";
import { readCliUsage } from "./usage.ts";
import {
  GATEWAY_BASE_URL,
  shellQuote,
  validateModel,
  validateOptions,
  type CliName,
  type CliOptions,
} from "./plan.ts";

export function createCliHarness(
  name: "hermes" | "pi" | "opencode" | "codex",
  options: { version: string; baseUrl?: string; reasoning?: string },
): Harness {
  const supported = validateOptions(name, options);
  const pinned = { ...options };
  return {
    name: `${name}@${pinned.version}`,
    credentials: ["AI_GATEWAY_API_KEY"],
    prepare: async (ctx) => {
      validateModel(ctx.model);
      const bundle = await prepareCliBundle(supported, pinned, ctx);
      return {
        ...bundle,
        provenance: {
          ...bundle.provenance,
          model: ctx.model,
          baseUrl: pinned.baseUrl ?? GATEWAY_BASE_URL,
          reasoning: pinned.reasoning ?? null,
          protocol: supported === "codex" ? "responses" : "chat-completions",
        },
      };
    },
    command: (ctx) =>
      `exec ${shellQuote(`${ctx.installDir}/arch/node`)} ${shellQuote(`${ctx.installDir}/runner.ts`)}`,
    readUsage: (agentLogsDir) => readCliUsage(supported, agentLogsDir),
    env: (ctx) => {
      validateModel(ctx.model);
      return {
        EVE_BENCH_CLI_NAME: name,
        EVE_BENCH_CLI_OPTIONS: JSON.stringify(pinned),
        EVE_BENCH_CLI_CONTEXT: JSON.stringify(ctx),
      };
    },
  };
}

export type { CliName, CliOptions };
