import type { HandleMessageStreamEvent, InputRequest } from "eve/client";

import { theme } from "./theme.ts";

interface PrintState {
  readonly reasoning: { open: boolean };
  readonly message: { open: boolean };
}

const state: PrintState = {
  reasoning: { open: false },
  message: { open: false },
};

/**
 * Renders one stream event to stdout in a way that's pleasant to watch
 * live. Mirrors the visual language of the eve CLI REPL:
 *
 * - Reasoning streams as blue inline text.
 * - Assistant replies stream as default terminal text after a muted
 *   `agent>` prefix.
 * - Secondary scaffolding (turn/tool/session lifecycle) is dim gray.
 * - Failures (`step.failed`, `turn.failed`, `session.failed`) are red.
 */
export function printStreamEvent(event: HandleMessageStreamEvent): void {
  switch (event.type) {
    case "session.started":
      process.stdout.write(
        theme.muted(
          `[session.started] ${event.data.runtime?.agentName ?? "?"} · ${event.data.runtime?.modelId ?? "?"}\n`,
        ),
      );
      return;

    case "turn.started":
      closeOpenStreams();
      process.stdout.write(theme.muted(`\n[turn ${event.data.turnId}]\n`));
      return;

    case "reasoning.appended":
      if (state.message.open) {
        process.stdout.write("\n");
        state.message.open = false;
      }
      state.reasoning.open = true;
      process.stdout.write(theme.info(event.data.reasoningDelta));
      return;

    case "reasoning.completed":
      if (state.reasoning.open) {
        process.stdout.write("\n");
        state.reasoning.open = false;
      }
      return;

    case "message.appended":
      if (state.reasoning.open) {
        process.stdout.write("\n");
        state.reasoning.open = false;
      }
      if (!state.message.open) {
        process.stdout.write(theme.muted("agent> "));
        state.message.open = true;
      }
      process.stdout.write(event.data.messageDelta);
      return;

    case "message.completed":
      if (state.message.open) {
        process.stdout.write("\n");
        state.message.open = false;
      }
      return;

    case "actions.requested": {
      closeOpenStreams();
      const names = event.data.actions.map(actionLabel).join(", ");
      process.stdout.write(theme.muted(`[tool-call] ${names}\n`));
      return;
    }

    case "action.result":
      closeOpenStreams();
      process.stdout.write(theme.muted(`[tool-result] ${event.data.status}\n`));
      return;

    case "message.received":
      closeOpenStreams();
      process.stdout.write(`${theme.muted("user>")} ${event.data.message}\n`);
      return;

    case "input.requested": {
      closeOpenStreams();
      for (const request of event.data.requests) {
        const summary = describeInputRequest(request);
        process.stdout.write(`${theme.muted("[input requested]")} ${theme.warning(summary)}\n`);
      }
      return;
    }

    case "step.failed":
    case "turn.failed":
    case "session.failed": {
      closeOpenStreams();
      process.stdout.write(
        theme.danger(`\n[${event.type}] ${event.data.code} ${event.data.message}\n`),
      );
      if (event.data.details) {
        process.stdout.write(theme.muted(`${JSON.stringify(event.data.details, null, 2)}\n`));
      }
      return;
    }

    case "turn.completed":
      closeOpenStreams();
      process.stdout.write(theme.muted(`[turn ${event.data.turnId} completed]\n`));
      return;

    case "step.started":
    case "step.completed":
    case "session.waiting":
    case "session.completed":
      return;

    default:
      closeOpenStreams();
      process.stdout.write(theme.muted(`[${event.type}]\n`));
  }
}

function closeOpenStreams(): void {
  if (state.reasoning.open) {
    process.stdout.write("\n");
    state.reasoning.open = false;
  }
  if (state.message.open) {
    process.stdout.write("\n");
    state.message.open = false;
  }
}

function actionLabel(action: { kind?: string; toolName?: string; name?: string }): string {
  if (action.toolName) return action.toolName;
  if (action.name) return action.name;
  return action.kind ?? "?";
}

function describeInputRequest(request: InputRequest): string {
  const tool = request.action.toolName;
  const args = compactJson(request.action.input);
  const optionList =
    (request.options ?? []).map((option: { id: string }) => option.id).join(" | ") || "freeform";
  const argSuffix = args === "{}" ? "" : ` ${args}`;
  return `${request.display ?? "input"} for ${tool}${argSuffix}, options: ${optionList}`;
}

function compactJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return "";
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return "";
  }
}

/** Prints one outgoing user message or HITL response in the same speaker-line
 * style as agent replies, see {@link printStreamEvent} for the `agent>`
 * counterpart. */
export function printUserLine(input: {
  message: string;
  tone?: "approve" | "deny" | "text";
}): void {
  const prefix = theme.muted("user>");
  const body =
    input.tone === "approve"
      ? theme.success(input.message)
      : input.tone === "deny"
        ? theme.danger(input.message)
        : input.message;
  process.stdout.write(`${prefix} ${body}\n`);
}

/**
 * Walks the `cause` chain of a thrown value and prints `responseBody` /
 * `data` at each level. Mirrors the manual debug pattern that surfaced the
 * gateway 400 on multimodal turns, gateway errors wrap an inner
 * `APICallError` whose `responseBody` carries the real validation reason.
 */
export function printErrorChain(error: unknown): void {
  let current: unknown = error;
  let depth = 0;
  while (current != null && depth < 5) {
    const e = current as {
      name?: string;
      message?: string;
      statusCode?: number;
      url?: string;
      responseBody?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    console.error(theme.danger(`[error depth=${depth}]`), {
      name: e.name,
      message: e.message,
      statusCode: e.statusCode,
      url: e.url,
      responseBody: e.responseBody,
      data: e.data,
    });
    current = e.cause;
    depth += 1;
  }
}
