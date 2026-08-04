import { ClosedQA, Factuality, Sql, Summary, type Score } from "autoevals";
import type { LanguageModel } from "ai";

import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";
import { createAutoevalsClient } from "#evals/autoevals-client.js";
import type { AssertionCollector } from "#evals/assertions/collector.js";
import { formatDiagnosticValue } from "#evals/diagnostics.js";
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

type GraderEvidence = {
  readonly label: "criteria" | "expected";
  readonly value: string;
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
    evidence: GraderEvidence,
    invoke: (
      params: { readonly input: string; readonly output: string } & GraderCall,
    ) => Score | Promise<Score>,
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
        const autoevalsError = result.error === undefined ? {} : { autoevalsError: result.error };
        const metadata = {
          ...result.metadata,
          ...autoevalsError,
          judge: formatLanguageModelGatewayId(model),
          input,
          output,
          [evidence.label]: evidence.value,
          autoevalsName: result.name,
        };
        return {
          score: result.score ?? 0,
          message: formatJudgeDetail(input, output, evidence, result),
          metadata,
        };
      },
    });
  }

  return {
    autoevals: {
      factuality: (expected, opts) =>
        grade(
          "judge.autoevals.factuality",
          opts,
          { label: "expected", value: expected },
          ({ input, output, model, modelOptions }) =>
            Factuality({ input, output, expected, ...client(model, modelOptions) }),
        ),
      summarizes: (expected, opts) =>
        grade(
          "judge.autoevals.summarizes",
          opts,
          { label: "expected", value: expected },
          ({ input, output, model, modelOptions }) =>
            Summary({ input, output, expected, ...client(model, modelOptions) }),
        ),
      closedQA: (criteria, opts) =>
        grade(
          "judge.autoevals.closedQA",
          opts,
          { label: "criteria", value: criteria },
          ({ input, output, model, modelOptions }) =>
            ClosedQA({ input, output, criteria, ...client(model, modelOptions) }),
        ),
      sql: (expected, opts) =>
        grade(
          "judge.autoevals.sql",
          opts,
          { label: "expected", value: expected },
          ({ input, output, model, modelOptions }) =>
            Sql({ input, output, expected, ...client(model, modelOptions) }),
        ),
    },
  };
}

function formatJudgeDetail(
  input: string,
  output: string,
  evidence: GraderEvidence,
  result: Score,
): string {
  const fields: [string, unknown][] = [
    ["prompt", input],
    [evidence.label, evidence.value],
    ["response", output],
  ];
  if (result.metadata?.rationale !== undefined) {
    fields.push(["rationale", result.metadata.rationale]);
  }
  if (result.metadata?.choice !== undefined) {
    fields.push(["choice", result.metadata.choice]);
  }
  if (result.error !== undefined) {
    fields.push(["autoevals error", result.error]);
  }
  return fields.map(([label, value]) => `${label}: ${formatDiagnosticValue(value)}`).join("\n");
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
