import type { ChannelSetupChoice, ChannelSetupChoiceOptions } from "#setup/cli/index.js";
import type { SearchActionOption } from "#setup/cli/select-state.js";
import type { ProviderPickerChoice, ProviderPickerRequest } from "#setup/flows/provider.js";
import type { PlannerNavigation, SelectMetadata, SelectNotice } from "#setup/prompter.js";

import type { SetupPanelOption } from "./setup-panel.js";

export type SetupEditableSelectResult =
  | { kind: "selected"; value: string }
  | { kind: "edited"; value: string; text: string };

interface SetupSelectRequestBase {
  message: string;
  helpText?: string;
  description?: string;
  metadata?: readonly SelectMetadata[];
  options: readonly SetupPanelOption[];
  notices?: readonly SelectNotice[];
  navigation?: PlannerNavigation;
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
  layout?: "task-list";
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
  layout?: "stacked";
  initialValues?: readonly string[];
  placeholder?: string;
  required: boolean;
}

export type SetupSelectRequest =
  | SetupSingleSelectRequest
  | SetupSearchSelectRequest
  | SetupMultiSelectRequest
  | SetupSearchableMultiSelectRequest;

export type SetupSelectResult =
  | readonly string[]
  | { kind: "navigate"; direction: "back" | "forward"; values: readonly string[] }
  | undefined;

export type SetupFlowInterrupt = "escape" | "ctrl-c";

export interface SetupFlowRenderer {
  begin(title: string): void;
  setNavigation?(navigation: PlannerNavigation | undefined): void;
  end(options?: { preserveDiagnostics?: boolean }): void;
  readSelect(options: SetupSelectRequest): Promise<SetupSelectResult>;
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
  readProviderPicker(options: ProviderPickerRequest): Promise<ProviderPickerChoice | undefined>;
  readText(options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
    notices?: readonly SelectNotice[];
  }): Promise<string | undefined>;
  readAcknowledge(options: { message: string; lines: readonly string[] }): Promise<void>;
  readChoice(options: ChannelSetupChoiceOptions): ChannelSetupChoice;
  setStatus(status: string | undefined): void;
  renderLine(text: string, tone: "info" | "success" | "warning" | "error"): void;
  replaceContent?(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void;
  renderOutput(text: string): void;
  withInheritedStdio<T>(task: () => Promise<T>): Promise<T>;
  withExclusiveTerminal?<T>(task: () => Promise<T>): Promise<T>;
  waitForInterrupt(options?: { interruptible?: boolean }): {
    promise: Promise<SetupFlowInterrupt>;
    dispose(): void;
  };
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
  | "replaceContent"
  | "renderOutput"
  | "withInheritedStdio"
  | "withExclusiveTerminal"
>;
