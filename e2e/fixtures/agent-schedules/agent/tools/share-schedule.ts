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
    const records = (await client.list({ limit: 100 })).data;
    const matches = records.filter((record) => record.name === name || record.displayName === name);
    if (matches.length !== 1)
      throw new Error("Select exactly one fixture schedule by its unique name.");
    const managementName = matches[0]!.name;
    if (operation === "delivery")
      return { content: takeCollectionDelivery(managementName) ?? null };
    if (operation === "get") return await client.get(managementName);
    await client.invoke(managementName);
    const sessionId = takeCollectionOccurrence(managementName);
    if (!sessionId) throw new Error("Local subscription invocation did not report dispatch.");
    return { accepted: true, sessionId };
  },
});
