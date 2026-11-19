export interface SourceRef {
  sourceId: string;
  logicalPath: string;
}

export interface MarkdownSourceRef<TDefinition> extends SourceRef {
  sourceKind: "markdown";
  definition: TDefinition;
}

export interface ModuleSourceRef extends SourceRef {
  sourceKind: "module";
  exportName?: string;
}

export interface SkillPackageSourceRef extends SourceRef {
  sourceKind: "skill-package";
  skillId: string;
  skillFilePath: string;
  rootPath: string;
  assetsPath?: string;
  referencesPath?: string;
  scriptsPath?: string;
}
