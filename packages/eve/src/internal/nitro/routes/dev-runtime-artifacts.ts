import { readDevelopmentRuntimeArtifactsRevision } from "#internal/nitro/dev-runtime-artifacts.js";

export function handleDevRuntimeArtifactsRequest(input: {
  appRoot: string;
  serverId: string;
}): Response {
  return Response.json(
    { ...readDevelopmentRuntimeArtifactsRevision(input.appRoot), serverId: input.serverId },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
