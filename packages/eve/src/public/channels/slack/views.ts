/**
 * Delivers interactions with app-owned Slack views to `onView`. eve's own
 * freeform-answer modal never reaches it.
 */

import type {
  SlackViewClosedPayload,
  SlackViewSubmissionPayload,
} from "#compiled/@chat-adapter/slack/webhook.js";

import { createLogger, logError } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import type { InteractionHandlerDeps } from "#public/channels/slack/interactions.js";
import type {
  SlackViewContext,
  SlackViewEventFields,
  SlackViewResponse,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.views");

interface ViewDispatch {
  readonly deps: InteractionHandlerDeps;
  readonly installationTeamId: string | undefined;
  readonly waitUntil: (task: Promise<unknown>) => void;
}

/** Runs `onView` before Slack's acknowledgement so a submission can keep the modal open. */
export async function dispatchViewSubmit(
  payload: SlackViewSubmissionPayload,
  dispatch: ViewDispatch,
): Promise<Response> {
  const onView = dispatch.deps.config.onView;
  if (onView === undefined) return new Response(null, { status: 200 });

  const fields = viewEventFields(payload, dispatch.installationTeamId);
  try {
    const result = await onView(
      { ...fields, type: "submit", values: modalValues(payload.view) },
      viewContext(fields, dispatch),
    );
    return submitResponse(result);
  } catch (error) {
    // A 2xx would close the modal and discard what the person typed.
    logError(log, "onView failed", error, { callbackId: fields.callbackId, type: "submit" });
    return new Response("Unable to process modal submission", { status: 500 });
  }
}

/** Runs `onView` after the acknowledgement, because Slack ignores a close's response. */
export function dispatchViewClose(payload: SlackViewClosedPayload, dispatch: ViewDispatch): void {
  const onView = dispatch.deps.config.onView;
  if (onView === undefined) return;

  const fields = viewEventFields(payload, dispatch.installationTeamId);
  dispatch.waitUntil(
    Promise.resolve()
      .then(() =>
        onView(
          { ...fields, type: "close", isCleared: payload.raw.is_cleared === true },
          viewContext(fields, dispatch),
        ),
      )
      .catch((error: unknown) => {
        logError(log, "onView failed", error, { callbackId: fields.callbackId, type: "close" });
      }),
  );
}

function viewEventFields(
  payload: SlackViewSubmissionPayload | SlackViewClosedPayload,
  installationTeamId: string | undefined,
): SlackViewEventFields {
  const { view } = payload;
  return {
    callbackId: readString(view.callback_id) ?? "",
    viewId: readString(view.id) ?? "",
    privateMetadata: readString(view.private_metadata),
    user: { id: payload.userId, username: payload.user?.username, name: payload.user?.name },
    teamId: payload.user?.teamId ?? payload.teamId,
    installationTeamId,
    enterpriseId: payload.enterpriseId,
    raw: payload.raw,
  };
}

function viewContext(fields: SlackViewEventFields, dispatch: ViewDispatch): SlackViewContext {
  return {
    slack: buildSlackWorkspaceHandle({
      api: dispatch.deps.api,
      botToken: dispatch.deps.config.credentials?.botToken,
      installationTeamId: fields.installationTeamId,
      teamId: fields.teamId,
    }),
    waitUntil: dispatch.waitUntil,
  };
}

/**
 * Chat SDK's modal values, one string per action ID, extended to every
 * single-value Block Kit control. Controls with several values read as "".
 */
function modalValues(view: Record<string, unknown>): Record<string, string> {
  const state = isRecord(view.state) ? view.state : undefined;
  const blocks = isRecord(state?.values) ? state.values : {};
  const values: Record<string, string> = {};
  for (const block of Object.values(blocks)) {
    if (!isRecord(block)) continue;
    for (const [actionId, input] of Object.entries(block)) {
      if (!isRecord(input)) continue;
      const selected = isRecord(input.selected_option) ? input.selected_option : undefined;
      const dateTime = input.selected_date_time;
      values[actionId] =
        readString(input.value) ??
        readString(input.selected_date) ??
        readString(input.selected_time) ??
        (typeof dateTime === "number" ? String(dateTime) : undefined) ??
        readString(selected?.value) ??
        readString(input.selected_user) ??
        readString(input.selected_conversation) ??
        readString(input.selected_channel) ??
        "";
    }
  }
  return values;
}

function submitResponse(result: SlackViewResponse | void): Response {
  if (result === undefined || result.action === "close") return new Response(null, { status: 200 });
  switch (result.action) {
    case "clear":
      return Response.json({ response_action: "clear" });
    case "errors":
      return Response.json({ response_action: "errors", errors: result.errors });
    case "update":
    case "push":
      return Response.json({ response_action: result.action, view: result.view });
    default:
      throw new Error(
        `onView returned an unsupported response to a submission. Return nothing, or an object whose action is "close", "clear", "errors", "update", or "push".`,
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
