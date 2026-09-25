import { defineScheduleCollection } from "eve/experimental/schedules";
import { inMemoryScheduleProvider } from "eve/experimental/schedules/testing";

export default defineScheduleCollection({
  description: "Manage process-local demonstration requests for the scheduling fixture.",
  provider: inMemoryScheduleProvider(),
  scope: ({ session }) => session.id,
  runAs: "app",
});
