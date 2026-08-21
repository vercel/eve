import type { HarnessAgentHarness } from "#execution/harness-agent/types.js";

export const HARNESS_AGENT_HARNESSES = [
  "claude-code",
  "cline",
  "codex",
  "deepagents",
  "grok-build",
  "opencode",
  "pi",
] as const satisfies readonly HarnessAgentHarness[];

const BRIDGE_HARNESSES = new Set<HarnessAgentHarness>([
  "claude-code",
  "codex",
  "deepagents",
  "grok-build",
  "opencode",
]);

export function harnessUsesBridge(harness: HarnessAgentHarness): boolean {
  return BRIDGE_HARNESSES.has(harness);
}

export interface HarnessBridgeSettings {
  readonly port: number;
  readonly portEndpoint: { readonly url: string };
}

export async function loadHarnessAdapter(input: {
  readonly bridge?: HarnessBridgeSettings;
  readonly harness: HarnessAgentHarness;
  readonly model?: string;
}): Promise<unknown> {
  const modelSettings = input.model === undefined ? undefined : { model: input.model };

  switch (input.harness) {
    case "claude-code":
      return (await import("#compiled/@ai-sdk/harness-claude-code/index.js")).createClaudeCode(
        bridgeSettings(input),
      );
    case "cline":
      return (await import("#compiled/@ai-sdk/harness-cline/index.js")).createCline(
        input.model === undefined ? undefined : { modelId: input.model },
      );
    case "codex":
      return (await import("#compiled/@ai-sdk/harness-codex/index.js")).createCodex(
        bridgeSettings(input),
      );
    case "deepagents":
      return (await import("#compiled/@ai-sdk/harness-deepagents/index.js")).createDeepAgents(
        bridgeSettings(input),
      );
    case "grok-build":
      return (await import("#compiled/@ai-sdk/harness-grok-build/index.js")).createGrokBuild(
        bridgeSettings(input),
      );
    case "opencode":
      return (await import("#compiled/@ai-sdk/harness-opencode/index.js")).createOpenCode(
        bridgeSettings(input),
      );
    case "pi":
      return (await import("#compiled/@ai-sdk/harness-pi/index.js")).createPi(modelSettings);
  }
}

function bridgeSettings(input: {
  readonly bridge?: HarnessBridgeSettings;
  readonly harness: HarnessAgentHarness;
  readonly model?: string;
}): HarnessBridgeSettings & { readonly model?: string } {
  if (input.bridge === undefined) {
    throw new Error(`The ${input.harness} harness requires an acquired sandbox port.`);
  }
  return input.model === undefined ? input.bridge : { ...input.bridge, model: input.model };
}
