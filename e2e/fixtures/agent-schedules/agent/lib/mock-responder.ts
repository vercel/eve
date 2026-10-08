import type { MockModelRequest, MockModelResponse } from "eve/evals";

const SCHEDULE = "collection-email";
const EMAIL = { to: "alice@example.test", subject: "Scheduled note", body: "A fixture note." };
const UPDATED_EMAIL = {
  to: "alice@example.test",
  subject: "Updated note",
  body: "A revised fixture note.",
};

/**
 * Scripted mock for the world suites. Each `schedule-collection` eval prompt
 * names one action; the responder makes that call once and replies from its
 * output. Anything else keeps the default echo.
 */
export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("This scheduled occurrence is firing now")) {
    const email = message.includes(UPDATED_EMAIL.subject) ? UPDATED_EMAIL : EMAIL;
    return once(request, "record-email", email, () => `Sent "${email.subject}" to ${email.to}.`);
  }
  if (message.includes(`Create the schedule named ${SCHEDULE}`)) {
    const input = {
      name: SCHEDULE,
      expression: { type: "single", at: "2030-01-01T09:00", timezone: "UTC" },
      payload: {
        task: `Send a fixture email with subject "${EMAIL.subject}" and body "${EMAIL.body}".`,
        destination: "creator-email",
      },
    };
    return once(request, "schedule__requests__create", input, () => `Saved ${SCHEDULE}.`);
  }
  if (message.includes("Update the schedule using management name")) {
    const name = /management name ([0-9A-Za-z._-]+)\./u.exec(message)?.[1];
    if (!name) throw new Error("The update prompt needs a management name.");
    return once(
      request,
      "schedule__requests__update",
      {
        name,
        expression: { type: "single", at: "2030-01-02T09:00", timezone: "UTC" },
        payload: {
          task: `Send a fixture email with subject "${UPDATED_EMAIL.subject}" and body "${UPDATED_EMAIL.body}".`,
          destination: "creator-email",
        },
      },
      () => `Updated ${SCHEDULE}.`,
    );
  }
  for (const operation of ["get", "invoke", "delivery"] as const) {
    if (message.includes("share-schedule") && message.includes(OPERATION_PROMPTS[operation])) {
      return once(request, "share-schedule", { operation, name: SCHEDULE }, (output) => output);
    }
  }
  return `Mock reply: ${message}`;
}

const OPERATION_PROMPTS = {
  get: "get operation",
  invoke: "invoke",
  delivery: "delivered",
} as const;

/** Calls `name` once per prompt, then replies with `reply(output)`. */
function once(
  request: MockModelRequest,
  name: string,
  input: unknown,
  reply: (output: string) => string,
): MockModelResponse | string {
  const id = `${name}-${request.userMessageCount}`;
  const result = request.toolResults.find((entry) => entry.id === id);
  return result === undefined
    ? { toolCalls: [{ id, input, name }] }
    : reply(typeof result.output === "string" ? result.output : JSON.stringify(result.output));
}
