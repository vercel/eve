/**
 * The built-in scope resolvers and approval rule of
 * `eve/experimental/extensions/custom-skills`, to compose your own from.
 *
 * @example
 * ```ts
 * import customSkills from "eve/experimental/extensions/custom-skills";
 * import { defaultScopes, defaultSkillApproval } from "eve/experimental/extensions/custom-skills/policies";
 *
 * export default customSkills({
 *   scopes: async (ctx) => [...(await defaultScopes(ctx)), teamScope(ctx)],
 *   approval: {
 *     request: (change) => (change.scope.name === "team" ? "ask" : defaultSkillApproval(change)),
 *   },
 * });
 * ```
 */
export { defaultSkillApproval } from "../approval.ts";
export { defaultSkillValidator } from "../validation.ts";
export { defaultScopes, personalScope, spaceScope } from "../scopes.ts";
