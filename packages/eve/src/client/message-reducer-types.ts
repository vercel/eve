import type { InputResponse } from "#runtime/input/types.js";

/**
 * UIMessage-compatible eve message projection for chat and agent UIs.
 */
export interface EveMessageData {
  readonly messages: readonly EveMessage[];
}

/**
 * eve-owned message shape that follows the AI SDK UIMessage convention.
 */
export interface EveMessage {
  readonly id: string;
  readonly metadata?: EveMessageMetadata;
  readonly parts: readonly EveMessagePart[];
  readonly role: "assistant" | "user";
}

/**
 * Per-message metadata attached by the default projection.
 *
 * `status` tracks this message's own lifecycle (distinct from session-level
 * status): user messages use `"submitted"` or `"failed"`, assistant messages
 * use `"streaming"` or `"complete"`. `optimistic` is set only while a
 * client-projected user message awaits server confirmation. `turnId` links the
 * message to its runtime turn; `result` holds the harness structured result
 * once the turn finalizes.
 */
export interface EveMessageMetadata {
  readonly optimistic?: true;
  readonly result?: unknown;
  readonly status?: "complete" | "failed" | "streaming" | "submitted";
  readonly turnId?: string;
}

/**
 * One renderable part of an {@link EveMessage}, discriminated by `type`.
 *
 * `text` and `reasoning` store streamed content with a `state` of `"streaming"`
 * or `"done"`; `step-start` marks the boundary of an agent step; and
 * `dynamic-tool` ({@link EveDynamicToolPart}) holds the tool call and its
 * lifecycle state. `stepIndex` ties a part to the agent step that produced it.
 */
export type EveMessagePart =
  | {
      readonly providerMetadata?: Record<string, unknown>;
      readonly state?: "done" | "streaming";
      readonly stepIndex?: number;
      readonly text: string;
      readonly type: "text";
    }
  | {
      readonly providerMetadata?: Record<string, unknown>;
      readonly state?: "done" | "streaming";
      readonly stepIndex?: number;
      readonly text: string;
      readonly type: "reasoning";
    }
  | {
      readonly type: "step-start";
    }
  | EveDynamicToolPart;

/**
 * A tool-call part of an assistant message, following the AI SDK `dynamic-tool`
 * convention. `state` advances through the lifecycle: `"input-streaming"` and
 * `"input-available"` (arguments arriving or complete), `"approval-requested"` and
 * `"approval-responded"` (HITL approval pending or answered), then a terminal
 * `"output-available"`, `"output-error"` (`errorText` set), or `"output-denied"`
 * (`approval.approved` is `false`). Which of `input`, `output`, `errorText`, and
 * `approval` are present depends on `state`, so narrow on `state` before reading them.
 * `toolName` and `toolMetadata.eve` ({@link EveMessageToolMetadata}) record call identity.
 */
export type EveDynamicToolPart = {
  readonly stepIndex?: number;
  readonly toolCallId: string;
  readonly toolMetadata?: EveMessageToolMetadata;
  readonly toolName: string;
  readonly type: "dynamic-tool";
} & (
  | {
      readonly approval?: never;
      readonly errorText?: never;
      readonly input: unknown | undefined;
      readonly output?: never;
      readonly state: "input-streaming";
    }
  | {
      readonly approval?: never;
      readonly errorText?: never;
      readonly input: unknown;
      readonly output?: never;
      readonly state: "input-available";
    }
  | {
      readonly approval: {
        readonly id: string;
        readonly approved?: never;
        readonly reason?: never;
        readonly isAutomatic?: boolean;
      };
      readonly errorText?: never;
      readonly input: unknown;
      readonly output?: never;
      readonly state: "approval-requested";
    }
  | {
      readonly approval: {
        readonly id: string;
        readonly approved?: boolean;
        readonly reason?: string;
        readonly isAutomatic?: boolean;
      };
      readonly errorText?: never;
      readonly input: unknown;
      readonly output?: never;
      readonly state: "approval-responded";
    }
  | {
      readonly approval?: {
        readonly id: string;
        readonly approved: true;
        readonly reason?: string;
        readonly isAutomatic?: boolean;
      };
      readonly errorText?: never;
      readonly input: unknown;
      readonly output: unknown;
      readonly state: "output-available";
    }
  | {
      readonly approval?: {
        readonly id: string;
        readonly approved: true;
        readonly reason?: string;
        readonly isAutomatic?: boolean;
      };
      readonly errorText: string;
      readonly input: unknown | undefined;
      readonly output?: never;
      readonly state: "output-error";
    }
  | {
      readonly approval: {
        readonly id: string;
        readonly approved: false;
        readonly reason?: string;
        readonly isAutomatic?: boolean;
      };
      readonly errorText?: never;
      readonly input: unknown;
      readonly output?: never;
      readonly state: "output-denied";
    }
);

/**
 * eve-specific metadata attached to an {@link EveDynamicToolPart}. `eve.kind`
 * classifies the action (`"tool-call"`, `"subagent-call"`, `"load-skill"`, or
 * `"unknown"`), `eve.name` is the resolved action name, and `eve.inputRequest`
 * and `eve.inputResponse` store the HITL prompt and submitted response when the
 * call required approval.
 */
export interface EveMessageToolMetadata {
  readonly eve?: {
    readonly inputRequest?: EveMessageInputRequest;
    readonly inputResponse?: InputResponse;
    readonly kind: "load-skill" | "subagent-call" | "tool-call" | "unknown";
    readonly name: string;
  };
}

/**
 * UI-facing projection of a pending HITL input request on a tool part. `prompt`
 * is the question, `display` selects the control (`"confirmation"`, `"select"`,
 * or `"text"`), `options` lists selectable choices (each with a `label` and
 * optional `style`), and `allowFreeform` permits a typed response alongside the
 * options. `requestId` is the stable identifier the client returns in the
 * responding {@link InputResponse}.
 */
export interface EveMessageInputRequest {
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly {
    readonly description?: string;
    readonly id: string;
    readonly label: string;
    readonly style?: "danger" | "default" | "primary";
  }[];
  readonly prompt: string;
  readonly requestId: string;
}
