import { transformDynamicRemoteAgentCredentials } from "#internal/workflow-bundle/dynamic-remote-agent-transform.js";
import { transformDynamicToolExecute } from "#internal/workflow-bundle/dynamic-tool-transform.js";

export function createDynamicCapabilityTransformPlugin(
  options: {
    readonly dynamicRemoteAgents?: boolean;
    readonly dynamicTools?: boolean;
  } = {},
) {
  return {
    async transform(code: string, id: string) {
      const normalizedId = id.replaceAll("\\", "/");
      const transformDynamicTools =
        options.dynamicTools !== false && normalizedId.includes("/tools/");
      const transformDynamicRemoteAgents =
        options.dynamicRemoteAgents !== false && normalizedId.includes("/subagents/");
      if (!transformDynamicTools && !transformDynamicRemoteAgents) {
        return null;
      }

      let transformed = code;
      let changed = false;
      if (transformDynamicTools) {
        const result = await transformDynamicToolExecute(id, transformed);
        if (result !== null) {
          transformed = result.code;
          changed = true;
        }
      }
      if (transformDynamicRemoteAgents) {
        const result = await transformDynamicRemoteAgentCredentials(id, transformed);
        if (result !== null) {
          transformed = result.code;
          changed = true;
        }
      }

      return changed ? { code: transformed, map: null } : null;
    },
    name: "eve:dynamic-capability-transform",
  };
}
