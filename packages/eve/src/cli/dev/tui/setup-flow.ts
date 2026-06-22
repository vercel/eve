import type { ChannelSetupChoice, ChannelSetupChoiceOptions } from "#setup/cli/index.js";
import type { SearchActionOption } from "#setup/cli/select-state.js";
import type { SelectNotice } from "#setup/prompter.js";

import type { SetupPanelOption } from "./setup-panel.js";

export type SetupEditableSelectResult =
  | { kind: "selected"; value: string }
  | { kind: "edited"; value: string; text: string };

/** Animation shown while a setup flow is between questions. */
export type SetupFlowIndicator = "spinner" | "pulse";

interface SetupSelectRequestBase {
  message: string;
  options: readonly SetupPanelOption[];
  notices?: readonly SelectNotice[];
}

interface SetupSingleSelectRequest extends SetupSelectRequestBase {
  kind: "single" | "stacked" | "task-list";
  initialValue?: string;
}

interface SetupSearchAction extends SearchActionOption {
  load?(query: string): Promise<readonly SetupPanelOption[]>;
}

interface SetupSearchSelectRequest extends SetupSelectRequestBase {
  kind: "search";
  initialValue?: string;
  placeholder?: string;
  searchAction?: SetupSearchAction;
}

interface SetupMultiSelectRequest extends SetupSelectRequestBase {
  kind: "multi";
  initialValues?: readonly string[];
  required: boolean;
}

interface SetupSearchableMultiSelectRequest extends SetupSelectRequestBase {
  kind: "searchable-multi";
  initialValues?: readonly string[];
  placeholder?: string;
  required: boolean;
}

/**
 * A setup select's complete interaction grammar. The discriminant prevents
 * callers from combining incompatible modes such as multi-select plus a
 * single-select layout.
 */
export type SetupSelectRequest =
  | SetupSingleSelectRequest
  | SetupSearchSelectRequest
  | SetupMultiSelectRequest
  | SetupSearchableMultiSelectRequest;

export interface SetupFlowRenderer {
  begin(title: string, indicator?: SetupFlowIndicator): void;
  end(options?: { preserveDiagnostics?: boolean }): void;
  readSelect(options: SetupSelectRequest): Promise<readonly string[] | undefined>;
  readEditableSelect(options: {
    message: string;
    options: readonly SetupPanelOption[];
    initialValue?: string;
    editable: {
      value: string;
      defaultValue: string;
      formatHint: (value: string) => string;
      validate?: (value: string) => string | undefined;
    };
  }): Promise<SetupEditableSelectResult | undefined>;
  readText(options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
    notices?: readonly SelectNotice[];
  }): Promise<string | undefined>;
  readAcknowledge(options: { message: string; lines: readonly string[] }): Promise<void>;
  /**
   * Presents an inert context row and a separate action menu beside the live
   * flow indicator. Returns the choice plus a `close()` that dismisses the menu
   * when a concurrent wait resolves first. Used by the Slack install wait for
   * "Try again" / "Cancel": the poll keeps running while the prompt is up, and
   * whichever settles first wins.
   */
  readChoice(options: ChannelSetupChoiceOptions): ChannelSetupChoice;
  setStatus(text: string | undefined): void;
  renderLine(text: string, tone: "info" | "success" | "warning" | "error"): void;
  renderOutput(text: string): void;
  /**
   * Arms a key trap for the flow's working state — the status indicator between
   * questions, where no prompt is consuming keys. Ctrl-C or Esc resolves the
   * promise so the command can abandon an in-flight flow (e.g. a parked
   * `vercel connect create` browser OAuth). Open questions own their keys; the
   * trap covers only the gaps. `dispose` releases the trap; the promise then
   * never resolves.
   */
  waitForInterrupt(): { promise: Promise<void>; dispose(): void };
}

export type SetupFlowPrompterRenderer = Pick<
  SetupFlowRenderer,
  | "readSelect"
  | "readEditableSelect"
  | "readText"
  | "readAcknowledge"
  | "readChoice"
  | "setStatus"
  | "renderLine"
  | "renderOutput"
>;
