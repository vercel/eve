import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function resolveBundledEveBin(): string {
  const packageJson = fileURLToPath(import.meta.resolve("eve/package.json"));
  return join(dirname(packageJson), "bin", "eve.js");
}

export interface EveTargetInfo {
  modelId: string;
  name: string;
}

export class VercelDeploymentProtectionError extends Error {
  constructor() {
    super("Vercel Deployment Protection requires authentication");
    this.name = "VercelDeploymentProtectionError";
  }
}

export async function readEveTargetInfo(options: {
  eveBin: string;
  target?: string;
  cwd: string;
  fetch?: typeof globalThis.fetch;
  headers?: Readonly<Record<string, string>>;
}): Promise<EveTargetInfo> {
  let raw: unknown;
  if (options.target) {
    const requestUrl = `${options.target.replace(/\/+$/, "")}/eve/v1/info`;
    let response: Response;
    try {
      const headers = { ...options.headers };
      const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
      if (bypassSecret) headers["x-vercel-protection-bypass"] = bypassSecret;
      response = await (options.fetch ?? globalThis.fetch)(requestUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      throw new Error(`Could not reach the eve deployment at ${options.target}${cause}`, {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      if (location.includes("vercel.com/sso-api")) {
        throw new VercelDeploymentProtectionError();
      }
      throw new Error(`eve info request redirected to ${location || "another location"}`);
    }
    if (!response.ok) throw new Error(`eve info request failed with HTTP ${response.status}`);
    raw = await response.json();
  } else {
    const { stdout } = await execFileAsync(process.execPath, [options.eveBin, "info", "--json"], {
      cwd: options.cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const jsonStart = stdout.indexOf("{");
    if (jsonStart < 0) throw new Error("eve info did not return JSON");
    raw = JSON.parse(stdout.slice(jsonStart));
  }

  return parseEveTargetInfo(raw);
}

export function parseEveTargetInfo(raw: unknown): EveTargetInfo {
  const info = raw as {
    agent?: { model?: { id?: unknown }; name?: unknown };
    appRoot?: unknown;
    model?: unknown;
  };
  if (typeof info.agent?.model?.id === "string" && typeof info.agent.name === "string") {
    return { modelId: info.agent.model.id, name: info.agent.name };
  }
  if (typeof info.model === "string" && typeof info.appRoot === "string") {
    return { modelId: info.model, name: basename(info.appRoot) };
  }
  throw new Error("eve info did not report an agent name and authored model");
}
