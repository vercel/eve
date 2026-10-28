import type { SessionStreamEvent } from "eve/client";

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
 * - Failures (failed model runs, turns, and sessions) are red.
 */
export function printStreamEvent(event: SessionStreamEvent): void {
  switch (event.type) {
    case "session.started":
      process.stdout.write(
        theme.muted(`[session.started] ${event.data.runtime?.agentName ?? "?"}\n`),
      );
      return;

    case "turn.started":
      closeOpenStreams();
      process.stdout.write(theme.muted(`\n[turn ${event.data.turnId}]\n`));
      return;

    case "content.delta":
      if (event.data.kind === "reasoning") {
        if (state.message.open) {
          process.stdout.write("\n");
          state.message.open = false;
        }
        state.reasoning.open = true;
        process.stdout.write(theme.info(event.data.delta));
        return;
      }
      if (state.reasoning.open) {
        process.stdout.write("\n");
        state.reasoning.open = false;
      }
      if (!state.message.open) {
        process.stdout.write(theme.muted("agent> "));
        state.message.open = true;
      }
      process.stdout.write(event.data.delta);
      return;

    case "content.completed":
      closeOpenStreams();
      return;

    case "call.requested":
      closeOpenStreams();
      process.stdout.write(theme.muted(`[tool-call] ${event.data.capability.name}\n`));
      return;

    case "call.settled":
      closeOpenStreams();
      process.stdout.write(theme.muted(`[tool-result] ${event.data.outcome}\n`));
      return;

    case "delivery.consumed": {
      closeOpenStreams();
      const text = event.data.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
      process.stdout.write(`${theme.muted("user>")} ${text.join(" ")}\n`);
      return;
    }

    case "interaction.opened": {
      closeOpenStreams();
      const { request } = event.data;
      const options = (request.options ?? []).map((option) => option.id).join(" | ") || "freeform";
      process.stdout.write(
        `${theme.muted("[input requested]")} ${theme.warning(`${request.kind}: ${request.prompt}, options: ${options}`)}\n`,
      );
      return;
    }

    case "model.settled":
    case "turn.settled":
    case "session.ended": {
      closeOpenStreams();
      const { error } = event.data;
      if (event.data.outcome === "failed" && error !== undefined) {
        process.stdout.write(theme.danger(`\n[${event.type}] ${error.code} ${error.message}\n`));
        if (error.hint) process.stdout.write(theme.muted(`${error.hint}\n`));
        return;
      }
      if (event.type === "turn.settled") {
        process.stdout.write(theme.muted(`[turn ${event.data.turnId} ${event.data.outcome}]\n`));
      }
      return;
    }

    case "model.started":
      process.stdout.write(theme.muted(`[model ${event.data.modelId}]\n`));
      return;

    case "delivery.admitted":
    case "delivery.settled":
    case "model.requested":
    case "usage.recorded":
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
