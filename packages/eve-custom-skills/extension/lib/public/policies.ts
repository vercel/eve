/**
 * The built-in scope resolvers and approval rule of
 * `eve/extensions/custom-skills`, to compose your own from.
 *
 * @example
 * ```ts
 * import customSkills from "eve/extensions/custom-skills";
 * import { defaultScopes, defaultSkillApproval } from "eve/extensions/custom-skills/policies";
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
export { defaultScopes, personalScope, spaceScope } from "../scopes.ts";
export type {
  SkillApprovalDecision,
  SkillApprovalRequest,
  SkillApprovalRule,
  SkillScope,
  SkillScopeContext,
  SkillScopeResolver,
} from "../types.ts";
