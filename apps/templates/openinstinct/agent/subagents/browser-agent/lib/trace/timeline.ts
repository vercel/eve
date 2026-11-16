import { call, interaction } from "eve/events";
import { contentText, deliveredText } from "@agent/lib/content-text";
import type { HookContext, HookEvent } from "eve/hooks";
import { z } from "zod";

export interface TraceTimelineRow {
  readonly at: string;
  readonly detail: string;
  readonly id: string;
  readonly label: string;
  readonly type: string;
}

const detailCharacterLimit = 600;

function compactJson(value: Parameters<typeof JSON.stringify>[0]) {
  const serialized = JSON.stringify(value, (_key, entry) => {
    const text = z.string().safeParse(entry);
    if (text.success && text.data.length > 200) {
      return `${text.data.slice(0, 200)}… [${String(text.data.length)} chars]`;
    }
    const jsonValue = z.json().safeParse(entry);
    return jsonValue.success ? jsonValue.data : undefined;
  });
  return serialized.length > detailCharacterLimit
    ? `${serialized.slice(0, detailCharacterLimit)}…`
    : serialized;
}

export function traceTimelineRows(
  event: HookEvent,
  ctx: Pick<HookContext, "now" | "position" | "view">
): TraceTimelineRow[] {
  const id = `${String(ctx.position.line)}:${String(ctx.position.index)}`;
  const at = ctx.now.toISOString();
  const row = (label: string, detail: string): TraceTimelineRow => ({
    at,
    detail: detail.slice(0, detailCharacterLimit),
    id,
    label,
    type: event.type,
  });

  switch (event.type) {
    case "delivery.consumed":
      return [row("Task received", deliveredText(event.data.parts))];
    case "call.requested": {
      const { capability, input } = event.data;
      return [
        row(
          capability.kind === "skill" ? "Load skill" : capability.name,
          compactJson(input)
        ),
      ];
    }
    case "call.settled": {
      const name = call(ctx.view, event.data.callId)?.name ?? "call";
      const failed = event.data.outcome !== "completed";
      return [
        row(
          `${name} → ${failed ? "error" : "result"}`,
          compactJson(failed ? event.data.error : event.data.output)
        ),
      ];
    }
    case "content.completed":
      if (event.data.kind === "result") {
        return [row("Final output", compactJson(event.data.value))];
      }
      return event.data.kind === "text"
        ? [row("Assistant", contentText([event.data]))]
        : [];
    case "interaction.opened": {
      const { request } = event.data;
      return request.kind === "sign-in"
        ? [row("Authorization required", request.signIn?.name ?? "")]
        : [row("Input requested", request.prompt)];
    }
    case "interaction.settled": {
      const opened = interaction(ctx.view, event.data.interactionId);
      return opened?.request.kind === "sign-in"
        ? [row("Authorization", event.data.outcome)]
        : [row("Input resolved", compactJson(event.data.response ?? null))];
    }
    case "model.settled":
      return event.data.outcome === "failed"
        ? [row("Step failed", event.data.error?.message ?? "")]
        : [];
    case "turn.settled":
      switch (event.data.outcome) {
        case "failed":
          return [row("Turn failed", event.data.error?.message ?? "")];
        case "cancelled":
          return [row("Turn cancelled", "")];
        default:
          return [row("Turn completed", "")];
      }
    case "session.started":
      return [row("Session started", "")];
    case "session.ended":
      return [
        row(
          event.data.outcome === "failed"
            ? "Session failed"
            : "Session completed",
          ""
        ),
      ];
    case "context.started":
      return event.data.kind === "compaction"
        ? [row("Context compaction", "")]
        : [];
    default:
      return [];
  }
}
