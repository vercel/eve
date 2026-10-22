const PRUNED_LOCAL_SANDBOX_MODULE_ID = "\0eve-pruned-local-sandbox-providers";
const PRUNED_LOCAL_SANDBOX_PROVIDER_MODULE_ID = "\0eve-pruned-local-sandbox-provider-constructors";
const LOCAL_BINDING_SOURCE_RE = /[/\\]bindings[/\\](?:docker|just-bash|local)\.(?:js|ts)$/;
const LOCAL_PROVIDER_SOURCE_RE =
  /(?:^|[/\\#])sandbox[/\\]providers[/\\](?:docker|just-bash)\.(?:js|ts)$/;

interface BundlerPluginShape {
  readonly enforce?: "pre";
  readonly name: string;
  load?(id: string): string | null | undefined;
  resolveId?(
    source: string,
    importer: string | undefined,
  ): string | { id: string } | null | undefined;
}

/**
 * Creates the bundler plugin that prunes the local sandbox providers
 * (Docker, just-bash) from hosted Nitro server bundles.
 * Stubs both the aggregate local facade and individual provider bindings so
 * framework default selection cannot retain local engine implementations.
 * `DefaultSandbox` stays real: on Vercel its build records Vercel Sandbox, so
 * it never constructs a stubbed local provider.
 */
export function createCompiledSandboxProviderPrunePlugin(): BundlerPluginShape {
  return {
    enforce: "pre",
    name: "eve-hosted-sandbox-provider-prune",
    load(id) {
      const sourcePath = id.split(/[?#]/u, 1)[0] ?? id;
      if (
        id === PRUNED_LOCAL_SANDBOX_PROVIDER_MODULE_ID ||
        LOCAL_PROVIDER_SOURCE_RE.test(sourcePath)
      ) {
        return [
          "function pruned() {",
          '  throw new Error("Local sandbox providers are pruned from hosted server bundles.");',
          "}",
          'export const DockerSandbox = { name: "docker", environment: pruned, dockerfile: pruned, image: pruned };',
          'export const JustBashSandbox = { name: "just-bash", environment: pruned };',
          "",
        ].join("\n");
      }
      if (id !== PRUNED_LOCAL_SANDBOX_MODULE_ID && !LOCAL_BINDING_SOURCE_RE.test(sourcePath)) {
        return null;
      }

      return [
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
    },
    resolveId(source) {
      const sourcePath = source.split(/[?#]/u, 1)[0] ?? source;
      if (LOCAL_PROVIDER_SOURCE_RE.test(sourcePath)) {
        return PRUNED_LOCAL_SANDBOX_PROVIDER_MODULE_ID;
      }
      if (!LOCAL_BINDING_SOURCE_RE.test(sourcePath)) return null;
      return PRUNED_LOCAL_SANDBOX_MODULE_ID;
    },
  };
}
