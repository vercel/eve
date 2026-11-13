import { people } from "@googleapis/people";
import type { ToolContext } from "eve/tools";
import { withGoogleAuth } from "./client";

export async function searchGoogleContacts(
  ctx: ToolContext,
  query: string,
  pageSize: number
) {
  const readMask = "names,emailAddresses,phoneNumbers,organizations";
  return withGoogleAuth(ctx, async (auth) => {
    const client = people({ auth, version: "v1" });
    const options = { signal: ctx.abortSignal };
    await client.people.searchContacts({ query: "", readMask }, options);
    const { data } = await client.people.searchContacts(
      { pageSize, query, readMask },
      options
    );
    return { contacts: data.results ?? [] };
  });
}
