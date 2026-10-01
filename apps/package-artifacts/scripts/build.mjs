import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

import { resolveDeploymentTarget, vercelOidcCredentials } from "../lib/deployment-target.mjs";
import {
  packageArtifactPath,
  packageDependencySpecifier,
  packageDependencyUrl,
  packageManifestPath,
  packagePointerPath,
  preparePackageJson,
} from "../lib/package.mjs";
import { packPackage } from "../lib/pack.mjs";
import { assertCurrentPublicationTarget } from "../lib/publication-current.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "packages/eve");
const packageJsonPath = join(packageRoot, "package.json");
const artifactDirectory = join(appRoot, ".artifacts");
const target = await resolveDeploymentTarget(process.env);

if (target === undefined) {
  await writeLandingPage();
} else {
  await publishPackage(target);
}

async function publishPackage({ sourceSha, ref, origin }) {
  const credentials = vercelOidcCredentials(process.env);
  const originalPackageJson = await readFile(packageJsonPath, "utf8");
  const preparedPackageJson = preparePackageJson(JSON.parse(originalPackageJson), sourceSha, "git");
  const dependencyUrl = packageDependencyUrl(origin, sourceSha);

  try {
    await rm(artifactDirectory, { force: true, recursive: true });
    await writeFile(packageJsonPath, `${JSON.stringify(preparedPackageJson, null, 2)}\n`);
    const tarball = await packPackage(packageRoot, preparedPackageJson.version, {
      ...process.env,
      EVE_PACKAGE_DEPENDENCY_URL: dependencyUrl,
    });
    const sha256 = createHash("sha256").update(tarball).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const manifest = {
      sourceSha,
      version: preparedPackageJson.version,
      tarball: dependencyUrl,
      dependency: packageDependencySpecifier(dependencyUrl, integrity),
      integrity,
      sha256,
    };

    await assertTargetIsCurrent(ref, sourceSha);
    await putImmutableArtifact(packageArtifactPath(sourceSha), tarball, sha256, credentials);
    await putImmutableManifest(packageManifestPath(sourceSha), manifest, credentials);
    await updatePointer(packagePointerPath(ref), manifest, ref, sourceSha, credentials);

    await writeLandingPage();
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } finally {
    await writeFile(packageJsonPath, originalPackageJson);
    await rm(artifactDirectory, { force: true, recursive: true });
  }
}

async function assertTargetIsCurrent(ref, sourceSha) {
  await assertCurrentPublicationTarget({
    repository: "vercel/eve",
    ref,
    sourceSha,
    token: process.env.GITHUB_TOKEN,
  });
}

async function updatePointer(pathname, manifest, ref, sourceSha, credentials) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await get(pathname, {
      ...credentials,
      access: "private",
      useCache: false,
    });
    const etag = existing?.blob.etag;
    await existing?.stream.cancel();
    await assertTargetIsCurrent(ref, sourceSha);

    try {
      await put(pathname, JSON.stringify(manifest), {
        ...credentials,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: etag !== undefined,
        cacheControlMaxAge: 60,
        contentType: "application/json",
        ...(etag === undefined ? {} : { ifMatch: etag }),
      });
      return;
    } catch (error) {
      const retryable =
        error instanceof BlobPreconditionFailedError ||
        (error instanceof Error && error.message.includes("already exists"));
      if (!retryable || attempt === 2) throw error;
    }
  }
}

async function putImmutableArtifact(pathname, bytes, expectedHash, credentials) {
  try {
    await put(pathname, bytes, immutableOptions("application/gzip", credentials));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await get(pathname, {
      ...credentials,
      access: "private",
      useCache: false,
    });
    if (published === null) throw new Error("Published package artifact could not be read.");
    const publishedHash = createHash("sha256")
      .update(Buffer.from(await new Response(published.stream).arrayBuffer()))
      .digest("hex");
    if (publishedHash !== expectedHash) {
      throw new Error(
        `Commit ${process.env.VERCEL_GIT_COMMIT_SHA} was already published with different package contents.`,
      );
    }
  }
}

async function putImmutableManifest(pathname, value, credentials) {
  try {
    await put(pathname, JSON.stringify(value), immutableOptions("application/json", credentials));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await get(pathname, {
      ...credentials,
      access: "private",
      useCache: false,
    });
    if (published === null) throw new Error("Published package manifest could not be read.");
    if (JSON.parse(await new Response(published.stream).text()).sha256 !== value.sha256) {
      throw new Error(
        `Commit ${process.env.VERCEL_GIT_COMMIT_SHA} was already published with different package contents.`,
      );
    }
  }
}

function immutableOptions(contentType, credentials) {
  return {
    ...credentials,
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    contentType,
  };
}

async function writeLandingPage() {
  await mkdir(join(appRoot, "public"), { recursive: true });
  await writeFile(
    join(appRoot, "public", "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>eve packages</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; color: #111; font-family: Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(100% - 48px, 480px); text-align: center; }
      .mark { width: 32px; height: 32px; margin: 0 auto 24px; border-radius: 50%; background: #111; }
      h1 { margin: 0; font-size: 20px; font-weight: 500; letter-spacing: -0.03em; }
      p { margin: 8px 0 0; color: #666; font-size: 14px; }
      @media (prefers-color-scheme: dark) { body { background: #000; color: #ededed; } .mark { background: #ededed; } p { color: #888; } }
    </style>
  </head>
  <body><main><div class="mark" aria-hidden="true"></div><h1>eve packages</h1><p>Package artifacts for eve development.</p></main></body>
</html>
`,
  );
}
