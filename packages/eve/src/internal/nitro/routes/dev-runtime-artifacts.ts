import { readDevelopmentRuntimeArtifactsRevision } from "#internal/nitro/dev-runtime-artifacts.js";

/**
 * Builds the dev-only runtime artifact revision response.
 *
 * Auth: none. The route is mounted only by the local dev server and exposes an
 * opaque revision plus, after startup, an opaque process identity.
 */
export function handleDevRuntimeArtifactsRequest(input: {
  appRoot: string;
  serverId?: string;
}): Response {
  const payload: ReturnType<typeof readDevelopmentRuntimeArtifactsRevision> & {
    serverId?: string;
  } = readDevelopmentRuntimeArtifactsRevision(input.appRoot);
  if (input.serverId !== undefined) {
    payload.serverId = input.serverId;
  }

  return Response.json(payload, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
