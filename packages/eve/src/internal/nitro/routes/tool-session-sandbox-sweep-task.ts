import {
  sweepToolSessionSandboxes,
  type ToolSessionSandboxSweepResult,
} from "#execution/tool-session/sandbox.js";
import { createLogger } from "#internal/logging.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const log = createLogger("tool-session.sweep");

/** The weekly task deleting the root agent's idle tool-session sandboxes. */
export async function runToolSessionSandboxSweepTask(
  config: NitroArtifactsConfig,
): Promise<ToolSessionSandboxSweepResult> {
  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const result = await sweepToolSessionSandboxes({
    compiledArtifactsSource,
    registry: bundle.graph.root.sandboxRegistry,
  });
  log.info("swept tool-session sandboxes", {
    deleted: result.deleted.length,
    failed: result.failed.length,
    skipped: result.skipped ?? null,
  });
  return result;
}
