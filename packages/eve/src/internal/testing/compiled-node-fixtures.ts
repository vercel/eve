import type {
  AgentSourceComposition,
  CompiledChannelRoutePlan,
  CompiledSandboxDefinition,
} from "#compiler/manifest.js";
import type { CompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { defineSandbox } from "#public/definitions/sandbox.js";

/**
 * Test-owned boilerplate for the required compiled-node fields introduced by
 * the canonical source graph. Production code never constructs these by
 * hand — tests that exercise runtime layers below the compiler use these
 * stable stand-ins, while compilation coverage goes through the real
 * compiler (`compileFromMemory` or fixture discovery).
 */

export const EMPTY_SOURCE_COMPOSITION: AgentSourceComposition = {
  disabled: [],
  shadowed: [],
};

export const EMPTY_CHANNEL_ROUTE_PLAN: CompiledChannelRoutePlan = {
  effective: [],
  preflight: [],
  shadowed: [],
};

/** Stable compiled sandbox record for hand-assembled runtime test nodes. */
export function testCompiledSandbox(
  overrides: Partial<CompiledSandboxDefinition> = {},
): CompiledSandboxDefinition {
  return {
    logicalPath: "sandbox.ts",
    sourceHash: "test-sandbox-hash",
    sourceId: "test:sandbox.ts",
    sourceKind: "module",
    ...overrides,
  };
}

/**
 * Module namespace for {@link testCompiledSandbox} entries in test module
 * maps: the framework-default sandbox definition, which selects the
 * environment default backend at resolution.
 */
export function testSandboxModuleNamespace(): Record<string, unknown> {
  return { default: defineSandbox({}) };
}

/**
 * Hermetic model-limits loader so compiler-level tests never reach the
 * network for AI Gateway metadata.
 */
export function testModelCatalogLoader(): CompiledRuntimeModelCatalogLoader {
  const limits = { contextWindowTokens: 200_000, maxOutputTokens: 64_000 };
  return {
    getByProviderModelId: async (provider, providerModelId) => ({
      limits,
      slug: `${provider}/${providerModelId}`,
    }),
    getModelLimits: async () => limits,
  };
}
