import { compileAgent } from "#compiler/compile-agent.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import type { RuntimeDiskCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import {
  getCompiledRuntimeAgentBundle,
  type CompiledRuntimeAgentBundle,
} from "#runtime/sessions/compiled-agent-cache.js";
import {
  previewRunFor,
  previewTurn,
  type PreviewPrincipal,
  type TurnPreview,
} from "#services/turn-preview.js";

export interface DryRunFetch {
  readonly method: string;
  readonly url: string;
}

export interface SendDryRun {
  readonly message: string;
  readonly turn: TurnPreview;
  readonly fetches: readonly DryRunFetch[];
}

export interface DryRunApp {
  readonly manifest: CompiledAgentManifest;
  readonly bundle: CompiledRuntimeAgentBundle;
  readonly compiledArtifactsSource: RuntimeDiskCompiledArtifactsSource;
}

export async function loadDryRunApp(appRoot: string): Promise<DryRunApp> {
  const compiled = await compileAgent({ startPath: appRoot });
  const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(
    compiled.project.appRoot,
  );
  return {
    manifest: compiled.manifest,
    bundle: await getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
    compiledArtifactsSource,
  };
}

export async function withRecordedFetch<T>(
  fetches: DryRunFetch[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    const request = new Request(resource, init);
    fetches.push({ method: request.method, url: request.url });
    return Response.json({});
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

export async function dryRunSend(input: {
  readonly appRoot: string;
  readonly message: string;
  readonly principal: PreviewPrincipal;
}): Promise<SendDryRun> {
  const { bundle } = await loadDryRunApp(input.appRoot);
  const fetches: DryRunFetch[] = [];
  const turn = await withRecordedFetch(fetches, () =>
    previewTurn({ bundle, run: previewRunFor(input.principal, input.message) }),
  );
  return { fetches, message: input.message, turn };
}
