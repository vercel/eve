// How a v26 request, its resolution, and a sign-in read as v27 interactions. Both readers of v26
// share this: the history reader, which reads sessions an eve before v27 recorded, and the remote
// agent callback, which mirrors what a child on remote agent protocol 2 asks.
//
// Delete once neither v26 history nor protocol 2 children remain.

import type {
  InteractionOption,
  InteractionOutcome,
  InteractionRequest,
} from "#protocol/session-events/families/interaction.js";

type Data = Readonly<Record<string, unknown>>;

/** A v26 question, tool approval, or session limit as the request a v27 reader shows. */
export function v26InteractionRequest(request: Data): InteractionRequest {
  const kind =
    request.kind === "tool-approval"
      ? "approval"
      : request.kind === "session-limit"
        ? "budget"
        : "question";
  const options = Array.isArray(request.options)
    ? request.options.flatMap((option): InteractionOption[] =>
        isRecord(option) && typeof option.id === "string" && typeof option.label === "string"
          ? [
              {
                id: option.id,
                label: option.label,
                description: str(option.description),
                style:
                  option.style === "primary" ||
                  option.style === "danger" ||
                  option.style === "default"
                    ? option.style
                    : undefined,
              },
            ]
          : [],
      )
    : undefined;
  const display = request.display;
  return {
    allowFreeform: typeof request.allowFreeform === "boolean" ? request.allowFreeform : undefined,
    display:
      display === "confirmation" || display === "select" || display === "text"
        ? display
        : undefined,
    kind,
    options: options,
    prompt: str(request.prompt) ?? "",
  };
}

/** How a v26 resolution's outcome settles the interaction it resolved. */
export function v26InteractionOutcome(outcome: unknown): InteractionOutcome {
  switch (outcome) {
    case "answered":
    case "approved":
      return "accepted";
    case "denied":
      return "declined";
    case "invalid":
      return "invalid";
    default:
      // `cancelled` and `ignored`: the request was withdrawn without an answer.
      return "withdrawn";
  }
}

/** A v26 `authorization.required` event's data as the sign-in a v27 reader shows. */
export function v26SignInRequest(data: Data): InteractionRequest {
  const challenge = isRecord(data.authorization) ? data.authorization : {};
  const name = str(data.name) ?? "sign-in";
  const url = str(challenge.url);
  return {
    kind: "sign-in",
    link: url === undefined ? undefined : { url },
    prompt: str(data.description) ?? `Sign in to ${name}.`,
    signIn: {
      callbackUrl: str(data.webhookUrl),
      displayName: str(challenge.displayName),
      expiresAt: str(challenge.expiresAt),
      grant: str(data.grant),
      instructions: str(challenge.instructions),
      name,
      principal:
        isRecord(data.principal) && typeof data.principal.type === "string"
          ? {
              id: str(data.principal.id),
              issuer: str(data.principal.issuer),
              type: data.principal.type,
            }
          : undefined,
      url,
      userCode: str(challenge.userCode),
    },
  };
}

/** How a v26 `authorization.completed` outcome settles its sign-in. */
export function v26SignInOutcome(outcome: unknown): InteractionOutcome {
  return outcome === "authorized"
    ? "accepted"
    : outcome === "declined"
      ? "declined"
      : outcome === "timed-out"
        ? "expired"
        : "failed";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
