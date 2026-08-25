import { SkillCatalogKey } from "#context/providers/skill-catalog-key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";

export { SkillCatalogKey } from "#context/providers/skill-catalog-key.js";

export const skillCatalogProvider: FrameworkContextProvider<readonly ResolvedSkillDefinition[]> = {
  key: SkillCatalogKey,

  create(ctx, _session) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const skills = node.agent?.skills;
    if (!skills || skills.length === 0) return undefined;

    return { value: skills };
  },
};
