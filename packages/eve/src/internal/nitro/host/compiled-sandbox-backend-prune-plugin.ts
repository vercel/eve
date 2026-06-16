const PRUNED_LOCAL_SANDBOX_MODULE_ID = "\0eve-pruned-local-sandbox-backends";
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
 * Creates the bundler plugin that prunes the local sandbox backends
 * (Docker, just-bash, microsandbox) from hosted Nitro server bundles.
 * Every local-engine export flows through `bindings/local.js`, so
 * stubbing that one module removes all of them; the stub mirrors the
 * facade's export surface.
 */
export function createCompiledSandboxBackendPrunePlugin(): BundlerPluginShape {
  return {
    name: "eve-hosted-sandbox-backend-prune",
    load(id) {
      if (id !== PRUNED_LOCAL_SANDBOX_MODULE_ID) {
        return null;
      }

      return [
        "function pruned() {",
        '  throw new Error("Local sandbox backends are pruned from hosted server bundles.");',
        "}",
        "export const createDockerSandboxBackend = pruned;",
        "export const createJustBashSandboxBackend = pruned;",
        "export const createMicrosandboxSandboxBackend = pruned;",
        'export const DOCKER_BACKEND_NAME = "docker";',
        'export const JUST_BASH_BACKEND_NAME = "just-bash";',
        'export const MICROSANDBOX_BACKEND_NAME = "microsandbox";',
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
