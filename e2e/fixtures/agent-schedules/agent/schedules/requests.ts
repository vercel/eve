import { defineScheduleCollection, defineScheduleDelivery } from "eve/experimental/schedules";
import { inMemoryScheduleProvider } from "eve/experimental/schedules/testing";
import { z } from "zod";
import {
  recordCollectionDelivery,
  recordCollectionOccurrence,
} from "../lib/collection-occurrences";

export default defineScheduleCollection({
  description: "Manage process-local demonstration requests for the scheduling fixture.",
  provider: inMemoryScheduleProvider(),
  request: z.string().min(1).max(2000),
  auth: async ({ principal }) => ({
    attributes: {},
    authenticator: principal.authenticator,
    principalId: principal.principalId,
    principalType: principal.type,
  }),
  deliveries: {
    "fixture-log": defineScheduleDelivery({
      description: "Record the result in the fixture's in-process delivery log. Plain text.",
      deliver: ({ content, occurrence }) =>
        Promise.resolve(recordCollectionDelivery(occurrence.name, content)),
    }),
  },
  events: {
    "occurrence.admitted": ({ name, sessionId }) => {
      if (sessionId) recordCollectionOccurrence(name, sessionId);
    },
  },
});
