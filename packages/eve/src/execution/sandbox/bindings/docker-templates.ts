import { type Dirent } from "node:fs";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type DockerCli, createDockerCli } from "#execution/sandbox/bindings/docker-cli.js";
import type { ResolvedDockerSandboxOptions } from "#execution/sandbox/bindings/docker-options.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";

/**
 * Local image repository holding prewarmed sandbox template images.
 * One tag per template key; sessions run containers from these images.
 */
export const DOCKER_TEMPLATE_IMAGE_REPOSITORY = "eve-sandbox-template";

/**
 * Removes stale Docker sandbox template images for one application.
 *
 * Template usage is tracked through per-app marker files (touched on
 * prewarm and session create) because Docker images carry only an
 * immutable creation time. Markers beyond the retain count and recency
 * window get their image untagged; the marker is kept when `rmi` fails
 * (for example while a session container still references the image)
 * so the template stays managed.
 */
export async function pruneDockerSandboxTemplates(input: {
  readonly appRoot: string;
  readonly dockerCli?: DockerCli;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const cli = input.dockerCli ?? createDockerCli();
  const markersDirectory = resolveDockerTemplateMarkersDirectory(input.appRoot);

  let entries: Dirent<string>[];
  try {
    entries = await readdir(markersDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const markers = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(markersDirectory, entry.name);
        return {
          imageTag: entry.name,
          mtimeMs: (await stat(path)).mtimeMs,
          path,
        };
      }),
  );

  const stale = selectStaleTemplateEntries(markers, {
    now: input.now ?? Date.now(),
    recentWindowMs: input.recentWindowMs ?? LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
    retainCount: input.retainCount ?? LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  });

  for (const marker of stale) {
    const result = await cli.run(["rmi", dockerTemplateImageReferenceFromTag(marker.imageTag)]);
    const missing = result.exitCode !== 0 && /no such image/i.test(result.stderr);
    if (result.exitCode === 0 || missing) {
      await rm(marker.path, { force: true });
    }
  }
}

export function dockerTemplateImageReference(input: {
  readonly optionsHash: string;
  readonly templateKey: string;
}): string {
  return dockerTemplateImageReferenceFromTag(dockerTemplateImageTag(input));
}

function dockerTemplateImageReferenceFromTag(imageTag: string): string {
  return `${DOCKER_TEMPLATE_IMAGE_REPOSITORY}:${imageTag}`;
}

function dockerTemplateImageTag(input: {
  readonly optionsHash: string;
  readonly templateKey: string;
}): string {
  // Docker repository tags are case-sensitive but repositories must be
  // lowercase; template keys are already lowercase hash material, the
  // lowering is defensive.
  return `${input.templateKey.toLowerCase()}-${input.optionsHash}`;
}

export function resolveDockerTemplateMarkerPath(
  appRoot: string,
  input: {
    readonly optionsHash: string;
    readonly templateKey: string;
  },
): string {
  return join(resolveDockerTemplateMarkersDirectory(appRoot), dockerTemplateImageTag(input));
}

export async function touchDockerTemplateMarker(
  markerPath: string,
  imageReference: string,
): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  try {
    const now = new Date();
    await utimes(markerPath, now, now);
  } catch {
    await writeFile(markerPath, `${imageReference}\n`);
  }
}

export async function dockerImageExists(cli: DockerCli, imageReference: string): Promise<boolean> {
  const result = await cli.run(["image", "inspect", "--format", "{{.Id}}", imageReference]);
  return result.exitCode === 0;
}

export async function ensureDockerBaseImage(
  cli: DockerCli,
  options: ResolvedDockerSandboxOptions,
): Promise<void> {
  if (options.pullPolicy === "always") {
    expectDockerSuccess(
      await cli.run(["pull", options.image]),
      `pull base image "${options.image}"`,
    );
    return;
  }

  if (await dockerImageExists(cli, options.image)) {
    return;
  }

  if (options.pullPolicy === "never") {
    throw new Error(
      `The local sandbox base image "${options.image}" is not present locally and ` +
        'pullPolicy is "never". Pull the image manually or relax the pull policy.',
    );
  }

  expectDockerSuccess(await cli.run(["pull", options.image]), `pull base image "${options.image}"`);
}

function resolveDockerTemplateMarkersDirectory(appRoot: string): string {
  return join(resolveSandboxCacheDirectory(appRoot), "docker", "templates");
}
