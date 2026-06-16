/**
 * Shared source ref base.
 */
export interface SourceRef {
  /**
   * Stable source id used across manifests, compiler artifacts, and runtime
   * loaders.
   */
  sourceId: string;
  /**
   * Agent-root-relative logical path for the authored source.
   */
  logicalPath: string;
}

/**
 * Shared source ref of kind "markdown".
 */
export interface MarkdownSourceRef<TDefinition> extends SourceRef {
  /**
   * Discriminator for markdown-backed sources.
   */
  sourceKind: "markdown";
  /**
   * Lowered public definition derived from the markdown source.
   */
  definition: TDefinition;
}

/**
 * Shared source ref of kind "module".
 */
export interface ModuleSourceRef extends SourceRef {
  /**
   * Discriminator for module-backed sources.
   */
  sourceKind: "module";
  /**
   * Optional module export name. Omitted values default to the module's default
   * export.
   */
  exportName?: string;
}

/**
 * Shared source ref of kind "skill-package".
 */
export interface SkillPackageSourceRef extends SourceRef {
  sourceKind: "skill-package";
  skillId: string;
  skillFilePath: string;
  rootPath: string;
  assetsPath?: string;
  referencesPath?: string;
  scriptsPath?: string;
}
