import { ClosedQA, Factuality, Sql, Summary } from "autoevals";
import type { LanguageModel } from "ai";

import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";
import { createAutoevalsClient } from "#evals/autoevals-client.js";
import type { AssertionCollector } from "#evals/assertions/collector.js";
import type { AssertionHandle, EveEvalJudgeConfig, JudgeContext, JudgeOpts } from "#evals/types.js";

/**
 * Dependencies the judge namespace closes over: where to record assertions,
 * how to resolve the default graded value (`t.reply`) and the original prompt
 * (the autoevals `input`), and the eval/config judge model.
 */
export interface JudgeDeps {
  readonly collector: AssertionCollector;
  readonly getReply: () => unknown;
  readonly getInput: () => string;
  readonly judge: EveEvalJudgeConfig | undefined;
}

/** Common model/client fields every autoevals grader call needs. */
type GraderCall = {
  readonly model: LanguageModel;
  readonly modelOptions: AgentModelOptionsDefinition | undefined;
};

/**
 * Builds the `t.judge` namespace bound to the resolved judge model. Each
 * grader records a soft assertion (override with `.atLeast`/`.gate`) that
 * fires the model call immediately; the collector awaits it before the
 * verdict.
 */
export function buildJudgeContext(deps: JudgeDeps): JudgeContext {
  function grade(
    name: string,
    opts: JudgeOpts | undefined,
    invoke: (
      params: { readonly input: string; readonly output: string } & GraderCall,
    ) => { readonly score: number | null } | Promise<{ readonly score: number | null }>,
  ): AssertionHandle {
    const value = opts?.on ?? deps.getReply();
    const output = String(value ?? "");
    const input = deps.getInput();
    const model = opts?.model ?? deps.judge?.model;
    const modelOptions = opts?.modelOptions ?? deps.judge?.modelOptions;

    return deps.collector.recordValue({
      name,
      severity: "soft",
      score: async () => {
        if (model === undefined) {
          throw new Error(
            `${name} needs a judge model. Set \`judge\` on the eval or in evals.config.ts, ` +
              "or pass { model } to the call.",
          );
        }
        const result = await invoke({ input, output, model, modelOptions });
        return {
          score: result.score ?? 0,
          metadata: { judge: formatLanguageModelGatewayId(model) },
        };
      },
    });
  }

  return {
    autoevals: {
      factuality: (expected, opts) =>
        grade("judge.autoevals.factuality", opts, ({ input, output, model, modelOptions }) =>
          Factuality({ input, output, expected, ...client(model, modelOptions) }),
        ),
      summarizes: (expected, opts) =>
        grade("judge.autoevals.summarizes", opts, ({ input, output, model, modelOptions }) =>
          Summary({ input, output, expected, ...client(model, modelOptions) }),
        ),
      closedQA: (criteria, opts) =>
        grade("judge.autoevals.closedQA", opts, ({ input, output, model, modelOptions }) =>
          ClosedQA({ input, output, criteria, ...client(model, modelOptions) }),
        ),
      sql: (expected, opts) =>
        grade("judge.autoevals.sql", opts, ({ input, output, model, modelOptions }) =>
          Sql({ input, output, expected, ...client(model, modelOptions) }),
        ),
    },
  };
}

type AutoevalsClientFields = {
  readonly model: string;
  readonly client: ReturnType<typeof createAutoevalsClient>;
};

/** Resolves the gateway model id and the AI-SDK-backed autoevals client. */
function client(
  model: LanguageModel,
  modelOptions: AgentModelOptionsDefinition | undefined,
): AutoevalsClientFields {
  return {
    model: formatLanguageModelGatewayId(model),
    client: createAutoevalsClient({
      languageModel: model,
      providerOptions: modelOptions?.providerOptions as Parameters<
        typeof createAutoevalsClient
      >[0]["providerOptions"],
    }),
  };
}
