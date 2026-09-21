import type { DynamicResolveContext } from "#dynamic/definition.js";
import {
  defineDynamic,
  type AgentReasoningDefinition,
  type AgentStaticModelDefinition,
  type DynamicSentinel,
  type DynamicSubagentDefinition,
} from "#public/index.js";

/** Options retained for source compatibility with the retired scaffold. */
export interface SelfModificationAgentOptions {
  readonly config?: unknown;
  readonly model?: AgentStaticModelDefinition;
  readonly reasoning?: AgentReasoningDefinition;
}

let warned = false;
function warnRetiredScaffold(): void {
  if (warned || process.env.EVE_DEV !== "1") return;
  warned = true;
  console.warn(
    "[self-modification/retired-scaffold] The scaffolded self-modification subagent is disabled. Migrate to the new self-modification extension by running `/add eve/self-modification`.",
  );
}

/** @deprecated Use the packaged `eve/self-modification` extension. */
export function defineSelfModificationAgent(
  _options: SelfModificationAgentOptions = {},
): DynamicSentinel<DynamicSubagentDefinition | null> {
  const resolve = async (_event: unknown, _ctx: DynamicResolveContext): Promise<null> => {
    warnRetiredScaffold();
    return null;
  };
  return defineDynamic({
    events: { "session.started": resolve, "turn.started": resolve },
  });
}

/** @deprecated Use the packaged `eve/self-modification` extension. */
export default defineSelfModificationAgent();
