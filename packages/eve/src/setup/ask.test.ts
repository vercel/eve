import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import {
  confirm,
  headlessAsker,
  InteractionRequired,
  InvalidAnswerError,
  interactiveAsker,
  select,
  SkippedSignal,
  text,
  withAnswers,
  withPolicy,
  withRequired,
  type Asker,
  type MultiSelectOption,
  type MultiSelectQuestion,
  type Question,
  type Resolution,
  type SelectOption,
} from "./ask.js";
import type { MultiSelectOptions, PrompterValue, SingleSelectOptions } from "./prompter.js";
import { WizardCancelledError } from "./step.js";

/** Proves a rung resolved the question without reaching the rung below. */
function untouchableAsker(): Asker {
  return {
    ask(question): Promise<never> {
      throw new Error(`untouchableAsker was asked "${question.key}"`);
    },
    askMany(question): Promise<never> {
      throw new Error(`untouchableAsker was asked "${question.key}"`);
    },
  };
}

function recordingEvents(): { resolutions: Resolution[]; onResolved: (r: Resolution) => void } {
  const resolutions: Resolution[] = [];
  return { resolutions, onResolved: (resolution) => resolutions.push(resolution) };
}

interface Color {
  hex: string;
}

const RED: Color = { hex: "#f00" };
const BLUE: Color = { hex: "#00f" };

const COLOR_OPTIONS: readonly SelectOption<Color>[] = [
  { id: "red", label: "Red", value: RED, hint: "warm" },
  { id: "blue", label: "Blue", value: BLUE },
];

function colorQuestion(
  extra: Partial<Pick<Question<Color>, "detected" | "recommended" | "required">> & {
    search?: boolean;
    placeholder?: string;
  } = {},
): Question<Color> {
  return select({ key: "color", message: "Pick a color", options: COLOR_OPTIONS, ...extra });
}

const GREEN: Color = { hex: "#0f0" };
const WHITE: Color = { hex: "#fff" };

const COLOR_MULTI_OPTIONS: readonly MultiSelectOption<Color>[] = [
  { id: "red", label: "Red", value: RED, hint: "warm" },
  { id: "blue", label: "Blue", value: BLUE },
  { id: "green", label: "Green", value: GREEN, disabled: true, disabledReason: "out of stock" },
  { id: "white", label: "White", value: WHITE, locked: true, lockedReason: "always included" },
];

function colorsQuestion(
  extra: Partial<MultiSelectQuestion<Color>> = {},
): MultiSelectQuestion<Color> {
  return { key: "colors", message: "Pick colors", options: COLOR_MULTI_OPTIONS, ...extra };
}

type SingleHandler = (opts: SingleSelectOptions<PrompterValue>) => PrompterValue;

function selectPrompter(handler: SingleHandler) {
  const single = vi.fn(handler);
  return { single, prompter: createFakePrompter({ single }).prompter };
}

type MultipleHandler = (opts: MultiSelectOptions<PrompterValue>) => PrompterValue[];

function multiSelectPrompter(handler: MultipleHandler) {
  const multiple = vi.fn(handler);
  return { multiple, prompter: createFakePrompter({ multiple }).prompter };
}

describe("interactiveAsker", () => {
  it("renders a select through the prompter by option id and maps back to the rich value", async () => {
    const { single, prompter } = selectPrompter(() => "blue");
    const events = recordingEvents();

    const value = await interactiveAsker(prompter, events).ask(colorQuestion());

    expect(value).toBe(BLUE);
    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Pick a color",
        options: [
          { value: "red", label: "Red", hint: "warm" },
          { value: "blue", label: "Blue", hint: undefined },
        ],
      }),
    );
    expect(events.resolutions).toEqual([{ key: "color", value: BLUE, source: "asked" }]);
  });

  it("pre-selects detected over recommended and forwards the presentation hints", async () => {
    const { single, prompter } = selectPrompter(() => "red");

    await interactiveAsker(prompter).ask(
      colorQuestion({ detected: BLUE, recommended: RED, search: true, placeholder: "filter" }),
    );

    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "blue", search: true, placeholder: "filter" }),
    );
  });

  it("renders a confirm as the repo's yes/no select and returns a boolean", async () => {
    const { single, prompter } = selectPrompter(() => "yes");

    const value = await interactiveAsker(prompter).ask(
      confirm({ key: "deploy", message: "Deploy now?", detected: false }),
    );

    expect(value).toBe(true);
    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Deploy now?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        initialValue: "no",
      }),
    );
  });

  it("renders text with the question's default and validate", async () => {
    const textHandler = vi.fn(
      (opts: { message: string; placeholder?: string; defaultValue?: string }) => {
        void opts;
        return "valid-name";
      },
    );
    const { prompter } = createFakePrompter({ text: textHandler });

    const value = await interactiveAsker(prompter).ask(
      text({
        key: "name",
        message: "Project name?",
        recommended: "my-agent",
        validate: (raw) => (raw.includes(" ") ? "No spaces." : null),
      }),
    );

    expect(value).toBe("valid-name");
    expect(textHandler).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Project name?", defaultValue: "my-agent" }),
    );
  });

  it("routes sensitive text through the password prompt", async () => {
    const password = vi.fn((opts: { message: string }) => {
      void opts;
      return "s3cret";
    });
    const { prompter } = createFakePrompter({ password });

    const value = await interactiveAsker(prompter).ask(
      text({ key: "apiKey", message: "Gateway key?", sensitive: true }),
    );

    expect(value).toBe("s3cret");
    expect(password).toHaveBeenCalledWith(expect.objectContaining({ message: "Gateway key?" }));
  });

  it("lets the prompter's WizardCancelledError propagate unchanged", async () => {
    const { prompter } = selectPrompter(() => {
      throw new WizardCancelledError();
    });

    await expect(interactiveAsker(prompter).ask(colorQuestion())).rejects.toBeInstanceOf(
      WizardCancelledError,
    );
  });

  it("renders a multi-select through the prompter's checklist and maps ids back to rich values", async () => {
    const { multiple, prompter } = multiSelectPrompter(() => ["blue", "white"]);
    const events = recordingEvents();

    const value = await interactiveAsker(prompter, events).askMany(colorsQuestion());

    expect(value).toEqual([BLUE, WHITE]);
    expect(multiple).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: true,
        message: "Pick colors",
        options: [
          expect.objectContaining({ value: "red", label: "Red", hint: "warm" }),
          expect.objectContaining({ value: "blue", label: "Blue" }),
          expect.objectContaining({
            value: "green",
            disabled: true,
            disabledReason: "out of stock",
          }),
          expect.objectContaining({
            value: "white",
            locked: true,
            lockedReason: "always included",
          }),
        ],
      }),
    );
    expect(events.resolutions).toEqual([{ key: "colors", value: [BLUE, WHITE], source: "asked" }]);
  });

  it("pre-marks detected over recommended and forwards the multi-select presentation hints", async () => {
    const { multiple, prompter } = multiSelectPrompter(() => ["red"]);

    await interactiveAsker(prompter).askMany(
      colorsQuestion({
        detected: [BLUE],
        recommended: [RED],
        requireSelection: true,
        search: true,
        placeholder: "filter",
      }),
    );

    expect(multiple).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValues: ["blue"],
        required: true,
        search: true,
        placeholder: "filter",
      }),
    );
  });
});

describe("headlessAsker", () => {
  it("auto-skips a non-required question with a skipped notice", async () => {
    const events = recordingEvents();

    await expect(headlessAsker(events).ask(colorQuestion())).rejects.toBeInstanceOf(SkippedSignal);
    expect(events.resolutions).toEqual([{ key: "color", value: undefined, source: "skipped" }]);
  });

  it("refuses a required question with the full question attached", async () => {
    const question = colorQuestion({ required: true });

    await expect(headlessAsker().ask(question)).rejects.toMatchObject({
      name: "InteractionRequired",
      message: 'Interaction required for "color": Pick a color',
      question,
    });
  });

  it("auto-skips a non-required multi-select with a skipped notice", async () => {
    const events = recordingEvents();

    await expect(headlessAsker(events).askMany(colorsQuestion())).rejects.toBeInstanceOf(
      SkippedSignal,
    );
    expect(events.resolutions).toEqual([{ key: "colors", value: undefined, source: "skipped" }]);
  });

  it("refuses a required multi-select with the full question attached", async () => {
    const question = colorsQuestion({ required: true });

    await expect(headlessAsker().askMany(question)).rejects.toMatchObject({
      name: "InteractionRequired",
      message: 'Interaction required for "colors": Pick colors',
      question,
    });
  });
});

describe("withAnswers", () => {
  it("resolves a matching key without reaching the inner rung", async () => {
    const events = recordingEvents();
    const asker = withAnswers({ color: "red" }, events)(untouchableAsker());

    const value = await asker.ask(colorQuestion());

    expect(value).toBe(RED);
    expect(events.resolutions).toEqual([{ key: "color", value: RED, source: "answer" }]);
  });

  it("rejects an answer the question does not accept, naming the alternatives", async () => {
    const asker = withAnswers({ color: "green" })(untouchableAsker());

    await expect(asker.ask(colorQuestion())).rejects.toThrow(
      'Invalid answer for "color": green. Expected one of: red, blue.',
    );
    await expect(asker.ask(colorQuestion())).rejects.toBeInstanceOf(InvalidAnswerError);
  });

  it("coerces confirm strings and validates text answers", async () => {
    const asker = withAnswers({ deploy: "false", name: "has space" })(untouchableAsker());

    await expect(asker.ask(confirm({ key: "deploy", message: "Deploy now?" }))).resolves.toBe(
      false,
    );
    await expect(
      asker.ask(
        text({
          key: "name",
          message: "Project name?",
          validate: (raw) => (raw.includes(" ") ? "No spaces." : null),
        }),
      ),
    ).rejects.toThrow("No spaces.");
  });

  it("falls through on an unmatched key", async () => {
    const asker = withAnswers({ other: "x" })(headlessAsker());

    await expect(asker.ask(colorQuestion())).rejects.toBeInstanceOf(SkippedSignal);
    await expect(asker.askMany(colorsQuestion())).rejects.toBeInstanceOf(SkippedSignal);
  });

  it("resolves a multi-select answer of option ids without reaching the inner rung", async () => {
    const events = recordingEvents();
    const asker = withAnswers({ colors: ["blue", "red"] }, events)(untouchableAsker());

    const value = await asker.askMany(colorsQuestion());

    // The locked value joins the answer even though it was not named, exactly
    // as the interactive picker always returns its locked rows.
    expect(value).toEqual([BLUE, RED, WHITE]);
    expect(events.resolutions).toEqual([
      { key: "colors", value: [BLUE, RED, WHITE], source: "answer" },
    ]);
  });

  it("rejects an unknown multi-select id naming the alternatives, and a non-array answer", async () => {
    const asker = withAnswers({ colors: ["magenta"] })(untouchableAsker());

    await expect(asker.askMany(colorsQuestion())).rejects.toThrow(
      'Invalid answer for "colors": magenta. Expected one of: red, blue, green, white.',
    );
    await expect(asker.askMany(colorsQuestion())).rejects.toBeInstanceOf(InvalidAnswerError);

    await expect(
      withAnswers({ colors: "blue" })(untouchableAsker()).askMany(colorsQuestion()),
    ).rejects.toThrow('Invalid answer for "colors": expected an array of option ids.');
  });

  it("rejects a disabled multi-select id naming its reason", async () => {
    const asker = withAnswers({ colors: ["green"] })(untouchableAsker());

    await expect(asker.askMany(colorsQuestion())).rejects.toThrow(
      'Invalid answer for "colors": green is unavailable (out of stock).',
    );
  });
});

describe("withPolicy", () => {
  it("assume takes detected first, then recommended, announced with their sources", async () => {
    const events = recordingEvents();
    const asker = withPolicy("assume", events)(untouchableAsker());

    await expect(asker.ask(colorQuestion({ detected: BLUE }))).resolves.toBe(BLUE);
    await expect(asker.ask(colorQuestion({ recommended: RED }))).resolves.toBe(RED);
    expect(events.resolutions.map((resolution) => resolution.source)).toEqual([
      "detected",
      "assumed",
    ]);
  });

  it("assume skips the non-required unknowable and escalates only required ones", async () => {
    const events = recordingEvents();
    const asker = withPolicy("assume", events)(headlessAsker());

    await expect(asker.ask(colorQuestion())).rejects.toBeInstanceOf(SkippedSignal);
    expect(events.resolutions).toEqual([{ key: "color", value: undefined, source: "skipped" }]);

    await expect(asker.ask(colorQuestion({ required: true }))).rejects.toBeInstanceOf(
      InteractionRequired,
    );
  });

  it("confirm-detected synthesizes an internal confirm through the channel", async () => {
    const { single, prompter } = selectPrompter(() => "yes");
    const events = recordingEvents();
    const asker = withPolicy("confirm-detected", events)(interactiveAsker(prompter, events));

    const value = await asker.ask(colorQuestion({ detected: BLUE }));

    expect(value).toBe(BLUE);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Use the detected value for "color"?' }),
    );
    // The synthesized confirm is interaction mechanics: only the policy's own
    // "detected" resolution is announced, never an "asked" for the confirm.
    expect(events.resolutions).toEqual([{ key: "color", value: BLUE, source: "detected" }]);
  });

  it("confirm-detected falls through to the real question when declined", async () => {
    const answers = ["no", "red"];
    const { single, prompter } = selectPrompter(() => answers.shift() ?? "red");
    const asker = withPolicy("confirm-detected")(interactiveAsker(prompter));

    const value = await asker.ask(colorQuestion({ detected: BLUE }));

    expect(value).toBe(RED);
    expect(single).toHaveBeenCalledTimes(2);
    expect(single).toHaveBeenLastCalledWith(expect.objectContaining({ message: "Pick a color" }));
  });

  it("assume takes the detected set first, then recommended, announced with their sources", async () => {
    const events = recordingEvents();
    const asker = withPolicy("assume", events)(untouchableAsker());

    await expect(asker.askMany(colorsQuestion({ detected: [BLUE] }))).resolves.toEqual([BLUE]);
    await expect(asker.askMany(colorsQuestion({ recommended: [RED] }))).resolves.toEqual([RED]);
    expect(events.resolutions.map((resolution) => resolution.source)).toEqual([
      "detected",
      "assumed",
    ]);
  });

  it("assume skips the non-required unknowable multi-select and escalates only required ones", async () => {
    const events = recordingEvents();
    const asker = withPolicy("assume", events)(headlessAsker());

    await expect(asker.askMany(colorsQuestion())).rejects.toBeInstanceOf(SkippedSignal);
    expect(events.resolutions).toEqual([{ key: "colors", value: undefined, source: "skipped" }]);

    await expect(asker.askMany(colorsQuestion({ required: true }))).rejects.toBeInstanceOf(
      InteractionRequired,
    );
  });

  it("confirm-detected synthesizes an internal confirm over the detected set", async () => {
    const { single, prompter } = selectPrompter(() => "yes");
    const events = recordingEvents();
    const asker = withPolicy("confirm-detected", events)(interactiveAsker(prompter, events));

    const value = await asker.askMany(colorsQuestion({ detected: [BLUE, RED] }));

    expect(value).toEqual([BLUE, RED]);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Use the detected value for "colors"?' }),
    );
    expect(events.resolutions).toEqual([{ key: "colors", value: [BLUE, RED], source: "detected" }]);
  });

  it("confirm-detected falls through to the picker when the detected set is declined", async () => {
    const single = vi.fn<SingleHandler>(() => "no");
    const multiple = vi.fn<MultipleHandler>(() => ["red"]);
    const { prompter } = createFakePrompter({ single, multiple });
    const asker = withPolicy("confirm-detected")(interactiveAsker(prompter));

    const value = await asker.askMany(colorsQuestion({ detected: [BLUE] }));

    expect(value).toEqual([RED]);
    expect(single).toHaveBeenCalledTimes(1);
    expect(multiple).toHaveBeenCalledWith(expect.objectContaining({ message: "Pick colors" }));
  });
});

describe("withRequired", () => {
  it("marks only the listed keys required for the rungs below", async () => {
    const asker = withRequired(["color"])(headlessAsker());

    await expect(asker.ask(colorQuestion())).rejects.toBeInstanceOf(InteractionRequired);
    await expect(
      asker.ask(confirm({ key: "deploy", message: "Deploy now?" })),
    ).rejects.toBeInstanceOf(SkippedSignal);
  });

  it("leaves box-intrinsic requiredness in place", async () => {
    const asker = withRequired([])(headlessAsker());

    await expect(asker.ask(colorQuestion({ required: true }))).rejects.toBeInstanceOf(
      InteractionRequired,
    );
  });

  it("marks listed multi-select keys required for the rungs below", async () => {
    const asker = withRequired(["colors"])(headlessAsker());

    await expect(asker.askMany(colorsQuestion())).rejects.toBeInstanceOf(InteractionRequired);
    await expect(asker.askMany({ ...colorsQuestion(), key: "shades" })).rejects.toBeInstanceOf(
      SkippedSignal,
    );
  });
});

describe("decorator stacking", () => {
  it("resolves answers before policy, and policy before the base", async () => {
    const events = recordingEvents();
    const stack = withAnswers(
      { color: "red" },
      events,
    )(withPolicy("assume", events)(untouchableAsker()));

    // The flag answer outranks the detected value.
    await expect(stack.ask(colorQuestion({ detected: BLUE }))).resolves.toBe(RED);
    // Without an answer, the policy resolves before the base is reached.
    await expect(
      stack.ask(select({ key: "shade", message: "Shade?", options: [], detected: "dark" })),
    ).resolves.toBe("dark");
    expect(events.resolutions.map((resolution) => resolution.source)).toEqual([
      "answer",
      "detected",
    ]);
  });
});
