import type { FrameworkContextProvider } from "#context/provider.js";
import { AuthoredSkillsKey } from "#context/providers/skill-key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";

export const authoredSkillsProvider: FrameworkContextProvider<readonly ResolvedSkillDefinition[]> =
  {
    key: AuthoredSkillsKey,

    create(ctx) {
      const agent = ctx.get(BundleKey)?.resolvedAgent;
      if (agent === undefined) return undefined;
      return { value: agent.skills };
    },
  };
