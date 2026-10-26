// Question and answer shapes adapted from AI SDK 7.0.137 (Apache-2.0).
// eve owns these contracts; AI SDK remains the runtime validation boundary.
import type { HistoryMessage } from "#shared/history-message.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/** A model ID or an installed provider's decision model instance.
 * The installed AI SDK validates the model specification at runtime.
 * An identity object without a decision implementation is not a model.
 */
export type DecisionModel =
  | string
  | ({
      readonly provider: string;
      readonly modelId: string;
      readonly specificationVersion: string;
    } & (
      | { readonly doDecide: (...args: never[]) => unknown }
      | { readonly doEvaluate: (...args: never[]) => unknown }
    ));

/** Text, an object, or ordered multimodal parts shared by every question. */
export type DecisionState = string | JsonObject | readonly DecisionStatePart[];
type UserContent = Extract<HistoryMessage, { role: "user" }>["content"];
/** One text, file, or JSON part of shared decision state. */
export type DecisionStatePart =
  | Extract<Exclude<UserContent, string>[number], { type: "text" | "file" }>
  | { readonly type: "json"; readonly value: JsonValue };

/** Text or JSON used to describe a question or rubric entry. */
export type DecisionInput = string | JsonObject | readonly JsonValue[];
/** One independently answered choice, ordered score, or probability question. */
export type DecisionQuestion =
  | {
      readonly type: "choice";
      readonly instructions: DecisionInput;
      readonly criteria: Readonly<Record<string, DecisionInput | null>>;
    }
  | {
      readonly type: "score";
      readonly instructions: DecisionInput;
      readonly criteria: readonly (DecisionInput | null)[];
    }
  | {
      readonly type: "boolean";
      readonly instructions: DecisionInput;
      readonly criteria?: {
        readonly true?: DecisionInput | null;
        readonly false?: DecisionInput | null;
      };
    };

/** Answer inferred from the authored question and its choice keys. */
export type DecisionAnswer<Q extends DecisionQuestion> = Q extends {
  type: "choice";
  criteria: infer Criteria;
}
  ? {
      readonly type: "choice";
      readonly choice: Extract<keyof Criteria, string>;
      readonly probabilities?: Readonly<Record<Extract<keyof Criteria, string>, number>>;
    }
  : Q extends { type: "score" }
    ? {
        readonly type: "score";
        readonly score: number;
        readonly probabilities?: Readonly<Record<string, number>>;
      }
    : { readonly type: "boolean"; readonly probability: number };

/** Typed answers and normalized token usage; provider metadata stays internal. */
export interface DecisionResult<Questions extends Readonly<Record<string, DecisionQuestion>>> {
  readonly answers: { readonly [Id in keyof Questions]: DecisionAnswer<Questions[Id]> };
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly totalTokens: number | undefined;
  };
}

/** Stable options accepted by eve's standalone decision API. */
export interface DecisionOptions<Questions extends Readonly<Record<string, DecisionQuestion>>> {
  /** Defaults to TypeSafe Jev, using eve's normal model authentication. */
  readonly model?: DecisionModel;
  readonly state: DecisionState;
  readonly questions: Questions;
  /** Maximum retries for transient provider failures. Defaults to 2. */
  readonly maxRetries?: number;
  readonly signal?: AbortSignal;
}
