import { realpathSync } from "node:fs";

import { resolvePackageRoot } from "#internal/application/package.js";
import { exactRegex } from "#internal/bundler/filters.js";
import {
  type CheckedBundle,
  checkExternalDependencyOutput,
} from "#internal/nitro/host/external-dependency-output-check.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

const QUERY_SUFFIX = String.raw`(?:[?#].*)?$`;

// Nitro installs `unstorage` or `db0` on demand for these; eve's host
// configures neither and never lets Nitro install a package.
const NITRO_DATA_RUNTIME_RE = /^nitro\/(?:database|kv|storage)$/;

// eve's bundler loads Rolldown lazily; a hosted server never bundles, so eve's
// import must not make Nitro trace Rolldown and its native binding. Other
// importers keep their Rolldown.
const PRUNED_ROLLDOWN_ID = "\0eve-pruned-rolldown";
const ROLLDOWN_RE = /^rolldown(?:\/.*)?$/;
const PRUNED_ROLLDOWN_SOURCE =
  'throw new Error("Rolldown is not part of hosted eve servers: it bundles only during eve build and eve dev.");\n';

const PRUNED_DEVELOPMENT_LAZY_PREWARM_ID = "\0eve-pruned-development-lazy-prewarm";
const DEVELOPMENT_LAZY_PREWARM_SOURCE_RE = new RegExp(
  String.raw`(?:^|[/\\#])execution[/\\]sandbox[/\\]development-lazy-prewarm\.(?:js|ts)` +
    QUERY_SUFFIX,
);
const PRUNED_OPTIONAL_ENGINE_INSTALL_ID = "\0eve-pruned-optional-engine-install";
const OPTIONAL_ENGINE_INSTALL_SOURCE_RE = new RegExp(
  String.raw`(?:^|[/\\#])internal[/\\]application[/\\]optional-package-install\.(?:js|ts)` +
    QUERY_SUFFIX,
);

const PRUNED_LOCAL_SANDBOX_ID = "\0eve-pruned-local-sandbox-providers";
const PRUNED_LOCAL_SANDBOX_PROVIDER_ID = "\0eve-pruned-local-sandbox-provider-constructors";
const LOCAL_BINDING_SOURCE_RE = /[/\\]bindings[/\\](?:docker|just-bash|local)\.(?:js|ts)$/;
const LOCAL_PROVIDER_SOURCE_RE =
  /(?:^|[/\\#])sandbox[/\\]providers[/\\](?:docker|just-bash)\.(?:js|ts)$/;
// Filters see ids with a query; the handlers strip it before matching exactly.
const LOCAL_SANDBOX_SOURCE_FILTER = new RegExp(
  String.raw`(?:[/\\]bindings[/\\](?:docker|just-bash|local)|(?:^|[/\\#])sandbox[/\\]providers[/\\](?:docker|just-bash))\.(?:js|ts)` +
    QUERY_SUFFIX,
);

const PRUNED_DEVELOPMENT_LAZY_PREWARM_SOURCE =
  "export async function ensureDevelopmentSandboxesPrepared() {}\n" +
  "export function startDevelopmentSandboxesPrewarm() {}\n";

const PRUNED_OPTIONAL_ENGINE_INSTALL_SOURCE = [
  "function pruned() {",
  '  throw new Error("Optional local sandbox engines cannot be installed in production server runtimes.");',
  "}",
  "export const detectProjectPackageManager = pruned;",
  "export const importInstalledEnginePackage = pruned;",
  "export const installPackageIntoProject = pruned;",
  "export const loadOptionalEnginePackage = pruned;",
  "",
].join("\n");

const PRUNED_LOCAL_SANDBOX_PROVIDER_SOURCE = [
  "function pruned() {",
  '  throw new Error("Local sandbox providers are pruned from hosted server bundles.");',
  "}",
  'export const DockerSandbox = { name: "docker", environment: pruned, dockerfile: pruned, image: pruned };',
  'export const JustBashSandbox = { name: "just-bash", environment: pruned };',
  "",
].join("\n");

// Every export of `execution/sandbox/bindings/local.ts` must exist here.
const PRUNED_LOCAL_SANDBOX_SOURCE = [
  "function pruned() {",
  '  throw new Error("Local sandbox providers are pruned from hosted server bundles.");',
  "}",
  "export const createDockerSandboxProvider = pruned;",
  "export const createJustBashSandboxProvider = pruned;",
  'export const DOCKER_PROVIDER_NAME = "docker";',
  'export const DOCKER_TEMPLATE_IMAGE_REPOSITORY = "eve-sandbox-template";',
  'export const JUST_BASH_PROVIDER_NAME = "just-bash";',
  "export const isLinuxDockerDaemonAvailableSync = () => false;",
  "export const pruneDockerSandboxTemplates = pruned;",
  "export const pruneJustBashSandboxTemplates = pruned;",
  "export const pruneLocalSandboxTemplates = pruned;",
  "export const pruneLocalSandboxTemplatesInBackground = pruned;",
  "export const stopDevelopmentSandboxResources = pruned;",
  "",
].join("\n");

function stripQuery(id: string): string {
  return id.split(/[?#]/u, 1)[0] ?? id;
}

/**
 * Applies the externals policy's module substitutions to the hosted graph and
 * checks configured externals against the written output:
 *
 * - development-only sandbox preparation, the optional engine installer only
 *   it uses, and eve's own Rolldown import become stubs in production;
 * - local sandbox providers (Docker, just-bash) become stubs when the hosted
 *   build cannot reach them, so default selection never retains local engines;
 * - optional engines the app did not configure stay plain, untraced externals,
 *   so a resolvable but unrequested install adds nothing to the output and the
 *   lazy runtime import fails at first use with an install error;
 * - configured externals are checked against the written output;
 * - Nitro's storage and database runtimes are rejected, so no import can make
 *   Nitro install their drivers.
 */
export function createHostedGraphPlugin(input: {
  readonly appRoot: string;
  readonly externals: ExternalsPolicy;
}): HostedGraphPlugin {
  const { externals } = input;
  const pruneDevelopment = externals.pruneDevelopmentRuntime;
  const pruneSandbox = externals.pruneSandboxProviders;
  const untracedExternals = new Set(externals.untracedExternals);
  const evePackageRoot = pruneDevelopment ? realpathSync(resolvePackageRoot()) : undefined;
  const resolveFilter = [
    NITRO_DATA_RUNTIME_RE,
    ...(pruneDevelopment
      ? [DEVELOPMENT_LAZY_PREWARM_SOURCE_RE, OPTIONAL_ENGINE_INSTALL_SOURCE_RE, ROLLDOWN_RE]
      : []),
    ...(pruneSandbox ? [LOCAL_SANDBOX_SOURCE_FILTER] : []),
    ...[...untracedExternals].map((packageName) => exactRegex(packageName)),
  ];
  const loadFilter = [
    ...(pruneDevelopment
      ? [
          exactRegex(PRUNED_DEVELOPMENT_LAZY_PREWARM_ID),
          exactRegex(PRUNED_OPTIONAL_ENGINE_INSTALL_ID),
          OPTIONAL_ENGINE_INSTALL_SOURCE_RE,
          exactRegex(PRUNED_ROLLDOWN_ID),
        ]
      : []),
    ...(pruneSandbox
      ? [
          exactRegex(PRUNED_LOCAL_SANDBOX_ID),
          exactRegex(PRUNED_LOCAL_SANDBOX_PROVIDER_ID),
          LOCAL_SANDBOX_SOURCE_FILTER,
        ]
      : []),
  ];
  const plugin: HostedGraphPlugin = {
    name: "eve:hosted-graph",
    resolveId: {
      // Ahead of Nitro's externals hook, which would otherwise trace these.
      order: "pre",
      filter: { id: resolveFilter },
      handler(source, importer) {
        if (NITRO_DATA_RUNTIME_RE.test(source)) {
          throw new Error(
            `"${source}" is not available in eve agents: eve's server does not configure Nitro storage or databases. Keep data in agent state or memory (https://eve.dev/docs/concepts/state), or use your database's own client.`,
          );
        }
        if (untracedExternals.has(source)) return { external: true, id: source };
        if (pruneDevelopment && DEVELOPMENT_LAZY_PREWARM_SOURCE_RE.test(source)) {
          return PRUNED_DEVELOPMENT_LAZY_PREWARM_ID;
        }
        if (pruneDevelopment && OPTIONAL_ENGINE_INSTALL_SOURCE_RE.test(source)) {
          return PRUNED_OPTIONAL_ENGINE_INSTALL_ID;
        }
        if (
          evePackageRoot !== undefined &&
          ROLLDOWN_RE.test(source) &&
          importer !== undefined &&
          isPathInsideOrEqual(stripQuery(importer), evePackageRoot)
        ) {
          return PRUNED_ROLLDOWN_ID;
        }
        if (pruneSandbox && LOCAL_PROVIDER_SOURCE_RE.test(stripQuery(source))) {
          return PRUNED_LOCAL_SANDBOX_PROVIDER_ID;
        }
        if (pruneSandbox && LOCAL_BINDING_SOURCE_RE.test(stripQuery(source))) {
          return PRUNED_LOCAL_SANDBOX_ID;
        }
        return null;
      },
    },
  };
  // Optional hooks attach only when they have work, so no filter is ever empty.
  if (loadFilter.length > 0) {
    plugin.load = {
      filter: { id: loadFilter },
      handler(id) {
        if (pruneDevelopment && id === PRUNED_DEVELOPMENT_LAZY_PREWARM_ID) {
          return PRUNED_DEVELOPMENT_LAZY_PREWARM_SOURCE;
        }
        if (pruneDevelopment && id === PRUNED_ROLLDOWN_ID) {
          return PRUNED_ROLLDOWN_SOURCE;
        }
        if (
          pruneDevelopment &&
          (id === PRUNED_OPTIONAL_ENGINE_INSTALL_ID || OPTIONAL_ENGINE_INSTALL_SOURCE_RE.test(id))
        ) {
          return PRUNED_OPTIONAL_ENGINE_INSTALL_SOURCE;
        }
        if (
          pruneSandbox &&
          (id === PRUNED_LOCAL_SANDBOX_PROVIDER_ID || LOCAL_PROVIDER_SOURCE_RE.test(stripQuery(id)))
        ) {
          return PRUNED_LOCAL_SANDBOX_PROVIDER_SOURCE;
        }
        if (
          pruneSandbox &&
          (id === PRUNED_LOCAL_SANDBOX_ID || LOCAL_BINDING_SOURCE_RE.test(stripQuery(id)))
        ) {
          return PRUNED_LOCAL_SANDBOX_SOURCE;
        }
        return null;
      },
    };
  }
  if (externals.checkedExternals.length > 0) {
    plugin.writeBundle = async (outputOptions, bundle) => {
      await checkExternalDependencyOutput({
        appRoot: input.appRoot,
        bundle,
        externalDependencies: externals.checkedExternals,
        outputDir: outputOptions.dir,
      });
    };
  }
  return plugin;
}

interface HostedGraphPlugin {
  readonly name: string;
  resolveId: {
    readonly order: "pre";
    readonly filter: { readonly id: RegExp[] };
    handler(source: string, importer?: string): string | { external: true; id: string } | null;
  };
  load?: {
    readonly filter: { readonly id: RegExp[] };
    handler(id: string): string | null;
  };
  writeBundle?(outputOptions: { readonly dir: string }, bundle: CheckedBundle): Promise<void>;
}
