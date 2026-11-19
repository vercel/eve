import { compileAgent } from "#compiler/compile-agent.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { AI_GATEWAY_MODELS_CATALOG_URL } from "#internal/gateway.js";
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

export async function dryRunApp<T>(
  appRoot: string,
  fn: (app: DryRunApp, fetches: readonly DryRunFetch[]) => Promise<T>,
): Promise<T> {
  const fetches: DryRunFetch[] = [];
  return await withRecordedFetch(fetches, async () => {
    const compiled = await compileAgent({ startPath: appRoot });
    const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(
      compiled.project.appRoot,
    );
    return await fn(
      {
        bundle: await getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
        compiledArtifactsSource,
        manifest: compiled.manifest,
      },
      fetches,
    );
  });
}

async function withRecordedFetch<T>(fetches: DryRunFetch[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    const request = new Request(resource, init);
    if (request.url === AI_GATEWAY_MODELS_CATALOG_URL) return await original(resource, init);
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
  return await dryRunApp(input.appRoot, async ({ bundle }, fetches) => ({
    fetches,
    message: input.message,
    turn: await previewTurn({ bundle, run: previewRunFor(input.principal, input.message) }),
  }));
}
