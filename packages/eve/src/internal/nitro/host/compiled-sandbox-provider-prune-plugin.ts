const PRUNED_DEFAULT_SANDBOX_MODULE_ID = "\0eve-pruned-default-sandbox-provider";
const PRUNED_LOCAL_SANDBOX_MODULE_ID = "\0eve-pruned-local-sandbox-providers";
const PRUNED_LOCAL_SANDBOX_PROVIDER_MODULE_ID = "\0eve-pruned-local-sandbox-provider-constructors";
const PRUNED_OCI_IMAGE_PUBLISHER_MODULE_ID = "\0eve-pruned-oci-image-publisher";
const PRUNED_OPTIONAL_ENGINE_INSTALL_MODULE_ID = "\0eve-pruned-optional-engine-install";
const DEFAULT_PROVIDER_SOURCE_RE = /(?:^|[/\\#])sandbox[/\\]providers[/\\]default\.(?:js|ts)$/;
const LOCAL_BINDING_SOURCE_RE =
  /[/\\]bindings[/\\](?:docker|just-bash|local|microsandbox)\.(?:js|ts)$/;
const LOCAL_PROVIDER_SOURCE_RE =
  /(?:^|[/\\#])sandbox[/\\]providers[/\\](?:docker|just-bash|microsandbox)\.(?:js|ts)$/;
const OCI_IMAGE_PUBLISHER_SOURCE_RE =
  /[/\\]execution[/\\]sandbox[/\\]bindings[/\\]oci-image-publisher\.(?:js|ts)$/;
const OPTIONAL_ENGINE_INSTALL_SOURCE_RE =
  /[/\\]internal[/\\]application[/\\]optional-package-install\.(?:js|ts)$/;

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
 * (Docker, just-bash, microsandbox) from hosted Nitro server bundles.
 * Stubs both the aggregate local facade and individual provider bindings so
 * framework default selection cannot retain local engine implementations.
 */
export function createCompiledSandboxProviderPrunePlugin(): BundlerPluginShape {
  return {
    enforce: "pre",
    name: "eve-hosted-sandbox-provider-prune",
    load(id) {
      const sourcePath = id.split(/[?#]/u, 1)[0] ?? id;
      if (id === PRUNED_DEFAULT_SANDBOX_MODULE_ID || DEFAULT_PROVIDER_SOURCE_RE.test(sourcePath)) {
        return [
          'import { VercelSandbox } from "#sandbox/providers/vercel.js";',
          "export const DefaultSandbox = VercelSandbox;",
          "export const SANDBOX_PROVIDER_PROBES = {};",
          "export function defineDefaultSandboxProvider() { return VercelSandbox; }",
          "",
        ].join("\n");
      }
      if (
        id === PRUNED_OCI_IMAGE_PUBLISHER_MODULE_ID ||
        OCI_IMAGE_PUBLISHER_SOURCE_RE.test(sourcePath)
      ) {
        return [
          "function pruned() {",
          '  throw new Error("OCI images cannot be published from a hosted server runtime.");',
          "}",
          "export const createOciImagePublisher = pruned;",
          "",
        ].join("\n");
      }
      if (
        id === PRUNED_OPTIONAL_ENGINE_INSTALL_MODULE_ID ||
        OPTIONAL_ENGINE_INSTALL_SOURCE_RE.test(sourcePath)
      ) {
        return [
          "function pruned() {",
          '  throw new Error("Optional local sandbox engines cannot be installed in hosted server runtimes.");',
          "}",
          "export const detectProjectPackageManager = pruned;",
          "export const importInstalledEnginePackage = pruned;",
          "export const installPackageIntoProject = pruned;",
          "export const loadOptionalEnginePackage = pruned;",
          "",
        ].join("\n");
      }
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
          'export const MicrosandboxSandbox = { name: "microsandbox", environment: pruned, dockerfile: pruned, image: pruned };',
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
        "export const createMicrosandboxSandboxProvider = pruned;",
        'export const DOCKER_PROVIDER_NAME = "docker";',
        'export const DOCKER_TEMPLATE_IMAGE_REPOSITORY = "eve-sandbox-template";',
        'export const JUST_BASH_PROVIDER_NAME = "just-bash";',
        'export const MICROSANDBOX_PROVIDER_NAME = "microsandbox";',
        "export const isLinuxDockerDaemonAvailableSync = () => false;",
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
      const sourcePath = source.split(/[?#]/u, 1)[0] ?? source;
      if (DEFAULT_PROVIDER_SOURCE_RE.test(sourcePath)) return PRUNED_DEFAULT_SANDBOX_MODULE_ID;
      if (LOCAL_PROVIDER_SOURCE_RE.test(sourcePath)) {
        return PRUNED_LOCAL_SANDBOX_PROVIDER_MODULE_ID;
      }
      if (OCI_IMAGE_PUBLISHER_SOURCE_RE.test(sourcePath)) {
        return PRUNED_OCI_IMAGE_PUBLISHER_MODULE_ID;
      }
      if (OPTIONAL_ENGINE_INSTALL_SOURCE_RE.test(sourcePath)) {
        return PRUNED_OPTIONAL_ENGINE_INSTALL_MODULE_ID;
      }
      if (!LOCAL_BINDING_SOURCE_RE.test(sourcePath)) return null;
      return PRUNED_LOCAL_SANDBOX_MODULE_ID;
    },
  };
}
