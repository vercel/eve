import { defineTool } from "eve/tools";
import { schedules } from "eve/experimental/schedules";
import { z } from "zod";
import personal from "../schedules/requests";
import { takeCollectionDelivery, takeCollectionOccurrence } from "../lib/collection-occurrences";

export default defineTool({
  description:
    "Inspect or invoke a schedule through the principal-authorized custom client, or read what its last occurrence delivered.",
  inputSchema: z
    .object({ operation: z.enum(["get", "invoke", "delivery"]), name: z.string().min(1) })
    .strict(),
  async execute({ operation, name }) {
    const client = await schedules(personal);
    if (operation === "get") return await client.get(name);
    if (operation === "delivery") return { content: takeCollectionDelivery(name) ?? null };
    await client.invoke(name);
    const sessionId = takeCollectionOccurrence(name);
    if (!sessionId) throw new Error("Local collection invocation did not report admission.");
    return { accepted: true, sessionId };
  },
});
