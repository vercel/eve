import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getOnePassword } from "../../server/onepassword/oauth";
import { onePasswordPrincipal, safeOnePassword } from "../lib/onepassword-auth";
export default defineTool({
  description: "Revoke this sender's entire personal 1Password connection and all login grants. Requires consent. A failed revoke remains blocked and can be retried.",
  inputSchema: z.object({}), approval: always(),
  execute: (_, ctx) => safeOnePassword(() => getOnePassword().disconnect(onePasswordPrincipal(ctx))),
});
