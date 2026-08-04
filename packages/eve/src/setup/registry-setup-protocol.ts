import type {
  AcknowledgeOptions,
  MultiSelectOptions,
  PrompterValue,
  SelectCommonOptions,
  SelectNotice,
  SelectOption,
  SingleSelectOptions,
} from "./prompter.js";

export const REGISTRY_SETUP_PROTOCOL_VERSION = 1;

export type RegistrySetupFact = {
  label: string;
  value: string;
  kind?: "text" | "url" | "phone";
};

export type RegistrySetupError = {
  message: string;
  details?: readonly string[];
};

export type RegistrySetupOutcome =
  | { kind: "completed"; facts: readonly RegistrySetupFact[] }
  | { kind: "cancelled" }
  | { kind: "failed"; error: RegistrySetupError };

export type RegistrySetupPrompt =
  | {
      kind: "text" | "password";
      message: string;
      placeholder?: string;
      defaultValue?: string;
      notices?: readonly SelectNotice[];
    }
  | {
      kind: "select";
      options: SingleSelectOptions<PrompterValue> | MultiSelectOptions<PrompterValue>;
    }
  | {
      kind: "editable-select";
      options: SelectCommonOptions<PrompterValue> & {
        initialValue?: PrompterValue;
        editable: { value: PrompterValue; defaultValue: string };
      };
    }
  | { kind: "acknowledge"; options: AcknowledgeOptions }
  | {
      kind: "choice";
      options: {
        status: string;
        context: string;
        actions: readonly SelectOption<string>[];
      };
    };

export type RegistrySetupChildMessage =
  | { type: "ready"; version: typeof REGISTRY_SETUP_PROTOCOL_VERSION }
  | { type: "prompt"; id: number; prompt: RegistrySetupPrompt }
  | { type: "close-prompt"; id: number }
  | {
      type: "log";
      level: "message" | "info" | "success" | "warning" | "error" | "commandOutput";
      text: string;
    }
  | { type: "note"; message: string; title?: string; tone?: "warning" | "success" }
  | { type: "intro" | "outro"; text: string; subtitle?: string }
  | { type: "result"; outcome: RegistrySetupOutcome }
  | {
      type: "status";
      id: number;
      status?: string;
      intent?: { kind: "external-action"; emphasis: string };
    };

export type RegistrySetupParentMessage =
  | { type: "prompt-result"; id: number; value?: unknown; cancelled?: true }
  | { type: "cancel" };

export function isRegistrySetupChildMessage(value: unknown): value is RegistrySetupChildMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "ready" ||
    type === "prompt" ||
    type === "close-prompt" ||
    type === "log" ||
    type === "note" ||
    type === "intro" ||
    type === "outro" ||
    type === "result" ||
    type === "status"
  );
}
