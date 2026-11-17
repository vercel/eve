export type ModuleDefinitionExport<TDefinition> =
  | TDefinition
  | (() => TDefinition | Promise<TDefinition>);
