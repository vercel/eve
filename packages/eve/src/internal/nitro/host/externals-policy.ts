import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { resolvePackageSourceDirectoryPath } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

/**
 * Optional sandbox engines eve's runtime reaches through lazy dynamic imports.
 * Bundlers follow literal dynamic imports, so mere resolvability (for example
 * eve's own workspace devDependencies) would pull them into every hosted
 * build. The compiled sandbox config's backend names are the app's opt-in.
 */
const OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME: Readonly<Record<string, string>> = {
  "just-bash": "just-bash",
};

const LOCAL_SANDBOX_BACKEND_NAMES = new Set([
  "docker",
  ...Object.keys(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME),
]);

/** How the host build treats packages it does not bundle, computed once per build. */
export interface ExternalsPolicy {
  /** Packages Nitro externalizes and traces into production output, beyond its own database. */
  readonly traceDeps: readonly string[];
  /** Imports kept external and untraced: optional engines the app did not configure. */
  readonly untracedExternals: readonly string[];
  /** Configured externals whose resolution from the written output is checked. */
  readonly checkedExternals: readonly string[];
  /** Stubs local sandbox providers out of hosted output. */
  readonly pruneSandboxProviders: boolean;
  /** Stubs development-only sandbox preparation out of production output. */
  readonly pruneDevelopmentRuntime: boolean;
}

export function createExternalsPolicy(input: {
  readonly manifest: CompiledAgentManifest;
  readonly development: boolean;
  readonly preset: "vercel" | undefined;
}): ExternalsPolicy {
  const { manifest } = input;
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const backendNames = new Set(
    nodes
      .map((node) => node.sandbox?.providerName)
      .filter((providerName): providerName is string => providerName !== undefined),
  );
  const configuredEngines: string[] = [];
  const untracedExternals: string[] = [];
  for (const [backendName, packageName] of Object.entries(
    OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
  )) {
    (backendNames.has(backendName) ? configuredEngines : untracedExternals).push(packageName);
  }
  const configuredExternals = [
    ...(manifest.config.build?.externalDependencies ?? []),
    ...manifest.subagents.flatMap((subagent) =>
      subagent.configResolver === undefined
        ? (subagent.agent.config.build?.externalDependencies ?? [])
        : [],
    ),
  ];
  const extensionMounts = nodes.flatMap((node) => node.extensionMounts);
  const extensionExternals = extensionMounts.flatMap((mount) => mount.externalDependencies);

  const production = !input.development;
  return {
    checkedExternals: production ? configuredExternals : [],
    pruneDevelopmentRuntime: production,
    // On Vercel, `DefaultSandbox.environment()` records Vercel Sandbox, so
    // local providers are reachable only when the app configured one.
    pruneSandboxProviders:
      input.preset === "vercel" &&
      ![...backendNames].some((backendName) => LOCAL_SANDBOX_BACKEND_NAMES.has(backendName)),
    // Nitro externalizes without tracing in dev.
    traceDeps: production
      ? [
          ...new Set([
            ...configuredEngines,
            ...configuredExternals,
            ...extensionExternals.map((dependency) => `${dependency}*`),
          ]),
        ].filter(
          (dependency) => dependency !== EVE_PACKAGE_NAME && dependency !== `${EVE_PACKAGE_NAME}*`,
        )
      : [],
    untracedExternals,
  };
}

/** Modules Nitro must bundle rather than externalize. */
export function createHostNoExternals(stepTargets: readonly string[]): string[] {
  return [
    // Nitro bundled eve's execution sources while they were a scan directory.
    // Externalized, dev would load them natively beside the bundled copies of
    // the eve modules they import.
    `${resolvePackageSourceDirectoryPath("src/execution")}/`,
    ...stepTargets,
  ];
}
