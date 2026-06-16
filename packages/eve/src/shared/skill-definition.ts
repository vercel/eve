/**
 * File payload accepted for authored or runtime-created skill package
 * siblings. Strings are written as UTF-8; bytes are preserved exactly.
 */
export type SkillFileContent = string | Uint8Array;

/**
 * Public skill package content for authored skills and dynamic skill
 * resolvers.
 */
export interface SkillPackageDefinition {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Record<string, string>;
  readonly files?: Readonly<Record<string, SkillFileContent>>;
}

/**
 * Skill package with an explicit name. Used by compiled skill entries
 * (where the name is path-derived) and by dynamic skill resolvers
 * (where the name is qualified from the resolver slug + entry key).
 */
export interface NamedSkillDefinition extends SkillPackageDefinition {
  readonly name: string;
}
