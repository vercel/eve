const PRUNED_LOCAL_SANDBOX_MODULE_ID = "\0eve-pruned-local-sandbox-providers";
const LOCAL_BINDING_SOURCE_RE = /[/\\]bindings[/\\]local\.js$/;

interface BundlerPluginShape {
  readonly name: string;
  load?(id: string): string | null | undefined;
  resolveId?(
    source: string,
    importer: string | undefined,
  ): string | { id: string } | null | undefined;
}

/**
 * Creates the bundler plugin that prunes the local sandbox providers
 * (Docker, just-bash, microsandbox) from hosted Nitro server bundles.
 * Every local-provider export flows through `bindings/local.js`, so
 * stubbing that one module removes all of them; the stub mirrors the
 * facade's export surface.
 */
export function createCompiledSandboxProviderPrunePlugin(): BundlerPluginShape {
  return {
    name: "eve-hosted-sandbox-provider-prune",
    load(id) {
      if (id !== PRUNED_LOCAL_SANDBOX_MODULE_ID) {
        return null;
      }

      return [
        "function pruned() {",
        '  throw new Error("Local sandbox providers are pruned from hosted server bundles.");',
        "}",
        "export const createDockerSandboxProvider = pruned;",
        "export const createJustBashSandboxProvider = pruned;",
        "export const createMicrosandboxSandboxProvider = pruned;",
        "export const referenceDockerSandboxResource = pruned;",
        "export const referenceJustBashSandboxResource = pruned;",
        "export const referenceMicrosandboxResource = pruned;",
        "export const restoreDockerSandboxResource = pruned;",
        "export const restoreJustBashSandboxResource = pruned;",
        "export const restoreMicrosandboxResource = pruned;",
        'export const DOCKER_PROVIDER = "docker";',
        'export const JUST_BASH_PROVIDER = "just-bash";',
        'export const MICROSANDBOX_PROVIDER = "microsandbox";',
        "export const isDockerDaemonAvailableSync = () => false;",
        "export const isMicrosandboxPlatformSupported = () => false;",
        "export const pruneDockerSandboxTemplates = pruned;",
        "export const pruneJustBashSandboxTemplates = pruned;",
        "export const pruneMicrosandboxTemplates = pruned;",
        "export const pruneLocalSandboxTemplates = pruned;",
        "export const pruneLocalSandboxTemplatesInBackground = pruned;",
        "export const stopDevelopmentSandboxResources = pruned;",
        "",
      ].join("\n");
    },
    resolveId(source) {
      if (!LOCAL_BINDING_SOURCE_RE.test(source)) {
        return null;
      }

      return PRUNED_LOCAL_SANDBOX_MODULE_ID;
    },
  };
}
