/**
 * Supported runtime contract for one module-authored eve definition.
 *
 * Module-backed authored sources may export the public definition directly or
 * export a zero-argument factory that returns the definition synchronously or
 * asynchronously when eve loads the module in Node.js at runtime.
 */
export type ModuleDefinitionExport<TDefinition> =
  | TDefinition
  | (() => TDefinition | Promise<TDefinition>);
