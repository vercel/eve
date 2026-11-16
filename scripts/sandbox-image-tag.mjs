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
// changes when either does. eve pins both tags in source.
//
//   node scripts/sandbox-image-tag.mjs           print the tag
//   node scripts/sandbox-image-tag.mjs --git     print the eve-git tag
//   node scripts/sandbox-image-tag.mjs --check   fail when a pinned tag is stale
//   node scripts/sandbox-image-tag.mjs --write   update the pinned tags

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dockerfilePath = fileURLToPath(new URL("../packages/eve/Dockerfile", import.meta.url));
const gitDockerfilePath = fileURLToPath(new URL("../packages/eve/Dockerfile.git", import.meta.url));
const pinnedTagPath = fileURLToPath(
  new URL("../packages/eve/src/execution/sandbox/bindings/eve-image.ts", import.meta.url),
);

const dockerfile = await readDockerfile(dockerfilePath, "packages/eve/Dockerfile");
const gitDockerfile = await readDockerfile(gitDockerfilePath, "packages/eve/Dockerfile.git");

const tag = `dockerfile-${hash(dockerfile)}`;
const gitTag = `git-${hash(`${tag}\n${gitDockerfile}`)}`;
const mode = process.argv[2];

if (mode === undefined) {
  console.log(tag);
} else if (mode === "--git") {
  console.log(gitTag);
} else if (mode === "--check" || mode === "--write") {
  const pins = [
    { constant: "EVE_SANDBOX_IMAGE_TAG", dockerfile: "packages/eve/Dockerfile", tag },
    {
      constant: "EVE_GIT_SANDBOX_IMAGE_TAG",
      dockerfile: "packages/eve/Dockerfile.git",
      tag: gitTag,
    },
  ];
  let source = await readFile(pinnedTagPath, "utf8");
  let stale = false;
  for (const pin of pins) {
    const pattern = new RegExp(`const ${pin.constant} = "([^"]*)";`);
    const pinned = source.match(pattern)?.[1];
    if (pinned === undefined) {
      fail(`Could not find ${pin.constant} in ${pinnedTagPath}.`);
    }
    if (pinned === pin.tag) {
      console.log(`${pin.constant} is up to date: ${pin.tag}`);
    } else if (mode === "--write") {
      source = source.replace(pattern, `const ${pin.constant} = "${pin.tag}";`);
      console.log(`Updated ${pin.constant}: ${pinned} -> ${pin.tag}`);
    } else {
      stale = true;
      console.error(
        `${pin.constant} ${pinned} does not match ${pin.dockerfile} (${pin.tag}). Run \`pnpm sandbox-image:tag --write\`.`,
      );
    }
  }
  if (stale) process.exit(1);
  if (mode === "--write") await writeFile(pinnedTagPath, source);
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
