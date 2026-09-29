import {
  defineWorkflowTool,
  type QuestionResponseContext,
  type QuestionResponseDecision,
} from "eve/tools";
import { z } from "zod";

async function authorizeSignoff({
  request,
  response,
}: QuestionResponseContext): Promise<QuestionResponseDecision> {
  "use step";
  const requester = request.principal;
  const responder = response.principal;
  return requester !== null &&
    requester.principalId === responder.principalId &&
    requester.principalType === responder.principalType &&
    requester.authenticator === responder.authenticator &&
    requester.issuer === responder.issuer
    ? { status: "allowed" }
    : { status: "rejected", reason: "The person who requested the release must answer." };
}

export default defineWorkflowTool({
  description: "Release a service after the person who asked for it signs off.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const answer = await ctx.ask(
      {
        display: "confirmation",
        options: [
          { id: "approve", label: "Release", style: "primary" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: `Release ${service}?`,
      },
      { response: authorizeSignoff },
    );
    return { released: answer.status === "answered" && answer.optionId === "approve", service };
  },
});
