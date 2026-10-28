/** Durable primitives for functions marked with `"use workflow"`. */
export {
  createHook,
  createWebhook,
  sleep,
  FatalError,
  RetryableError,
  getWorkflowMetadata,
} from "#internal/workflow/index.js";
