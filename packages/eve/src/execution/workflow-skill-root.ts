import type { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

export async function resolveSessionSkillRoot(input: {
  readonly ctx: ContextContainer;
  readonly turnAgent: RuntimeTurnAgent;
}): Promise<string | undefined> {
  if ((input.turnAgent.availableSkills?.length ?? 0) === 0) {
    return undefined;
  }

  const access = input.ctx.get(SandboxKey);
  if (access === undefined) {
    return undefined;
  }

  const sandbox = await access.get();
  if (sandbox === null) {
    return undefined;
  }

  return await resolveSandboxSkillRoot({ sandbox });
}
