/*! Field and answer shapes adapted from AI SDK 7.0.176 (Apache-2.0). */
import type { HistoryMessage } from "#shared/history-message.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/** A model ID or an installed provider's extraction model instance.
 * AI SDK 7 extraction models implement specification `v4`; the installed AI SDK
 * validates the full model contract at runtime. An identity object without an
 * extraction implementation is not a model.
 */
export type ExtractionModel =
  | string
  | {
      readonly provider: string;
      readonly modelId: string;
      readonly specificationVersion: "v4";
      readonly supportedFieldTypes: readonly string[];
      readonly doExtract: (...args: never[]) => unknown;
    };

/** Text, an object, or ordered multimodal parts to extract every field from. */
export type ExtractionState = string | JsonObject | readonly ExtractionStatePart[];
type UserContent = Extract<HistoryMessage, { role: "user" }>["content"];
/** One text, file, or JSON part of extraction state. */
export type ExtractionStatePart =
  | Extract<Exclude<UserContent, string>[number], { type: "text" | "file" }>
  | { readonly type: "json"; readonly value: JsonValue };

/** Text or JSON that describes what a field should contain. */
export type ExtractionInput = string | JsonObject | readonly JsonValue[];
/** Unit a duration field's value is expressed in. */
export type ExtractionDurationUnit =
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "weeks"
  | "months"
  | "years";

/** One typed value to extract from the state. */
export type ExtractionField =
  | {
      /** Free text, returned as a string. */
      readonly type: "text";
      readonly instructions?: ExtractionInput | null;
    }
  | {
      /** A finite number. */
      readonly type: "number";
      readonly instructions?: ExtractionInput | null;
      /** Unit the value is expressed in, such as `"USD"` or `"kg"`. */
      readonly unit?: string;
      readonly integer?: boolean;
      /** Maximum decimal places, an integer from 0 to 6. */
      readonly decimals?: number;
    }
  | {
      /** A calendar date, returned as `YYYY-MM-DD`. */
      readonly type: "date";
      readonly instructions?: ExtractionInput | null;
    }
  | {
      /** A time of day, returned as `HH:MM` or `HH:MM:SS`. */
      readonly type: "time";
      readonly instructions?: ExtractionInput | null;
    }
  | {
      /** An ISO 8601 date and time, with an offset when the state has one. */
      readonly type: "datetime";
      readonly instructions?: ExtractionInput | null;
    }
  | {
      /** A nonnegative length of time, returned as a number in `unit`. */
      readonly type: "duration";
      readonly instructions?: ExtractionInput | null;
      /** Defaults to `"seconds"`. */
      readonly unit?: ExtractionDurationUnit;
      readonly integer?: boolean;
      /** Maximum decimal places, an integer from 0 to 6. */
      readonly decimals?: number;
    }
  | {
      /** Zero or more values of one item type. */
      readonly type: "list";
      readonly instructions?: ExtractionInput | null;
      readonly items: "text" | "number" | "date";
      /** Requires integer items. Applies only to number items. */
      readonly integer?: boolean;
      /** Maximum decimal places for number items, an integer from 0 to 6. */
      readonly decimals?: number;
    };

/**
 * Where in the state a value was found. `part` indexes the state's parts; a string or object
 * state is part 0. Text offsets count UTF-16 code units, with `end` exclusive.
 */
export type ExtractionSource =
  | {
      readonly type: "text";
      readonly part: number;
      readonly start: number;
      readonly end: number;
    }
  | { readonly type: "file"; readonly part: number };

/** The value type a field extracts. */
export type ExtractionValue<F extends ExtractionField> = F extends {
  type: "number" | "duration";
}
  ? number
  : F extends { type: "list"; items: infer Items }
    ? Items extends "number"
      ? number[]
      : string[]
    : string;

/** Answer for one field, typed from the authored field. `value` is `null` when the state has no value. */
export type ExtractionAnswer<F extends ExtractionField> = F extends { type: "list" }
  ? {
      readonly type: "list";
      readonly value: ExtractionValue<F> | null;
      /** Probability from 0 to 1 that the state has no value. */
      readonly pNull?: number;
      /** Confidence from 0 to 1 that `value` is correct. */
      readonly confidence?: number;
      /** One entry per item in `value`, when the model reports them. */
      readonly items?: readonly {
        readonly confidence?: number;
        readonly source?: ExtractionSource;
      }[];
    }
  : {
      readonly type: F["type"];
      readonly value: ExtractionValue<F> | null;
      /** Most likely value, also when `value` is `null`. */
      readonly guess?: ExtractionValue<F>;
      /** Probability from 0 to 1 that the state has no value. */
      readonly pNull?: number;
      /** Confidence from 0 to 1 that `value` is correct. */
      readonly confidence?: number;
      readonly source?: ExtractionSource;
    };

/** Typed answers and normalized token usage; provider metadata stays internal. */
export interface ExtractionResult<Fields extends Readonly<Record<string, ExtractionField>>> {
  readonly answers: { readonly [Id in keyof Fields]: ExtractionAnswer<Fields[Id]> };
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly totalTokens: number | undefined;
  };
}

/** Stable options accepted by eve's standalone extraction API. */
export interface ExtractionOptions<Fields extends Readonly<Record<string, ExtractionField>>> {
  /** An extraction model ID, such as `scaledown/extract-1`, or a provider's extraction model. */
  readonly model: ExtractionModel;
  readonly state: ExtractionState;
  readonly fields: Fields;
  /** `YYYY-MM-DD` date that anchors relative dates and dates without a year. */
  readonly referenceDate?: string;
  /** Maximum retries for transient provider failures. Defaults to 2. */
  readonly maxRetries?: number;
  readonly signal?: AbortSignal;
  /** Provider-specific options, keyed by provider. */
  readonly providerOptions?: Record<string, JsonObject>;
}
