import { defineTool } from "eve/tools";
import { z } from "zod";

import { revokeGrant } from "../../../lib/weather-grants";

/** Stands in for the person removing the app's weather access at the provider. */
export default defineTool({
  description: "Revoke the person's weather grant at the provider.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const person = ctx.session.auth.current?.principalId;
    if (person === undefined) throw new Error("Revoking the weather grant needs a person.");
    await revokeGrant(person);
    return { revoked: true };
  },
});
