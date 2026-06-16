import { readDevelopmentRuntimeArtifactsRevision } from "#internal/nitro/dev-runtime-artifacts.js";
import { flushDevelopmentRebuild } from "#internal/nitro/host/dev-rebuild-registry.js";

/**
 * Builds the dev-only runtime artifact revision response.
 *
 * Auth: none. The route is mounted only by the local dev server and exposes
 * only an opaque revision token that changes when HMR publishes a new runtime
 * snapshot.
 */
export function handleDevRuntimeArtifactsRequest(input: { appRoot: string }): Response {
  return Response.json(readDevelopmentRuntimeArtifactsRevision(input.appRoot), {
    headers: {
      "cache-control": "no-store",
    },
  });
}

export async function handleDevRuntimeArtifactsRebuildRequest(input: {
  appRoot: string;
}): Promise<Response> {
  await flushDevelopmentRebuild(input.appRoot);
  return handleDevRuntimeArtifactsRequest(input);
}
