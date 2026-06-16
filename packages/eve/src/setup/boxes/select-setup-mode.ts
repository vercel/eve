import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { select, SkippedSignal, type Asker } from "../ask.js";
import type { SetupMode, SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

const MODE_PROMPT_MESSAGE = "How much should we set up now?";

export interface SelectSetupModeOptions {
  /** Resolves the mode question; the composed stack decides how. */
  asker: Asker;
  /**
   * Skip the mode question and use this value. Stays a factory option (not a
   * `withAnswers` rung) so it short-circuits before any ask, which is what
   * lets a headless `--one-shot` run resolve without a terminal.
   */
  presetMode?: SetupMode;
  /**
   * Model baked into a one-shot scaffold instead of {@link DEFAULT_AGENT_MODEL_ID}.
   * Threaded from the same `--model` preset the model box consumes, so the
   * flag keeps working when the model box is skipped.
   */
  presetModel?: string;
}

/** The mode plus the model a one-shot run pins, since the model box is skipped. */
export interface SelectSetupModePayload {
  mode: SetupMode;
  modelId?: string;
}

/**
 * THE SETUP-MODE BOX: decide whether the run is the complete onboarding flow
 * or a one-shot scaffold. One-shot pins the default model here because every
 * later interview box (including the model picker) is gated off. The question
 * is skippable, so a headless stack without a preset resolves to "complete"
 * and current headless behavior is unchanged.
 */
export function selectSetupMode(
  options: SelectSetupModeOptions,
): SetupBox<SetupState, SetupMode, SelectSetupModePayload> {
  return {
    id: "select-setup-mode",

    async gather(): Promise<SetupMode> {
      if (options.presetMode !== undefined) return options.presetMode;
      try {
        return await options.asker.ask(
          select<SetupMode>({
            key: "setup-mode",
            message: MODE_PROMPT_MESSAGE,
            options: [
              {
                id: "complete",
                label: "Complete setup",
                value: "complete",
                hint: "model, channels, connections, deploy",
              },
              {
                id: "one-shot",
                label: "One-shot",
                value: "one-shot",
                hint: "just write the project files",
              },
            ],
            recommended: "complete",
          }),
        );
      } catch (error) {
        if (error instanceof SkippedSignal) return "complete";
        throw error;
      }
    },

    async perform({ input }): Promise<SelectSetupModePayload> {
      if (input === "one-shot") {
        return { mode: input, modelId: options.presetModel ?? DEFAULT_AGENT_MODEL_ID };
      }
      return { mode: input };
    },

    apply(state, payload) {
      return {
        ...state,
        setupMode: payload.mode,
        modelId: payload.modelId ?? state.modelId,
      };
    },
  };
}
