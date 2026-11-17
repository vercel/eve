import { readDevelopmentRuntimeArtifactsRevision } from "#internal/nitro/dev-runtime-artifacts.js";

export function handleDevRuntimeArtifactsRequest(input: { appRoot: string }): Response {
  return Response.json(readDevelopmentRuntimeArtifactsRevision(input.appRoot), {
    headers: {
      "cache-control": "no-store",
    },
  });
}
