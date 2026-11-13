import type { SessionContext } from "eve/context";

/**
 * Requires an authenticated human principal before Contentful mutation.
 *
 * @param ctx - Session containing the principal responsible for the current action.
 * @returns Completes when the current principal is a user.
 * @throws {@link Error} When authentication is missing or identifies a service principal.
 * @remarks Authorization is independent of organizational team membership.
 */
export const requireContentfulEditor = (ctx: {
  session: SessionContext["session"];
}): Promise<void> => {
  if (ctx.session.auth.current?.principalType !== "user") {
    return Promise.reject(
      new Error("An authenticated user is required to edit Contentful content.")
    );
  }
  return Promise.resolve();
};
