import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createExternalResourcesSnapshot,
  type ExternalResource,
  type ExternalResourcesSnapshot,
} from "#internal/external-resources-snapshot.js";
import { isJsonObjectValue, parseJsonObject, type JsonObject } from "#shared/json.js";

export const CONNECT_MANIFEST_FILENAME = "vercel-connect-manifest.json";

const CONNECT_PACKAGE_NAME = "@vercel/connect";
const CONNECT_BINARY_NAME = "vercel-connect-manifest";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const CONVERTER_TIMEOUT_MS = 30_000;

export function buildExternalResourcesSnapshot(input: {
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly publicRoutePrefix?: string;
}): ExternalResourcesSnapshot {
  const resources: ExternalResource[] = [];
  const manifests = [input.manifest, ...input.manifest.subagents.map((subagent) => subagent.agent)];
  for (const manifest of manifests) {
    collectExternalResources(manifest, resources, input.publicRoutePrefix);
  }
  return createExternalResourcesSnapshot({ generatorVersion: input.generatorVersion, resources });
}

function collectExternalResources(
  manifest: Pick<CompiledAgentManifest, "channelRoutes" | "connections">,
  resources: ExternalResource[],
  publicRoutePrefix: string | undefined,
): void {
  for (const connection of manifest.connections) {
    const credentials = connection.vercelConnect?.requirement;
    if (credentials === undefined) continue;
    resources.push({
      connection: { type: connection.protocol, url: connection.url },
      credentials,
      kind: "connection",
      logicalPath: connection.logicalPath,
      name: connection.connectionName,
    });
  }
  for (const channel of manifest.channelRoutes.effective) {
    const credentials = channel.vercelConnect?.requirement;
    if (
      credentials === undefined ||
      channel.adapterKind !== "slack" ||
      channel.manifest === undefined
    ) {
      continue;
    }
    resources.push({
      credentials,
      kind: "channel",
      logicalPath: channel.logicalPath,
      manifest: channel.manifest,
      name: channel.name,
      route: { path: `${publicRoutePrefix ?? ""}${channel.urlPath}` },
    });
  }
}

export async function emitConnectManifest(input: {
  readonly appRoot: string;
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly outputDirectory: string;
  readonly publicRoutePrefix?: string;
}): Promise<void> {
  const snapshot = buildExternalResourcesSnapshot(input);
  const manifest = await createConnectManifest({ appRoot: input.appRoot, snapshot });
  if (manifest === undefined) return;
  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(
    join(input.outputDirectory, CONNECT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function createConnectManifest(input: {
  readonly appRoot: string;
  readonly snapshot: ExternalResourcesSnapshot;
}): Promise<JsonObject | undefined> {
  if (input.snapshot.resources.length === 0) return undefined;
  const executable = await resolveConnectManifestCompiler(input.appRoot);
  let result: Awaited<ReturnType<typeof runManifestCompiler>>;
  try {
    result = await runManifestCompiler(executable, JSON.stringify(input.snapshot));
  } catch {
    throw new Error(
      "Failed to start the @vercel/connect manifest compiler. Update @vercel/connect and rerun `eve build`.",
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create the Connect manifest: ${result.stderr || `converter exited with code ${result.exitCode}`}. Update @vercel/connect and rerun \`eve build\`.`,
    );
  }
  try {
    return parseJsonObject(JSON.parse(result.stdout) as unknown);
  } catch {
    throw new Error(
      "The @vercel/connect manifest compiler returned invalid JSON. Update @vercel/connect and rerun `eve build`.",
    );
  }
}

async function resolveConnectManifestCompiler(appRoot: string): Promise<string> {
  const require = createRequire(join(appRoot, "package.json"));
  let entryPath: string;
  try {
    entryPath = require.resolve("@vercel/connect/eve");
  } catch {
    throw new Error(
      "Connect-backed resources require @vercel/connect with manifest compiler support. Install or update @vercel/connect, then rerun `eve build`.",
    );
  }
  let current = dirname(entryPath);
  while (true) {
    try {
      const packageJson = parseJsonObject(
        JSON.parse(await readFile(join(current, "package.json"), "utf8")) as unknown,
      );
      if (packageJson.name === CONNECT_PACKAGE_NAME) {
        const bin = isJsonObjectValue(packageJson.bin)
          ? packageJson.bin[CONNECT_BINARY_NAME]
          : undefined;
        if (typeof bin !== "string" || bin.length === 0) break;
        return resolve(current, bin);
      }
    } catch {
      // Continue toward the filesystem root until the package root is found.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    "The installed @vercel/connect package does not include the manifest compiler. Update @vercel/connect and rerun `eve build`.",
  );
}

function runManifestCompiler(
  executable: string,
  snapshot: string,
): Promise<{ readonly exitCode: number | null; readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [executable, "from-eve-resources"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: {
      readonly exitCode: number | null;
      readonly stderr: string;
      readonly stdout: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const terminate = (message: string): void => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGKILL");
      finish({ exitCode: null, stderr: message, stdout: "" });
    };
    const timer = setTimeout(
      () => terminate("converter timed out after 30 seconds"),
      CONVERTER_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let outputBytes = 0;
    const collect = (current: string, chunk: string): string => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate("converter output exceeded 10 MB");
        return current;
      }
      return current + chunk;
    };
    child.stdout.on("data", (chunk: string) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = collect(stderr, chunk);
    });
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on("error", rejectOnce);
    child.stdin.on("error", rejectOnce);
    child.on("close", (exitCode) => {
      finish({ exitCode, stderr: stderr.trim(), stdout });
    });
    child.stdin.end(snapshot);
  });
}
