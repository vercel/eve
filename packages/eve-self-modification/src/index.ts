import { createRequire } from "node:module";

import type { AgentStaticModelDefinition } from "eve";
import type { NoConfigExtensionHandle } from "eve/extension";

import type { createSelfModificationAgent } from "./agent.js";
import type sandboxDefinition from "./sandbox.js";

const require = createRequire(import.meta.url);

/** Configuration for the self-modification subagent kit. */
export interface SelfModificationOptions {
  /**
   * Model used by the self-modification subagent.
   *
   * @default "anthropic/claude-sonnet-5"
   */
  readonly model?: AgentStaticModelDefinition;
}

/**
 * Defines the coordinated subagent, sandbox, and extension declarations for
 * self-modification. With no options, self-modification is available only during local development.
 */
export function defineSelfModification(options: SelfModificationOptions = {}) {
  const agentModule = require("@eve/self-modification/agent") as {
    readonly createSelfModificationAgent: typeof createSelfModificationAgent;
  };

  return {
    agent: agentModule.createSelfModificationAgent(options.model),
    extension: require("@eve/self-modification/extension").default as NoConfigExtensionHandle,
    sandbox: require("@eve/self-modification/sandbox").default as typeof sandboxDefinition,
  };
}
