/**
 * Storage for `eve/extensions/custom-skills`: the built-in document
 * repository, and the errors a custom `SkillRepository` throws.
 */
export { documentRepository, type DocumentRepositoryOptions } from "../document-repository.ts";
export { SkillConflictError, SkillLifecycleError, SkillNotFoundError } from "../errors.ts";
export type {
  AppendVersionRequest,
  AppendVersionResult,
  RemoveSkillsResult,
  SkillCatalog,
  SkillHead,
  SkillHeadUpdate,
  SkillRepository,
  SkillVersionRecord,
  SkillVersionRef,
} from "../repository.ts";
export type { SkillRef } from "../types.ts";
