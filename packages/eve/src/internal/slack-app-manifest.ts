import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { JsonObject } from "#shared/json.js";

export const SLACK_APP_MANIFEST_FORMAT = "slack-app-manifest";

export async function emitSlackAppManifests(input: {
  readonly manifest: CompiledAgentManifest;
  readonly outputDirectory: string;
}): Promise<void> {
  const manifests = collectSlackAppManifests(input.manifest);
  if (manifests.size === 0) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  for (const [path, manifest] of manifests) {
    const outputPath = join(input.outputDirectory, path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function collectSlackAppManifests(manifest: {
  readonly channelRoutes: {
    readonly effective: readonly Pick<
      CompiledAgentManifest["channelRoutes"]["effective"][number],
      "adapterKind" | "logicalPath" | "slackAppManifest"
    >[];
  };
}): ReadonlyMap<string, JsonObject> {
  const manifests = new Map<string, JsonObject>();
  for (const channel of manifest.channelRoutes.effective) {
    if (channel.adapterKind !== "slack" || channel.slackAppManifest === undefined) continue;
    manifests.set(slackAppManifestPath(channel.logicalPath), channel.slackAppManifest);
  }
  return manifests;
}

export function slackAppManifestPath(logicalPath: string): string {
  return `${logicalPath.replace(/\.[^/.]+$/, "")}.slack-app-manifest.json`;
}
