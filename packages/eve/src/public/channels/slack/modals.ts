/**
 * Delivers submissions and closes of app-owned Slack modals to `onModalSubmit`
 * and `onModalClose`. eve's own freeform-answer modal never reaches these hooks.
 */

import type {
  SlackViewClosedPayload,
  SlackViewSubmissionPayload,
} from "#compiled/@chat-adapter/slack/webhook.js";

import { createLogger, logError } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import type { InteractionHandlerDeps } from "#public/channels/slack/interactions.js";
import type {
  SlackModalContext,
  SlackModalEvent,
  SlackModalResponse,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.modals");

interface ModalDispatch {
  readonly deps: InteractionHandlerDeps;
  readonly installationTeamId: string | undefined;
  readonly waitUntil: (task: Promise<unknown>) => void;
}

/** Runs `onModalSubmit` before Slack's acknowledgement so it can keep the modal open. */
export async function handleModalSubmit(
  payload: SlackViewSubmissionPayload,
  dispatch: ModalDispatch,
): Promise<Response> {
  const onModalSubmit = dispatch.deps.config.onModalSubmit;
  if (onModalSubmit === undefined) return new Response(null, { status: 200 });

  const event = modalEvent(payload, dispatch.installationTeamId);
  try {
    const result = await onModalSubmit(
      { ...event, values: modalValues(payload.view) },
      modalContext(event, dispatch),
    );
    return modalResponse(result);
  } catch (error) {
    // A 2xx would close the modal and discard what the person typed.
    logError(log, "onModalSubmit failed", error, { callbackId: event.callbackId });
    return new Response("Unable to process modal submission", { status: 500 });
  }
}

/** Runs `onModalClose` after the acknowledgement, because Slack ignores its body. */
export function handleModalClose(payload: SlackViewClosedPayload, dispatch: ModalDispatch): void {
  const onModalClose = dispatch.deps.config.onModalClose;
  if (onModalClose === undefined) return;

  const event = modalEvent(payload, dispatch.installationTeamId);
  dispatch.waitUntil(
    Promise.resolve()
      .then(() =>
        onModalClose(
          { ...event, isCleared: payload.raw.is_cleared === true },
          modalContext(event, dispatch),
        ),
      )
      .catch((error: unknown) => {
        logError(log, "onModalClose failed", error, { callbackId: event.callbackId });
      }),
  );
}

function modalEvent(
  payload: SlackViewSubmissionPayload | SlackViewClosedPayload,
  installationTeamId: string | undefined,
): SlackModalEvent {
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

function modalContext(event: SlackModalEvent, dispatch: ModalDispatch): SlackModalContext {
  return {
    slack: buildSlackWorkspaceHandle({
      api: dispatch.deps.api,
      botToken: dispatch.deps.config.credentials?.botToken,
      installationTeamId: event.installationTeamId,
      teamId: event.teamId,
    }),
    waitUntil: dispatch.waitUntil,
  };
}

/** Chat SDK's modal values: one string per action ID, keeping a control's first value field. */
function modalValues(view: Record<string, unknown>): Record<string, string> {
  const state = isRecord(view.state) ? view.state : undefined;
  const blocks = isRecord(state?.values) ? state.values : {};
  const values: Record<string, string> = {};
  for (const block of Object.values(blocks)) {
    if (!isRecord(block)) continue;
    for (const [actionId, input] of Object.entries(block)) {
      if (!isRecord(input)) continue;
      const selected = isRecord(input.selected_option) ? input.selected_option : undefined;
      values[actionId] =
        readString(input.value) ??
        readString(input.selected_date) ??
        readString(selected?.value) ??
        "";
    }
  }
  return values;
}

function modalResponse(result: SlackModalResponse | void): Response {
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
        `onModalSubmit returned an unsupported response. Return nothing, or an object whose action is "close", "clear", "errors", "update", or "push".`,
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
