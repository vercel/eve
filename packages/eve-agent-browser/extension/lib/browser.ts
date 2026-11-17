import { AGENT_BROWSER_SANDBOX_VERSION, quoteShellArg } from "./shared.js";
import { installAgentBrowser, type EveSandboxSession } from "./sandbox";

import extension from "../extension";

/** Structural subset of eve's tool context — every eve `ctx` satisfies it. */
export interface BrowserToolContext {
  readonly abortSignal?: AbortSignal;
  getSandbox(): PromiseLike<EveSandboxSession | null | undefined>;
}

export const SELECTOR_HINT =
  'Element selector: a ref from the snapshot tool like "@e12" (most reliable), a CSS selector like "#login .submit", "text=Sign in", or "xpath=//button[1]".';

const SANDBOX_DEADLINE_MS = 180_000;

async function withDeadline<T>(work: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} did not respond within ${SANDBOX_DEADLINE_MS / 1000}s. The browser sandbox may be starting up or unavailable — try again shortly.`,
            ),
          );
        }, SANDBOX_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ContentBoundary {
  readonly nonce: string;
  readonly origin: string;
}

interface McpCallResult {
  readonly _meta?: { readonly agentBrowserVersion?: string };
  readonly content?: readonly { readonly text?: string; readonly type: string }[];
  readonly error?: { readonly message: string };
  readonly isError?: boolean;
  readonly structuredContent?: {
    readonly response?: {
      readonly data?: unknown;
      readonly _boundary?: ContentBoundary;
    } | null;
  };
}

export async function runMcpTool(
  ctx: BrowserToolContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const sandbox = await requireSandbox(ctx);
  await ensureInstalled(sandbox, ctx.abortSignal);

  const config = extension.config;
  const command = [
    ...configEnv(),
    quoteShellArg(config.binary),
    "mcp",
    "call",
    quoteShellArg(tool),
    quoteShellArg(JSON.stringify(args)),
  ].join(" ");
  const raw = await withDeadline(
    sandbox.run({ signal: ctx.abortSignal, command }),
    "The browser command",
  );

  let result: McpCallResult;
  try {
    result = JSON.parse((raw.stdout ?? "").trim().split("\n").at(-1) ?? "") as McpCallResult;
  } catch {
    throw new Error(
      `agent-browser in the sandbox does not support \`mcp call\`. Install agent-browser@${AGENT_BROWSER_SANDBOX_VERSION} or set installSpec to it.\n${
        (raw.stderr ?? "").trim() || (raw.stdout ?? "").trim()
      }`,
    );
  }
  assertMatchingVersion(result._meta?.agentBrowserVersion);
  if (result.error !== undefined) {
    throw new Error(`agent-browser ${tool} failed: ${result.error.message}`);
  }
  if (result.isError === true) {
    const text = result.content?.find((part) => part.type === "text")?.text ?? "unknown error";
    throw new Error(`agent-browser ${tool} failed: ${text}`);
  }
  const response = result.structuredContent?.response;
  const data = response?.data ?? null;
  if (!config.contentBoundaries) return data;

  const boundary = response?._boundary;
  if (
    typeof boundary?.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(boundary.nonce) ||
    typeof boundary.origin !== "string"
  ) {
    throw new Error(
      "agent-browser did not return valid content boundary metadata. Check the sandbox CLI version before retrying.",
    );
  }
  const output =
    data !== null && typeof data === "object" && !Array.isArray(data) ? data : { data };
  return { ...output, _boundary: boundary };
}

function assertMatchingVersion(installed: string | undefined): void {
  if (installed !== undefined && !matchesPackageMinor(installed)) {
    throw versionMismatchError(installed);
  }
}

function versionMismatchError(installed: string): Error {
  return new Error(
    `agent-browser ${installed} in the sandbox does not match @eve/agent-browser ${AGENT_BROWSER_SANDBOX_VERSION}. Install agent-browser@${AGENT_BROWSER_SANDBOX_VERSION} or set installSpec to it.`,
  );
}

function matchesPackageMinor(version: string): boolean {
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  return minor(version) === minor(AGENT_BROWSER_SANDBOX_VERSION);
}

function configEnv(): string[] {
  const config = extension.config;
  const env: string[] = [];
  if (config.proxy !== undefined) env.push(`AGENT_BROWSER_PROXY=${quoteShellArg(config.proxy)}`);
  if (config.contentBoundaries) env.push("AGENT_BROWSER_CONTENT_BOUNDARIES=1");
  if (config.maxOutputChars !== undefined) {
    env.push(`AGENT_BROWSER_MAX_OUTPUT=${config.maxOutputChars}`);
  }
  return env;
}

async function requireSandbox(ctx: BrowserToolContext): Promise<EveSandboxSession> {
  const sandbox = await withDeadline(ctx.getSandbox(), "The sandbox session");
  if (sandbox === null || sandbox === undefined) {
    throw new Error(
      "The browser tools require an eve sandbox. Configure agent/sandbox.ts in the consuming agent.",
    );
  }
  return sandbox;
}

async function ensureInstalled(
  sandbox: EveSandboxSession,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (extension.config.autoInstall) {
    await installIfMissingOrStale(sandbox, abortSignal);
  }
}

async function installIfMissingOrStale(
  sandbox: EveSandboxSession,
  abortSignal?: AbortSignal,
): Promise<void> {
  const config = extension.config;
  const installed = await probeVersion(sandbox, abortSignal);
  if (installed !== undefined && matchesPackageMinor(installed)) {
    return;
  }
  const userOwned = config.installSpec !== undefined || config.binary !== "agent-browser";
  if (installed !== undefined && userOwned) {
    throw versionMismatchError(installed);
  }
  await withDeadline(
    installAgentBrowser(sandbox, {
      abortSignal,
      installBrowser: config.installBrowser,
      installSpec: config.installSpec,
      installSystemDependencies: config.installSystemDependencies,
    }),
    "Installing agent-browser",
  );
  const reinstalled = await probeVersion(sandbox, abortSignal);
  if (reinstalled === undefined || !matchesPackageMinor(reinstalled)) {
    throw versionMismatchError(reinstalled ?? "missing");
  }
}

async function probeVersion(
  sandbox: EveSandboxSession,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  const probe = await withDeadline(
    sandbox.run({
      signal: abortSignal,
      command: `${quoteShellArg(extension.config.binary)} --version 2>/dev/null`,
    }),
    "The browser install probe",
  );
  if ((probe.exitCode ?? 0) !== 0) {
    return undefined;
  }
  return (probe.stdout ?? "").trim().split(/\s+/).at(-1) ?? "";
}
