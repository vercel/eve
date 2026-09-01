/**
 * Types for the `workflow` specifiers eve resolves to its vendored SDK. Ambient,
 * so an installed `workflow` package takes precedence.
 */
declare module "workflow" {
  export * from "#internal/workflow/index.js";
}

declare module "workflow/api" {
  export * from "#internal/workflow/runtime.js";
}
