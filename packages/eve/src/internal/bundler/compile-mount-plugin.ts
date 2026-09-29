import type { AuthoredModuleLoadOptions } from "#internal/authored-module-loader.js";
import { createExtensionMountPlugin } from "#internal/bundler/extension-mount-plugin.js";
import { createExtensionScopePlugin } from "#internal/bundler/extension-scope-plugin.js";

/** Compile contributions with their declaration so config and callbacks share one handle. */
export function createCompileMountPlugins(
  modulePath: string,
  options: AuthoredModuleLoadOptions,
): Record<string, unknown>[] {
  const mount = options.mount;
  if (mount === undefined) return [];
  const tag = `?eve-mount=${encodeURIComponent(mount.mountId)}`;
  const declaration = mount.programmaticImport;
  return [
    {
      name: "eve-compile-mount-entry",
      resolveId(id: string) {
        return id === "\0eve-compile-mount-entry" || id === "\0eve-compile-mount-declaration"
          ? id
          : undefined;
      },
      load(id: string) {
        if (id === "\0eve-compile-mount-declaration" && declaration !== undefined) {
          return `import extension from ${JSON.stringify(declaration.specifier + tag)}; export default extension(${JSON.stringify(declaration.config)});`;
        }
        if (id !== "\0eve-compile-mount-entry") return undefined;
        const mountImport =
          declaration === undefined
            ? mount.mountSourcePath + tag
            : "\0eve-compile-mount-declaration";
        return `import ${JSON.stringify(mountImport)}; import * as entry from ${JSON.stringify(modulePath + tag)}; export * from ${JSON.stringify(modulePath + tag)}; export default entry.default;`;
      },
    },
    createExtensionMountPlugin([mount], new Map([[modulePath, mount.mountId]]))!,
    { ...createExtensionScopePlugin([mount])! },
  ];
}
