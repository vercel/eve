import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createCompiledModuleMapIdentity } from "#compiler/module-map.js";

/** Guards a bundle against selected authored source changing after compilation. */
export function createCompiledModuleMapIntegrityPlugin(input: {
  readonly expectedIdentity: string;
  readonly manifest: CompiledAgentManifest;
  readonly resolveIdentity?: () => Promise<string>;
}): Record<string, unknown> {
  const resolveIdentity =
    input.resolveIdentity ?? (() => createCompiledModuleMapIdentity(input.manifest));
  const assertCurrent = async (): Promise<void> => {
    const currentIdentity = await resolveIdentity();
    if (currentIdentity !== input.expectedIdentity) {
      throw new Error(
        `Compiled module source changed while bundling artifacts: expected identity "${input.expectedIdentity}", received "${currentIdentity}".`,
      );
    }
  };

  return {
    name: "eve-compiled-module-map-integrity",
    buildStart: assertCurrent,
    buildEnd: assertCurrent,
  };
}
