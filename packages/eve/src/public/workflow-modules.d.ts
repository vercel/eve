/**
 * Types for the `workflow` specifiers eve resolves to its vendored SDK. Ambient,
 * so an installed `workflow` package takes precedence.
 */
declare module "workflow" {
  export {
    createHook,
    createWebhook,
    sleep,
    FatalError,
    getWorkflowMetadata,
  } from "#internal/workflow/index.js";
}

declare module "workflow/api" {
  export { start, getRun, resumeHook, getHookByToken } from "#internal/workflow/runtime.js";
}
