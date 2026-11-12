/**
 * Storage for `eve/experimental/extensions/custom-skills`: the built-in
 * document repository, and what a custom `SkillRepository` implements and
 * throws.
 */
export { documentRepository, type DocumentRepositoryOptions } from "../document-repository.ts";
export { SkillConflictError, SkillNotFoundError } from "../errors.ts";
export type { SkillHead, SkillRepository, SkillVersionRecord } from "../repository.ts";
