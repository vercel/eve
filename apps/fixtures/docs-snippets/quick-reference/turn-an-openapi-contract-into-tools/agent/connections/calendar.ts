import { defineOpenAPIConnection } from "eve/connections";
import spec from "../../calendar-openapi.json";

export default defineOpenAPIConnection({
  spec,
  baseUrl: "https://api.example.com",
  description: "Read and schedule team calendar events.",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: process.env.CALENDAR_API_TOKEN! }),
  },
  operations: { allow: ["listEvents", "createEvent"] },
  approval: ({ toolName }) =>
    toolName === "calendar__createEvent" ? "user-approval" : "not-applicable",
});
