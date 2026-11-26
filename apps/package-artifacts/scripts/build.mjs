import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

import { resolveDeploymentTarget, vercelOidcCredentials } from "../lib/deployment-target.mjs";
import {
  packageArtifactPath,
  packageDependencyUrl,
  packageManifest,
  packageManifestPath,
  packagePointerPath,
  packageVersion,
  preparePackageJson,
  publishablePackages,
} from "../lib/package.mjs";
import { packPackage } from "../lib/pack.mjs";
import { assertCurrentPublicationTarget } from "../lib/publication-current.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packagesRoot = join(repoRoot, "packages");
const evePackageJsonPath = join(packagesRoot, "eve", "package.json");
const target = await resolveDeploymentTarget(process.env);

if (target === undefined) {
  await writeLandingPage();
} else {
  await publishPackages(target);
}

async function publishPackages({ sourceSha, ref, origin }) {
  const credentials = vercelOidcCredentials(process.env);
  const packages = await readPublishablePackages();
  const originalEvePackageJson = await readFile(evePackageJsonPath, "utf8");
  const preparedEvePackageJson = preparePackageJson(
    JSON.parse(originalEvePackageJson),
    sourceSha,
    "git",
  );
  const env = {
    ...process.env,
    EVE_PACKAGE_DEPENDENCY_URL: packageDependencyUrl(origin, sourceSha, "eve"),
  };

  try {
    await writeFile(evePackageJsonPath, `${JSON.stringify(preparedEvePackageJson, null, 2)}\n`);
    await run(
      "pnpm",
      ["exec", "turbo", "run", "build", ...packages.map(({ name }) => `--filter=${name}`)],
      env,
    );

    const artifacts = [];
    for (const { name, slug, version: releaseVersion, root } of packages) {
      const version = packageVersion(releaseVersion, sourceSha, "git");
      const tarball = await packPackage(root, version, env);
      artifacts.push({
        name,
        slug,
        version,
        tarball: packageDependencyUrl(origin, sourceSha, slug),
        bytes: tarball,
        sha256: createHash("sha256").update(tarball).digest("hex"),
      });
    }
    const manifest = packageManifest(sourceSha, artifacts);

    await assertTargetIsCurrent(ref, sourceSha);
    for (const { slug, bytes, sha256 } of artifacts) {
      await putImmutableArtifact(packageArtifactPath(sourceSha, slug), bytes, sha256, credentials);
    }
    await putImmutableManifest(packageManifestPath(sourceSha), manifest, credentials);
    await updatePointer(packagePointerPath(ref), manifest, ref, sourceSha, credentials);

    await writeLandingPage();
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } finally {
    await writeFile(evePackageJsonPath, originalEvePackageJson);
  }
}

async function readPublishablePackages() {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packageJsons = [];
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    const root = join(packagesRoot, entry.name);
    try {
      packageJsons.push({
        ...JSON.parse(await readFile(join(root, "package.json"), "utf8")),
        root,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return publishablePackages(packageJsons);
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
    });
  });
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
    if ((await new Response(published.stream).text()) !== JSON.stringify(value)) {
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
