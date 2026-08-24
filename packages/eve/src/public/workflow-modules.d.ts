/**
 * Type declarations for the Workflow SDK specifiers application code may
 * import. eve resolves `workflow` and `workflow/api` to the SDK version it
 * vendors, so an application does not install the package; TypeScript uses
 * these ambient declarations only when it cannot resolve the specifier to an
 * installed package, which keeps an installed `workflow` authoritative.
 */
declare module "workflow" {
  export * from "#internal/workflow/index.js";
}

declare module "workflow/api" {
  export * from "#internal/workflow/runtime.js";
}
