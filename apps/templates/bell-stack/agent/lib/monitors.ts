import type { ToolContext } from "eve/tools";
import { assertOwner, destinationSchema } from "../../server/monitors/config";

export function watchIdentity(ctx: ToolContext) {
  const auth = ctx.session.auth.current;
  if (!auth || auth.authenticator !== "linq-message" || auth.principalType !== "user") throw new Error("Watches require an authenticated Linq sender.");
  const owner = { issuer: auth.issuer ?? "", id: auth.principalId };
  assertOwner(owner);
  return owner;
}
export function watchDestination(ctx: ToolContext) {
  watchIdentity(ctx);
  const attributes = ctx.session.auth.current!.attributes;
  return destinationSchema.parse({ chat: attributes.bell_watch_chat, sender: attributes.bell_watch_sender, line: attributes.bell_watch_line });
}
export async function safeWatch<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(Watches |Watch not found|Watch operation|This Linq)/.test(message)) throw new Error(message);
    throw new Error("Watch operation failed. List watches before retrying creation; an uncertain watch may already exist.");
  }
}
