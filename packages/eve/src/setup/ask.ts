// The single ask channel of the setup contract. A box owns data acquisition
// and control flow; every user interaction is a Question value sent through
// one injected Asker.
//
// The Asker is a pure capability in exactly Prompter's architectural slot:
// constructed once per command, injected at box composition time, carrying no
// flow knowledge. The resolution ladder is NOT inside the capability; it is a
// stack of decorators the flow composes around a base:
//
//   withAnswers(flags)(withPolicy("confirm-detected")(interactiveAsker(prompter)))
//   withAnswers(agentArgs)(headlessAsker())
//   withPolicy("assume")(headlessAsker())
//
// Boxes only ever see `Asker`. Policies are presence/absence of decorators,
// which also unlocks combinations a monolithic factory could not express.

import type { Prompter } from "./prompter.js";

/** One choice in a select question. */
export interface SelectOption<T> {
  /** Stable handle so external answers (flags, JSON) can address rich values. */
  id: string;
  label: string;
  value: T;
  hint?: string;
  /**
   * A leading run of featured options forms a searchable picker's default
   * viewport: with no filter typed, only they are in view, and scrolling or
   * filtering reaches the rest of the list. Featured options must be sorted
   * to the front. Meaningless without `search`.
   */
  featured?: boolean;
}

/**
 * One choice in a multi-select question. Row availability is part of the
 * question, not the renderer: an interactive picker renders the reason next to
 * the row, and {@link withAnswers} enforces the same semantics on external
 * answers (a disabled id is refused with its reason, a locked value is part of
 * every answer whether or not it was named).
 */
export interface MultiSelectOption<T> extends SelectOption<T> {
  /** Visible and explained but not pickable. Mutually exclusive with `locked`. */
  disabled?: boolean;
  /** Why the row is disabled; shown by pickers and quoted by answer refusals. */
  disabledReason?: string;
  /** Always selected and cannot be toggled off. */
  locked?: boolean;
  /** Why the row is locked; shown by pickers (e.g. "always available"). */
  lockedReason?: string;
}

/**
 * A keyed question a box sends through the channel. The key is the question's
 * stable identity: decorators match pre-supplied answers and requiredness
 * opt-ins against it, and resolutions are announced under it.
 */
export type Question<T> = {
  key: string;
  message: string;
  /** Found in the world (e.g. an on-disk link). Feeds the confirm/assume rungs. */
  detected?: T;
  /** A safe assumption (e.g. the most popular model). Used by "assume". */
  recommended?: T;
  /**
   * Questions are skippable by default; required is the opt-in. Headless and
   * assume runs auto-skip non-required questions, and only a required question
   * may refuse a headless run ({@link InteractionRequired}). Set by the box
   * when intrinsic, or by the flow via {@link withRequired}.
   */
  required?: boolean;
  /**
   * Synthesized by a decorator (e.g. the confirm-detected rung): interaction
   * mechanics, not a box value, so bases render it but do not announce it.
   */
  internal?: boolean;
} & (
  | {
      kind: "select";
      options: readonly SelectOption<T>[];
      // Presentation hints, not semantics: interactive renderers forward them
      // to the picker, every other asker ignores them. They exist so a
      // migrated box keeps rendering exactly as its hand-written prompt did.
      /** Offer the type-ahead filter line in interactive renderers. */
      search?: boolean;
      /** Placeholder for the filter line while it is empty. */
      placeholder?: string;
    }
  | { kind: "confirm" }
  | {
      kind: "text";
      validate?: (raw: string) => string | null;
      sensitive?: boolean;
      /** Presentation hint: ghost text shown while the input is empty. */
      placeholder?: string;
    }
);

/**
 * A keyed multi-select question. Its answer is a set (`T[]`) while its options
 * carry single values (`T`), so it travels through the paired
 * {@link Asker.askMany} instead of being a {@link Question} kind: forcing it
 * through `ask<T>` would make the channel lie about the answer type.
 */
export interface MultiSelectQuestion<T> {
  key: string;
  message: string;
  options: readonly MultiSelectOption<T>[];
  /** Found in the world. Feeds the confirm/assume rungs and pre-marks pickers. */
  detected?: readonly T[];
  /** A safe assumption. Used by "assume"; pre-marks pickers without a detection. */
  recommended?: readonly T[];
  /** Same opt-in as {@link Question.required}: only it may refuse a headless run. */
  required?: boolean;
  /** Same as {@link Question.internal}: rendered but never announced. */
  internal?: boolean;
  // Presentation hints, not semantics (see the select kind in Question).
  /**
   * Block an empty submission in interactive pickers. Distinct from `required`,
   * which is the headless-refusal opt-in: a question can refuse to be skipped
   * headlessly while still accepting an empty interactive selection.
   */
  requireSelection?: boolean;
  /** Offer the type-ahead filter line in interactive renderers. */
  search?: boolean;
  /** Placeholder for the filter line while it is empty. */
  placeholder?: string;
}

/** Builds a select question without spelling the discriminant at call sites. */
export const select = <T>(
  q: Omit<Extract<Question<T>, { kind: "select" }>, "kind">,
): Question<T> => ({
  ...q,
  kind: "select",
});

/** Builds a confirm question without spelling the discriminant at call sites. */
export const confirm = (q: {
  key: string;
  message: string;
  detected?: boolean;
  recommended?: boolean;
  required?: boolean;
  internal?: boolean;
}): Question<boolean> => ({
  ...q,
  kind: "confirm",
});

/** Builds a text question without spelling the discriminant at call sites. */
export const text = (q: {
  key: string;
  message: string;
  detected?: string;
  recommended?: string;
  required?: boolean;
  validate?: (raw: string) => string | null;
  sensitive?: boolean;
  placeholder?: string;
}): Question<string> => ({ ...q, kind: "text" });

/** The capability boxes see. Pure and flow-agnostic: Prompter's successor. */
export interface Asker {
  ask<T>(question: Question<T>): Promise<T>;
  /**
   * The multi-select channel. Paired with {@link ask} instead of being a
   * question kind because the answer type (`T[]`) differs from the option type
   * (`T`); every rung treats it with the same ladder semantics as `ask`.
   */
  askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]>;
}

/** A ladder rung: wraps an asker and resolves (or rewrites) some questions. */
export type AskerDecorator = (inner: Asker) => Asker;

// Channel-level outcomes are signals, not return values: they must cross every
// box unchanged so the driver (CLI, agent loop) can react with full context.
// Domain failures stay values in each box's output union. User cancellation
// already has a repo-wide signal, WizardCancelledError in step.ts, which the
// interactive prompter throws and the runner folds; the channel lets it
// propagate instead of introducing a second cancel signal.

/** Thrown when a skippable question is skipped, so the box can branch on it. */
export class SkippedSignal extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Skipped: ${key}`);
    this.name = "SkippedSignal";
    this.key = key;
  }
}

/** Any question the channel can carry, for signals that quote one. */
export type AnyQuestion = Question<unknown> | MultiSelectQuestion<unknown>;

/**
 * Headless refusal that keeps the whole question: an agent driver can relay
 * exactly what is missing (key, message, options) instead of a bare string.
 */
export class InteractionRequired extends Error {
  readonly question: AnyQuestion;
  constructor(question: AnyQuestion) {
    super(`Interaction required for "${question.key}": ${question.message}`);
    this.name = "InteractionRequired";
    this.question = question;
  }
}

/** Thrown when a pre-supplied answer fails the question's own validation. */
export class InvalidAnswerError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "InvalidAnswerError";
    this.key = key;
  }
}

/** How a question got its value, so nothing is silently assumed. */
export type ResolutionSource = "answer" | "detected" | "assumed" | "asked" | "skipped";

/** One announced question outcome. */
export interface Resolution {
  key: string;
  value: unknown;
  source: ResolutionSource;
}

/** Every resolution is announced with its source: nothing is silently assumed. */
export interface AskerEvents {
  onResolved?: (resolution: Resolution) => void;
}

function announce<T>(
  events: AskerEvents | undefined,
  key: string,
  value: T,
  source: ResolutionSource,
): T {
  events?.onResolved?.({ key, value, source });
  return value;
}

function coerceAnswer<T>(question: Question<T>, raw: unknown): T {
  if (question.kind === "select") {
    const id = String(raw);
    const match = question.options.find((option) => option.id === id);
    if (!match) {
      const ids = question.options.map((option) => option.id).join(", ");
      throw new InvalidAnswerError(
        question.key,
        `Invalid answer for "${question.key}": ${id}. Expected one of: ${ids}.`,
      );
    }
    return match.value;
  }
  if (question.kind === "confirm") {
    const value =
      typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : null;
    if (value === null) {
      throw new InvalidAnswerError(
        question.key,
        `Invalid answer for "${question.key}": expected a boolean.`,
      );
    }
    return value as T;
  }
  const value = String(raw);
  const problem = question.validate?.(value);
  if (problem) throw new InvalidAnswerError(question.key, problem);
  return value as T;
}

/**
 * Coerces an external multi-select answer (an array of option ids) into the
 * rich values. The question's row availability is enforced here because an
 * external answer bypasses the picker that would otherwise enforce it: a
 * disabled id is refused with its reason, and locked values join the answer
 * whether or not they were named, exactly as the picker always returns them.
 */
function coerceManyAnswer<T>(question: MultiSelectQuestion<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) {
    throw new InvalidAnswerError(
      question.key,
      `Invalid answer for "${question.key}": expected an array of option ids.`,
    );
  }
  const values: T[] = [];
  for (const item of raw) {
    const id = String(item);
    const match = question.options.find((option) => option.id === id);
    if (!match) {
      const ids = question.options.map((option) => option.id).join(", ");
      throw new InvalidAnswerError(
        question.key,
        `Invalid answer for "${question.key}": ${id}. Expected one of: ${ids}.`,
      );
    }
    if (match.disabled) {
      const reason = match.disabledReason === undefined ? "" : ` (${match.disabledReason})`;
      throw new InvalidAnswerError(
        question.key,
        `Invalid answer for "${question.key}": ${id} is unavailable${reason}.`,
      );
    }
    if (!values.includes(match.value)) values.push(match.value);
  }
  for (const option of question.options) {
    if (option.locked === true && !values.includes(option.value)) values.push(option.value);
  }
  return values;
}

// Base askers: the terminal rung of any stack.

async function renderQuestion<T>(prompter: Prompter, question: Question<T>): Promise<T> {
  if (question.kind === "select") {
    const preselected = question.detected ?? question.recommended;
    // The prompter speaks primitive option values, so the rendered option is
    // the id; coerceAnswer maps the chosen id back to the rich value.
    const chosen = await prompter.select<string>({
      message: question.message,
      options: question.options.map((option) => ({
        value: option.id,
        label: option.label,
        hint: option.hint,
        featured: option.featured,
      })),
      initialValue:
        preselected === undefined
          ? undefined
          : question.options.find((option) => option.value === preselected)?.id,
      search: question.search,
      placeholder: question.placeholder,
    });
    return coerceAnswer(question, chosen);
  }
  if (question.kind === "confirm") {
    // The prompter has no confirm primitive; the repo idiom is a yes/no
    // single-select (see the slackbot question in the add-channels box).
    const fallback = question.detected ?? question.recommended;
    const chosen = await prompter.select<"yes" | "no">({
      message: question.message,
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      initialValue: fallback === undefined ? undefined : fallback ? "yes" : "no",
    });
    return coerceAnswer(question, chosen === "yes");
  }
  // The prompter blocks submission on its own validate; coerceAnswer re-runs
  // the question's validate so every base shares one coercion path.
  const validate = question.validate;
  const promptValidate =
    validate === undefined ? undefined : (value: string) => validate(value) ?? undefined;
  // The text helper fixes T to string, but the generic ask signature cannot
  // carry that proof; String() restates it without a cast.
  const prefilled = question.detected ?? question.recommended;
  const raw = question.sensitive
    ? await prompter.password({ message: question.message, validate: promptValidate })
    : await prompter.text({
        message: question.message,
        placeholder: question.placeholder,
        defaultValue: prefilled === undefined ? undefined : String(prefilled),
        validate: promptValidate,
      });
  return coerceAnswer(question, raw);
}

async function renderManyQuestion<T>(
  prompter: Prompter,
  question: MultiSelectQuestion<T>,
): Promise<T[]> {
  const premarked = question.detected ?? question.recommended;
  const chosen = await prompter.select<string>({
    multiple: true,
    message: question.message,
    // The prompter speaks primitive option values, so the rendered option is
    // the id; the chosen ids map back to the rich values below.
    options: question.options.map((option) => ({
      value: option.id,
      label: option.label,
      hint: option.hint,
      featured: option.featured,
      disabled: option.disabled,
      disabledReason: option.disabledReason,
      locked: option.locked,
      lockedReason: option.lockedReason,
    })),
    initialValues:
      premarked === undefined
        ? undefined
        : question.options
            .filter((option) => premarked.includes(option.value))
            .map((option) => option.id),
    required: question.requireSelection,
    search: question.search,
    placeholder: question.placeholder,
  });
  // No coerceManyAnswer here: the picker already enforces row availability
  // (disabled rows cannot be toggled, locked rows are always returned), and
  // re-judging its output would move box-level guards (e.g. the Slack/Vercel
  // assert in select-channels) behind a different error.
  return chosen.map((id) => {
    const match = question.options.find((option) => option.id === id);
    if (!match) {
      throw new InvalidAnswerError(
        question.key,
        `Invalid answer for "${question.key}": ${id} is not an option id.`,
      );
    }
    return match.value;
  });
}

/**
 * The interactive base: renders every question through the existing
 * {@link Prompter}, pre-filled with detected/recommended. A user cancel
 * surfaces as the prompter's own WizardCancelledError and propagates to the
 * runner unchanged. There is no skip gesture on non-required questions yet:
 * the current prompter has none, so it arrives with the prompter rework.
 */
export function interactiveAsker(prompter: Prompter, events?: AskerEvents): Asker {
  return {
    async ask<T>(question: Question<T>): Promise<T> {
      const value = await renderQuestion(prompter, question);
      if (question.internal) return value;
      return announce(events, question.key, value, "asked");
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      const value = await renderManyQuestion(prompter, question);
      if (question.internal) return value;
      return announce(events, question.key, value, "asked");
    },
  };
}

/**
 * The base for flag/agent stacks: auto-skips non-required questions (announced
 * as "skipped"), refuses required ones structurally with
 * {@link InteractionRequired}.
 */
export function headlessAsker(events?: AskerEvents): Asker {
  // Refusal and skip are mode decisions, not answer-shape decisions, so both
  // channels share one implementation.
  function refuse(question: AnyQuestion): never {
    if (question.required) throw new InteractionRequired(question);
    announce(events, question.key, undefined, "skipped");
    throw new SkippedSignal(question.key);
  }
  return {
    // Async so refusal and skip surface as rejections, like every other rung.
    async ask<T>(question: Question<T>): Promise<T> {
      return refuse(question as Question<unknown>);
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      return refuse(question as MultiSelectQuestion<unknown>);
    },
  };
}

// Decorators: the ladder, composed by the flow, invisible to boxes.

/**
 * Pre-answers by question key (flags, config, agent tool args), validated
 * against the question they answer. Unmatched questions fall through.
 */
export function withAnswers(
  answers: Record<string, unknown>,
  events?: AskerEvents,
): AskerDecorator {
  return (inner) => ({
    async ask<T>(question: Question<T>): Promise<T> {
      if (question.key in answers) {
        const value = coerceAnswer(question, answers[question.key]);
        return announce(events, question.key, value, "answer");
      }
      return inner.ask(question);
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      if (question.key in answers) {
        const value = coerceManyAnswer(question, answers[question.key]);
        return announce(events, question.key, value, "answer");
      }
      return inner.askMany(question);
    },
  });
}

/**
 * Flow-level opt-in to requiredness by key: the flow declares which questions
 * it cannot proceed without, boxes stay oblivious. Composes with box-intrinsic
 * `required` flags (whichever marks it, it is required).
 */
export function withRequired(keys: readonly string[]): AskerDecorator {
  return (inner) => ({
    // Async so an inner rung's synchronous throw still surfaces as a rejection.
    async ask<T>(question: Question<T>): Promise<T> {
      if (!question.required && keys.includes(question.key)) {
        return inner.ask({ ...question, required: true });
      }
      return inner.ask(question);
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      if (!question.required && keys.includes(question.key)) {
        return inner.askMany({ ...question, required: true });
      }
      return inner.askMany(question);
    },
  });
}

/** The two detected/recommended rungs of the ladder. */
export type AnswerPolicy = "confirm-detected" | "assume";

/**
 * The detected/recommended rungs. "confirm-detected" turns a detected value
 * into a one-keystroke confirm (synthesized as an internal question through
 * the same channel); "assume" takes detected or recommended silently but
 * announced, skips the non-required unknowable, and escalates only required
 * unknowables to the inner asker.
 */
export function withPolicy(policy: AnswerPolicy, events?: AskerEvents): AskerDecorator {
  return (inner) => ({
    async ask<T>(question: Question<T>): Promise<T> {
      if (policy === "assume") {
        if (question.detected !== undefined) {
          return announce(events, question.key, question.detected, "detected");
        }
        if (question.recommended !== undefined) {
          return announce(events, question.key, question.recommended, "assumed");
        }
        // Assume minimizes interaction: the unknowable is skipped when the
        // question allows it, and only required questions reach the inner rung.
        if (!question.required) {
          announce(events, question.key, undefined, "skipped");
          throw new SkippedSignal(question.key);
        }
        return inner.ask(question);
      }
      if (question.detected !== undefined) {
        const accepted = await inner.ask(
          confirm({
            key: question.key,
            message: `Use the detected value for "${question.key}"?`,
            internal: true,
          }),
        );
        if (accepted) return announce(events, question.key, question.detected, "detected");
      }
      return inner.ask(question);
    },
    async askMany<T>(question: MultiSelectQuestion<T>): Promise<T[]> {
      if (policy === "assume") {
        if (question.detected !== undefined) {
          return announce(events, question.key, [...question.detected], "detected");
        }
        if (question.recommended !== undefined) {
          return announce(events, question.key, [...question.recommended], "assumed");
        }
        if (!question.required) {
          announce(events, question.key, undefined, "skipped");
          throw new SkippedSignal(question.key);
        }
        return inner.askMany(question);
      }
      if (question.detected !== undefined) {
        // The confirm covers the detected SET in one keystroke; declining it
        // falls through to the full picker, mirroring the single-select rung.
        const accepted = await inner.ask(
          confirm({
            key: question.key,
            message: `Use the detected value for "${question.key}"?`,
            internal: true,
          }),
        );
        if (accepted) return announce(events, question.key, [...question.detected], "detected");
      }
      return inner.askMany(question);
    },
  });
}
