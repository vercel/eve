import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";
import { mockModel } from "eve/evals";
import { playScript } from "@eve-e2e/config/mock-script";

const workerModel = mockModel({
  modelId: "nested-approval-worker",
  respond(request) {
    const authorization = request.userMessages.some((message) =>
      message.includes("Authorize Alice's release checklist."),
    );
    return authorization
      ? playScript(
          request,
          [{ id: "authorize", name: "authorization_gate", input: () => ({}) }],
          () => "NESTED-AUTHORIZED",
        )
      : playScript(
          request,
          [
            { id: "first", name: "first_gate" },
            { id: "second", name: "second_gate" },
          ],
          () => "NESTED-APPROVED",
        );
  },
});

export default defineAgent({
  description: "Collects Alice's or Bob's release checklist approvals or authorization.",
  model: defineDynamic({
    select: () => null,
    resolve: () => ({ model: workerModel, modelContextWindowTokens: 1_000_000 }),
  }),
});
