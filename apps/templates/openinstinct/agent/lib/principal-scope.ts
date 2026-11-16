import type { ConnectionPrincipal } from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

const principalScopeSchema = z.object({
  attributes: z.object({
    workspaceId: z.string().min(1),
  }),
  id: z.string().min(1).optional(),
  principalId: z.string().min(1).optional(),
});

export function scopeFromPrincipal(
  input: SessionAuthContext | Extract<ConnectionPrincipal, { type: "user" }>
) {
  const principal = principalScopeSchema.parse(input);
  const userId = principal.id ?? principal.principalId;
  if (!userId) {
    throw new Error("An authenticated workspace user is required.");
  }
  const { workspaceId } = principal.attributes;
  if (
    userId.startsWith("better-auth:") &&
    accessScopeForUser(userId).workspaceId !== workspaceId
  ) {
    throw new Error("The workspace does not belong to the authenticated user.");
  }

  return { userId, workspaceId } satisfies AccessScope;
}
