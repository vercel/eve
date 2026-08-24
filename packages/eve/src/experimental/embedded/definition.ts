import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import type { AgentDefinition } from "#public/definitions/agent.js";
import type { ExactDefinition } from "#public/definitions/exact.js";

const EMBEDDED_AGENT_BRAND = Symbol.for("eve.experimental.embedded-agent");
const EMBEDDED_AGENT_INSTRUCTIONS = Symbol.for("eve.experimental.embedded-agent.instructions");

export type EmbeddedAgentDefinition = AgentDefinition & {
  readonly instructions: string;
};

export type DefinedEmbeddedAgent<
  TDefinition extends EmbeddedAgentDefinition = EmbeddedAgentDefinition,
> = Omit<TDefinition, "instructions"> & {
  readonly [EMBEDDED_AGENT_BRAND]: true;
};

export interface LoadedEmbeddedAgentEntrypoint {
  readonly appRoot: string;
  readonly definition: AgentDefinition;
  readonly entrypointPath: string;
  readonly instructions: string;
  readonly moduleNamespace: Readonly<Record<string, unknown>>;
}

export function defineEmbeddedAgent<TDefinition extends EmbeddedAgentDefinition>(
  definition: ExactDefinition<TDefinition, EmbeddedAgentDefinition>,
): DefinedEmbeddedAgent<TDefinition>;
export function defineEmbeddedAgent(
  definition: EmbeddedAgentDefinition,
): DefinedEmbeddedAgent<EmbeddedAgentDefinition> {
  if (typeof definition !== "object" || definition === null) {
    throw new Error("Expected defineEmbeddedAgent(...) to receive an object definition.");
  }
  if (typeof definition.instructions !== "string") {
    throw new Error('Expected defineEmbeddedAgent(...) to receive a string "instructions" field.');
  }

  const { instructions, ...agentDefinition } = definition;
  Object.defineProperties(agentDefinition, {
    [EMBEDDED_AGENT_BRAND]: { value: true },
    [EMBEDDED_AGENT_INSTRUCTIONS]: { value: instructions },
  });
  return agentDefinition as DefinedEmbeddedAgent<EmbeddedAgentDefinition>;
}

export async function loadEmbeddedAgentEntrypoint(input: {
  readonly appRoot: string;
  readonly entrypoint: string;
}): Promise<LoadedEmbeddedAgentEntrypoint> {
  const requestedAppRoot = resolve(input.appRoot);
  const requestedEntrypointPath = resolve(requestedAppRoot, input.entrypoint);
  const requestedRelativeEntrypoint = relative(requestedAppRoot, requestedEntrypointPath);
  if (
    requestedRelativeEntrypoint === "" ||
    requestedRelativeEntrypoint.startsWith("..") ||
    isAbsolute(requestedRelativeEntrypoint)
  ) {
    throw embeddedEntrypointError(
      input.entrypoint,
      `The entrypoint must resolve to a file under the application root "${requestedAppRoot}".`,
    );
  }

  const appRoot = await resolveRealPath(requestedAppRoot, input.entrypoint, "application root");
  const entrypointPath = await resolveRealPath(
    requestedEntrypointPath,
    input.entrypoint,
    "entrypoint",
  );
  const relativeEntrypoint = relative(appRoot, entrypointPath);
  if (
    relativeEntrypoint === "" ||
    relativeEntrypoint.startsWith("..") ||
    isAbsolute(relativeEntrypoint)
  ) {
    throw embeddedEntrypointError(
      input.entrypoint,
      `The entrypoint must resolve to a file under the application root "${appRoot}".`,
    );
  }

  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = await loadAuthoredModuleNamespace(entrypointPath);
  } catch (error) {
    throw embeddedEntrypointError(input.entrypoint, "Failed to load the entrypoint.", error);
  }

  if (!Object.hasOwn(moduleNamespace, "default")) {
    throw embeddedEntrypointError(input.entrypoint, "The entrypoint must have a default export.");
  }

  const definition = moduleNamespace.default;
  if (
    typeof definition !== "object" ||
    definition === null ||
    Reflect.get(definition, EMBEDDED_AGENT_BRAND) !== true ||
    typeof Reflect.get(definition, EMBEDDED_AGENT_INSTRUCTIONS) !== "string"
  ) {
    throw embeddedEntrypointError(
      input.entrypoint,
      "The default export must be produced by defineEmbeddedAgent(...).",
    );
  }

  const message = `Expected the embedded agent default export from "${input.entrypoint}" to match the public eve agent shape.`;
  let normalizedDefinition: AgentDefinition;
  try {
    normalizedDefinition = normalizeAgentDefinition(definition, message) as AgentDefinition;
  } catch (error) {
    throw embeddedEntrypointError(input.entrypoint, "The default export is malformed.", error);
  }

  return {
    appRoot,
    definition: normalizedDefinition,
    entrypointPath,
    instructions: Reflect.get(definition, EMBEDDED_AGENT_INSTRUCTIONS) as string,
    moduleNamespace,
  };
}

async function resolveRealPath(path: string, entrypoint: string, kind: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw embeddedEntrypointError(entrypoint, `Failed to resolve the ${kind} at "${path}".`, error);
  }
}

function embeddedEntrypointError(entrypoint: string, message: string, cause?: unknown): Error {
  return new Error(`Invalid embedded agent entrypoint "${entrypoint}": ${message}`, { cause });
}
