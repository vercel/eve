import { createRequire } from "node:module";

import type { AgentModelDefinition } from "eve";
import type { NoConfigExtensionHandle } from "eve/extension";

import type { createSelfmodAgent } from "./agent.js";
import type sandboxDefinition from "./sandbox.js";

const require = createRequire(import.meta.url);

/** Configuration for the selfmod subagent kit. */
export interface SelfmodOptions {
  /**
   * Model used by the selfmod subagent.
   *
   * @default "anthropic/claude-sonnet-5"
   */
  readonly model?: AgentModelDefinition;
}

/**
 * Defines the coordinated subagent, sandbox, and extension declarations for
 * selfmod. With no options, selfmod is available only during local development.
 */
export function defineSelfmod(options: SelfmodOptions = {}) {
  const agentModule = require("eve-selfmod/agent") as {
    readonly createSelfmodAgent: typeof createSelfmodAgent;
  };

  return {
    agent: agentModule.createSelfmodAgent(options.model),
    extension: require("eve-selfmod/extension").default as NoConfigExtensionHandle,
    sandbox: require("eve-selfmod/sandbox").default as typeof sandboxDefinition,
  };
}
