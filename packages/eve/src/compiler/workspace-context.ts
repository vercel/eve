export interface WorkspaceAgentCatalogEntry {
  readonly description?: string;
  readonly name: string;
  readonly path: string;
}

export interface CompileWorkspaceContext {
  readonly currentMemberName: string;
  readonly members: readonly WorkspaceAgentCatalogEntry[];
}
