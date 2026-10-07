import { defineScheduleSubscription } from "eve/experimental/schedules";
import { inMemoryScheduleProvider } from "eve/experimental/schedules/testing";
import { z } from "zod";
import outbox from "../channels/outbox";
import { recordCollectionOccurrence } from "../lib/collection-occurrences";

export default defineScheduleSubscription({
  description:
    "Manage process-local fixture tasks. Destination creator-email means the creator's fixture email, not a model-selected address.",
  provider: inMemoryScheduleProvider(),
  schema: z
    .object({
      task: z.string().min(1).max(2000),
      destination: z.literal("creator-email"),
    })
    .strict(),
  // The fixture identity is local and fixed; production apps must revalidate their account system.
  auth: async ({ principal }) => ({
    attributes: { "fixture.email": "alice@example.test" },
    authenticator: principal.authenticator,
    issuer: principal.issuer,
    subject: principal.subject,
    principalId: principal.principalId,
    principalType: principal.type,
  }),
  async run({ payload, occurrence, to, auth }) {
    const recipient = auth.attributes["fixture.email"];
    if (payload.destination !== "creator-email" || typeof recipient !== "string")
      throw new Error("The creator has no authorized fixture email destination.");
    await to(outbox, { scheduleName: occurrence.name }).send(
      `This scheduled occurrence is firing now. Perform the task using record-email for ${recipient}. Do not create another schedule.\n\nTask: ${payload.task}`,
      { auth },
    );
  },
  events: {
    "occurrence.dispatched": ({ name, sessionIds }) => {
      if (sessionIds?.[0]) recordCollectionOccurrence(name, sessionIds[0]);
    },
  },
});
