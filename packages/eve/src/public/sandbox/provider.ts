/**
 * Provider-authoring primitives for custom durable sandboxes.
 */
export {
  defineSandboxAdapter,
  type Sandbox,
  type SandboxAdapter,
  type SandboxAdapterDefinition,
  type SandboxProviderContext,
} from "#shared/sandbox-value.js";
export {
  defineSandboxTemplate,
  type SandboxTemplate,
  type SandboxTemplateAssets,
  type SandboxTemplateDefinition,
  type SandboxTemplatePrewarmInput,
} from "#shared/sandbox-template.js";
export type { SandboxSession } from "#shared/sandbox-session.js";
