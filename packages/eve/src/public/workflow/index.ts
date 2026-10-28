/** Durable primitives for functions marked with `"use workflow"`. */
export {
  createHook,
  createWebhook,
  sleep,
  FatalError,
  getWorkflowMetadata,
} from "#internal/workflow/index.js";
