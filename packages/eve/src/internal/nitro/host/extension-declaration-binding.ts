import { resolve } from "node:path";

import type {
  AgentSourceOwner,
  CompiledModuleBacking,
  CompiledModuleBinding,
} from "#compiler/module-binding.js";
import { packageStateNamespace } from "#shared/extension-state-namespace.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

type FilesystemModuleBacking = Extract<CompiledModuleBacking, { readonly kind: "filesystem" }>;
type ExtensionSourceOwner = Extract<AgentSourceOwner, { readonly kind: "extension" }>;

/** The selected extension declaration and the only backing allowed to execute it. */
export type ExtensionDeclarationBinding = Omit<CompiledModuleBinding, "backing" | "owner"> & {
  readonly backing: FilesystemModuleBacking & {
    readonly extensionScope: NonNullable<FilesystemModuleBacking["extensionScope"]>;
  };
  readonly owner: ExtensionSourceOwner;
};

/** Binds the discovered declaration before any build phase loads or re-exports it. */
export function createExtensionDeclarationBinding(input: {
  readonly declarationModule: ModuleSourceRef;
  readonly namespace: string;
  readonly packageName: string;
  readonly runtimeDependencies: readonly string[];
  readonly sourceRoot: string;
}): ExtensionDeclarationBinding {
  return {
    backing: {
      externalDependencies: [...input.runtimeDependencies],
      extensionScope: {
        namespace: packageStateNamespace(input.packageName),
        sourceRoot: input.sourceRoot,
      },
      kind: "filesystem",
      sourcePath: resolve(input.sourceRoot, input.declarationModule.logicalPath),
    },
    logicalPath: input.declarationModule.logicalPath,
    owner: {
      kind: "extension",
      namespace: input.namespace,
      packageName: input.packageName,
    },
  };
}
