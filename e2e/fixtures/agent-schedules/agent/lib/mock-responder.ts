import type { MockModelRequest, MockModelResponse } from "eve/evals";

const SCHEDULE = "collection-email";
const EMAIL = { to: "alice@example.test", subject: "Scheduled note", body: "A fixture note." };
const UPDATED_EMAIL = {
  to: "alice@example.test",
  subject: "Updated note",
  body: "A revised fixture note.",
};

// World suites exercise the real tools without depending on model planning.
export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("This scheduled occurrence is firing now")) {
    const email = message.includes(UPDATED_EMAIL.subject) ? UPDATED_EMAIL : EMAIL;
    const reply = `Sent "${email.subject}" to ${email.to}.`;
    return once(request, "record-email", email, (output) => {
      if (!message.includes("disable this schedule")) return reply;
      const result: { accepted?: boolean } = JSON.parse(output);
      if (result.accepted !== true) return reply;
      const name = /Schedule management name: ([0-9A-Za-z._-]+)\./u.exec(message)?.[1];
      if (!name) throw new Error("The scheduled prompt needs a management name.");
      return once(request, "schedule__requests__disable", { name }, () => reply);
    });
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
          task: `Send a fixture email with subject "${UPDATED_EMAIL.subject}" and body "${UPDATED_EMAIL.body}". If record-email returns accepted: true, disable this schedule with schedule__requests__disable.`,
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

function once(
  request: MockModelRequest,
  name: string,
  input: unknown,
  onResult: (output: string) => MockModelResponse | string,
): MockModelResponse | string {
  const id = `${name}-${request.userMessageCount}`;
  const result = request.toolResults.find((entry) => entry.id === id);
  return result === undefined
    ? { toolCalls: [{ id, input, name }] }
    : onResult(typeof result.output === "string" ? result.output : JSON.stringify(result.output));
}
