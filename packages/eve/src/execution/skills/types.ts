/**
 * A reference to one file inside a sandbox-backed skill directory.
 */
export interface SkillFile {
  /** Reads the file content as bytes. */
  bytes(): Promise<Uint8Array>;
  /** Reads the file content as UTF-8 text. */
  text(): Promise<string>;
}

/**
 * Handle to one authored skill, returned by `ctx.getSkill()`.
 *
 * Exposes skill metadata and reads files from a skill package.
 */
export interface SkillHandle {
  /** The skill identifier passed to `ctx.getSkill()`, used as the skill directory segment under the sandbox skills root. */
  readonly name: string;

  /**
   * Returns a file accessor for a path relative to the skill root.
   */
  file(relativePath: string): SkillFile;
}
