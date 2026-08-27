import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";
import { ensureScenarioEveTarballPath } from "#internal/testing/scenario-app.js";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";
import { createDevelopmentRequestHeadersAsync } from "../dev-client-harness/request-headers.js";
import { resolveDevelopmentServerRouteUrl } from "../dev-client-harness/url.js";

const VERCEL_CLI_PACKAGE = "vercel@latest";
const DEFAULT_DEPLOYMENT_READY_ATTEMPTS = 30;
const DEFAULT_DEPLOYMENT_READY_WAIT_MS = 2_000;

/**
 * One deployed test app prepared from a fixture copy and an eve tarball.
 */
export interface TarballVercelDeploymentFixture {
  readonly appRoot: string;
  readonly deploymentUrl: string;
  cleanup(): Promise<void>;
}

/**
 * Input for creating one deployed fixture application on Vercel.
 */
export interface CreateTarballVercelDeploymentFixtureInput {
  readonly descriptor: ScenarioAppDescriptor;
  readonly orgId: string;
  readonly prefix: string;
  readonly projectId: string;
  readonly runtimeEnv?: Readonly<Record<string, string>>;
  readonly scope?: string;
  readonly token: string;
  /** Wait for the deployed eve health route after the Vercel build succeeds. */
  readonly waitForHealth?: boolean;
}

/**
 * Materializes the descriptor into a fresh temporary directory, wires the
 * app to depend on the locally packed eve tarball, deploys it to Vercel,
 * and returns the deployment URL.
 */
export async function createTarballVercelDeploymentFixture(
  input: CreateTarballVercelDeploymentFixtureInput,
): Promise<TarballVercelDeploymentFixture> {
  const appRoot = await mkdtemp(join(tmpdir(), input.prefix));

  try {
    const tarballSourcePath = await ensureScenarioEveTarballPath();
    const tarballFileName = basename(tarballSourcePath);

    await cp(tarballSourcePath, join(appRoot, tarballFileName));
    await writeDescriptorAppFiles({
      appRoot,
      descriptor: input.descriptor,
    });
    await writeDescriptorPackageManifest({
      appRoot,
      descriptor: input.descriptor,
      tarballFileName,
    });
    await writeVercelProjectLink({
      appRoot,
      orgId: input.orgId,
      projectId: input.projectId,
    });

    const deploymentUrl = await deployFixtureToVercel({
      appRoot,
      runtimeEnv: input.runtimeEnv,
      scope: input.scope,
      token: input.token,
    });

    if (input.waitForHealth !== false) {
      await waitForDeploymentReady({
        deploymentUrl,
      });
    }

    return {
      appRoot,
      async cleanup(): Promise<void> {
        await rm(appRoot, {
          force: true,
          recursive: true,
        });
      },
      deploymentUrl,
    };
  } catch (error) {
    await rm(appRoot, {
      force: true,
      recursive: true,
    });

    throw error;
  }
}

async function writeDescriptorAppFiles(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
  for (const directory of input.descriptor.directories ?? []) {
    await mkdir(join(input.appRoot, directory), {
      recursive: true,
    });
  }

  for (const [relativePath, contents] of Object.entries(input.descriptor.files)) {
    const destinationPath = join(input.appRoot, relativePath);
    await mkdir(dirname(destinationPath), {
      recursive: true,
    });
    await writeFile(destinationPath, contents, "utf8");
  }
}

async function writeDescriptorPackageManifest(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
  readonly tarballFileName: string;
}): Promise<void> {
  const packageJson: Record<string, unknown> = {
    dependencies: {
      [EVE_PACKAGE_NAME]: `file:./${input.tarballFileName}`,
      ...input.descriptor.dependencies,
    },
    name: input.descriptor.name,
    private: true,
    type: input.descriptor.packageType ?? "module",
  };

  await writeFile(
    join(input.appRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
}

async function writeVercelProjectLink(input: {
  readonly appRoot: string;
  readonly orgId: string;
  readonly projectId: string;
}): Promise<void> {
  const vercelDirectoryPath = join(input.appRoot, ".vercel");

  await mkdir(vercelDirectoryPath, {
    recursive: true,
  });
  await writeFile(
    join(vercelDirectoryPath, "project.json"),
    `${JSON.stringify(
      {
        orgId: input.orgId,
        projectId: input.projectId,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function deployFixtureToVercel(input: {
  readonly appRoot: string;
  readonly runtimeEnv?: Readonly<Record<string, string>>;
  readonly scope?: string;
  readonly token: string;
}): Promise<string> {
  const args = ["dlx", VERCEL_CLI_PACKAGE, "deploy", "--json", "--yes"];

  if (input.scope !== undefined && input.scope.trim().length > 0) {
    args.push("--scope", input.scope.trim());
  }

  for (const [name, value] of Object.entries(input.runtimeEnv ?? {})) {
    if (name.trim().length === 0 || value.trim().length === 0) {
      continue;
    }

    args.push("--build-env", `${name}=${value}`);
    args.push("--env", `${name}=${value}`);
  }

  const result = await runPnpmCommand({
    args,
    cwd: input.appRoot,
    env: {
      ...process.env,
      VERCEL_TOKEN: input.token,
    },
  });
  const deploymentUrl =
    extractDeploymentUrlFromJsonOutput(result.stdout) ??
    extractDeploymentUrlFromText([result.stdout, result.stderr].join("\n"));

  if (deploymentUrl === undefined) {
    throw new Error(
      [
        "Failed to resolve Vercel deployment URL from CLI output.",
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join("\n\n"),
    );
  }

  return deploymentUrl;
}

function extractDeploymentUrlFromJsonOutput(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const deploymentUrl = readDeploymentUrl(parsed);

    if (deploymentUrl !== undefined) {
      return deploymentUrl;
    }
  } catch {}

  for (const line of stdout.split(/\r?\n/u).reverse()) {
    const trimmedLine = line.trim();

    if (!trimmedLine.startsWith("{")) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmedLine);
      const deploymentUrl = readDeploymentUrl(parsed);

      if (deploymentUrl !== undefined) {
        return deploymentUrl;
      }
    } catch {}
  }

  return undefined;
}

function readDeploymentUrl(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.url === "string" && value.url.trim().length > 0) {
    return normalizeDeploymentUrl(value.url);
  }

  if (
    isRecord(value.deployment) &&
    typeof value.deployment.url === "string" &&
    value.deployment.url.trim().length > 0
  ) {
    return normalizeDeploymentUrl(value.deployment.url);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractDeploymentUrlFromText(output: string): string | undefined {
  const urlMatches = output.match(/https:\/\/[a-zA-Z0-9.-]+\.vercel\.app/gu);

  if (urlMatches !== null && urlMatches.length > 0) {
    const latestUrl = urlMatches.at(-1);

    if (latestUrl !== undefined) {
      return normalizeDeploymentUrl(latestUrl);
    }
  }

  const bareMatches = output.match(/[a-zA-Z0-9.-]+\.vercel\.app/gu);

  if (bareMatches !== null && bareMatches.length > 0) {
    const latestUrl = bareMatches.at(-1);

    if (latestUrl !== undefined) {
      return normalizeDeploymentUrl(latestUrl);
    }
  }

  return undefined;
}

function normalizeDeploymentUrl(value: string): string {
  const trimmedValue = value.trim();

  if (trimmedValue.startsWith("https://") || trimmedValue.startsWith("http://")) {
    return trimmedValue;
  }

  return `https://${trimmedValue}`;
}

async function waitForDeploymentReady(input: { readonly deploymentUrl: string }): Promise<void> {
  const healthUrl = resolveDevelopmentServerRouteUrl({
    routePath: EVE_HEALTH_ROUTE_PATH,
    serverUrl: input.deploymentUrl,
  });
  let lastError: unknown;

  for (let attempt = 1; attempt <= DEFAULT_DEPLOYMENT_READY_ATTEMPTS; attempt += 1) {
    try {
      const headers = await createDevelopmentRequestHeadersAsync({
        resourceUrl: healthUrl,
      });
      const response = await fetch(healthUrl, {
        headers,
      });

      if (response.ok) {
        return;
      }

      lastError = new Error(
        `Health route returned ${response.status} ${response.statusText} while waiting for deployment readiness.`,
      );
    } catch (error) {
      lastError = error;
    }

    await sleep(DEFAULT_DEPLOYMENT_READY_WAIT_MS);
  }

  const detail =
    lastError instanceof Error
      ? `${lastError.name}: ${lastError.message}`
      : `Unknown error: ${String(lastError)}`;

  throw new Error(
    [
      `Deployment did not become ready after ${DEFAULT_DEPLOYMENT_READY_ATTEMPTS} attempts.`,
      `Health URL: ${healthUrl.toString()}`,
      `Last error: ${detail}`,
    ].join("\n"),
  );
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
