#!/usr/bin/env node
// Derives eve's sandbox image tag from the Dockerfile contents so a tag names
// exactly one image definition. eve pins the tag in source; the release
// workflow publishes it once and never rebuilds an existing tag.
//
// Build settings in .github/workflows/release.yml (platforms, compression,
// labels) and the floating `# syntax=` frontend are not hashed. Changing them
// does not produce a new tag; also edit the Dockerfile to publish a new image.
//
// The eve-git image (packages/eve/Dockerfile.git) layers `gh` on the default
// image. Its tag hashes the default image's tag plus Dockerfile.git, so it
// changes when either does. eve does not pin it in source.
//
//   node scripts/sandbox-image-tag.mjs           print the tag
//   node scripts/sandbox-image-tag.mjs --git     print the eve-git tag
//   node scripts/sandbox-image-tag.mjs --check   fail when the pinned tag is stale
//   node scripts/sandbox-image-tag.mjs --write   update the pinned tag

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dockerfilePath = fileURLToPath(new URL("../packages/eve/Dockerfile", import.meta.url));
const gitDockerfilePath = fileURLToPath(new URL("../packages/eve/Dockerfile.git", import.meta.url));
const pinnedTagPath = fileURLToPath(
  new URL("../packages/eve/src/execution/sandbox/bindings/eve-image.ts", import.meta.url),
);
const pinnedTagPattern = /const EVE_SANDBOX_IMAGE_TAG = "([^"]*)";/;

const dockerfile = await readDockerfile(dockerfilePath, "packages/eve/Dockerfile");

const tag = `dockerfile-${hash(dockerfile)}`;
const mode = process.argv[2];

if (mode === undefined) {
  console.log(tag);
} else if (mode === "--git") {
  const gitDockerfile = await readDockerfile(gitDockerfilePath, "packages/eve/Dockerfile.git");
  console.log(`git-${hash(`${tag}\n${gitDockerfile}`)}`);
} else if (mode === "--check" || mode === "--write") {
  const source = await readFile(pinnedTagPath, "utf8");
  const pinned = source.match(pinnedTagPattern)?.[1];
  if (pinned === undefined) {
    fail(`Could not find EVE_SANDBOX_IMAGE_TAG in ${pinnedTagPath}.`);
  }
  if (pinned === tag) {
    console.log(`Sandbox image tag is up to date: ${tag}`);
  } else if (mode === "--write") {
    await writeFile(
      pinnedTagPath,
      source.replace(pinnedTagPattern, `const EVE_SANDBOX_IMAGE_TAG = "${tag}";`),
    );
    console.log(`Updated sandbox image tag: ${pinned} -> ${tag}`);
  } else {
    fail(
      `Sandbox image tag ${pinned} does not match packages/eve/Dockerfile (${tag}). Run \`pnpm sandbox-image:tag --write\`.`,
    );
  }
} else {
  fail(`Unknown argument: ${mode}. Expected --git, --check, or --write.`);
}

// Only the Dockerfiles are hashed. Reading build-context files (COPY, ADD, or a
// RUN --mount) would let an image change without changing its tag.
async function readDockerfile(path, label) {
  const contents = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  if (/^\s*(COPY|ADD)\s|--mount=/im.test(contents)) {
    fail(
      `${label} reads build-context files (COPY, ADD, or RUN --mount). Include those files in the hash in scripts/sandbox-image-tag.mjs.`,
    );
  }
  return contents;
}

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex").slice(0, 12);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
