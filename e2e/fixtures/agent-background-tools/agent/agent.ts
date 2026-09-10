import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const PROGRESS = "EXPORT-PROGRESS";
const RESULT = "EXPORT-COMPLETE";
const SCHEDULED = "BACKGROUND-EXPORT-SCHEDULED";
const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message =
    [...request.userMessages]
      .reverse()
      .find(
        (entry) =>
          entry.includes("BACKGROUND-EXPORT-") || /^(?:Background task|Export) task_/u.test(entry),
      ) ??
    request.userMessages.at(-1) ??
    "";

  const examplePrefix = "Alice is documenting conditional delivery. Return exactly this example:\n";
  if (message.startsWith(examplePrefix)) {
    return message.slice(examplePrefix.length);
  }
  if (message === "Repeat your previous assistant response verbatim.") {
    return (
      [...request.messages].reverse().find((entry) => entry.role === "assistant")?.text ??
      "No previous assistant response."
    );
  }

  if (request.userMessages.some((entry) => entry.includes(SCHEDULED))) {
    return respondScheduled(request);
  }

  if (message.includes("BACKGROUND-EXPORT-START")) {
    if (!request.toolResults.some((result) => result.name === "export")) {
      return {
        toolCalls: [
          {
            name: "export",
            input: { query: "ship-it" },
          },
        ],
      };
    }
    return "BACKGROUND-EXPORT-STARTED";
  }

  if (message.includes(PROGRESS)) {
    return "BACKGROUND-EXPORT-UPDATE-RECEIVED";
  }

  if (
    message.includes("is completed") &&
    (message.includes(RESULT) || message.includes("ship-it"))
  ) {
    return "BACKGROUND-EXPORT-DONE";
  }

  if (message.startsWith("Background task ")) {
    return "BACKGROUND-EXPORT-ACK";
  }

  return "BACKGROUND-EXPORT-IDLE";
}

function respondScheduled(request: MockModelRequest): MockModelResponse | string {
  const taskNotification = [...request.userMessages]
    .reverse()
    .find((entry) => /^(?:Background task|Export) task_[a-z0-9]+/iu.test(entry));
  if (taskNotification?.includes("is completed") && taskNotification.includes(RESULT)) {
    return "SCHEDULED-EXPORT-DONE";
  }
  const launched = request.toolResults.some((result) => result.name === "export");
  if (!launched && taskNotification === undefined) {
    return {
      toolCalls: [
        {
          name: "export",
          input: { query: "nightly" },
        },
      ],
    };
  }
  const instructedToAcknowledge = request.messages.some((entry) =>
    entry.text.includes("launch acknowledgement"),
  );
  return instructedToAcknowledge ? "SCHEDULED-EXPORT-LAUNCH-ACK" : EMPTY_DELIVERY_SENTINEL;
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  // Always author the deterministic script so this fixture never depends on a
  // live model; world suites already set EVE_E2E_MODEL=mock.
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
