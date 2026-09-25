import type { HarnessRunContext } from "../../core/harness.ts";

export type CliName = "hermes" | "pi" | "opencode" | "codex";
export type SupportedCliName = Exclude<CliName, "hermes">;
export interface CliOptions {
  readonly version: string;
  readonly baseUrl?: string;
  readonly reasoning?: string;
}

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function validateOptions(name: CliName, options: CliOptions): SupportedCliName {
  if (name === "hermes") {
    throw new Error(
      "Hermes is not supported by this adapter: Harbor installs a mutable main/scripts/install.sh and only establishes OPENAI_BASE_URL routing for openai/*, not Gateway DeepSeek. A pinned, audited Python/uv bundle and verified custom-provider routing are required; no fallback agent is run.",
    );
  }
  if (!["pi", "opencode", "codex"].includes(name)) throw new Error("Unsupported CLI harness");
  if (!EXACT_VERSION.test(options.version ?? "")) {
    throw new Error(
      "CLI harness requires an explicit exact version (for example 1.2.3); tags, ranges, and latest are not allowed.",
    );
  }
  let url: URL;
  try {
    url = new URL(options.baseUrl ?? GATEWAY_BASE_URL);
  } catch {
    throw new Error(
      "CLI baseUrl must be an HTTPS API base URL without credentials, query, or fragment.",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "CLI baseUrl must be an HTTPS API base URL without credentials, query, or fragment.",
    );
  }
  if (options.reasoning !== undefined) {
    const allowed =
      name === "pi"
        ? ["off", "minimal", "low", "medium", "high", "xhigh"]
        : name === "codex"
          ? ["none", "minimal", "low", "medium", "high", "xhigh"]
          : undefined;
    if (
      allowed
        ? !allowed.includes(options.reasoning)
        : !/^[a-zA-Z0-9_-]{1,64}$/.test(options.reasoning)
    ) {
      throw new Error(`Unsupported ${name} reasoning value`);
    }
  }
  return name;
}

export function validateModel(model: string): void {
  if (
    model.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9/._:-]*$/.test(model)
  ) {
    throw new Error(
      "CLI model must be a full provider-qualified model ID, without whitespace or control characters.",
    );
  }
}

export function packageName(name: SupportedCliName, version: string): string {
  if (name === "codex") return "@openai/codex";
  if (name === "opencode") return "opencode-ai";
  const [major, minor] = version.split(".").map(Number);
  // Harbor pi.py changes package namespace at 0.74.0 (prereleases precede it).
  return major === 0 && (minor! < 74 || (minor === 74 && version.startsWith("0.74.0-")))
    ? "@mariozechner/pi-coding-agent"
    : "@earendil-works/pi-coding-agent";
}

export interface ExecutionPlan {
  readonly args: string[];
  readonly stdin?: string;
  readonly env: Record<string, string>;
  readonly configPath: string;
  readonly config: string;
  readonly protocol: "chat-completions" | "responses";
}

/** Native commands/config follow Harbor installed/{pi,opencode,codex}.py at
 * 2fe1615503fed39ad82b7ce09b22497996b30f1f. Gateway model IDs deliberately stay intact.
 */
export function executionPlan(
  name: SupportedCliName,
  options: CliOptions,
  ctx: HarnessRunContext,
  runtimeDir: string,
  instruction: string,
): ExecutionPlan {
  validateOptions(name, options);
  validateModel(ctx.model);
  const baseUrl = options.baseUrl ?? GATEWAY_BASE_URL;
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  if (name === "pi") {
    const model: { id: string; reasoning?: boolean } = { id: ctx.model };
    if (options.reasoning) model.reasoning = options.reasoning !== "off";
    return {
      protocol: "chat-completions",
      args: [
        "--print",
        "--mode",
        "json",
        "--session-dir",
        `${runtimeDir}/pi/sessions`,
        "--provider",
        "eve-bench-gateway",
        "--model",
        ctx.model,
        ...(options.reasoning ? ["--thinking", options.reasoning] : []),
      ],
      // pi 0.80.3's parseArgs treats -- as an unknown flag. main.readPipedStdin
      // passes stdin to prepareInitialMessage without flag or @file interpretation.
      stdin: instruction,
      env: { PI_CODING_AGENT_DIR: `${runtimeDir}/pi` },
      configPath: `${runtimeDir}/pi/models.json`,
      config: json({
        providers: {
          "eve-bench-gateway": {
            baseUrl,
            apiKey: "$AI_GATEWAY_API_KEY",
            api: "openai-completions",
            models: [model],
          },
        },
      }),
    };
  }
  if (name === "opencode") {
    return {
      protocol: "chat-completions",
      // Only the first component selects the CLI provider; the API ID stays intact.
      args: [
        `--model=eve-bench-gateway/${ctx.model}`,
        "run",
        "--format=json",
        ...(options.reasoning ? ["--variant", options.reasoning] : []),
        "--thinking",
        "--dangerously-skip-permissions",
        "--",
        instruction,
      ],
      env: {
        OPENCODE_FAKE_VCS: "git",
        OPENCODE_CONFIG: `${runtimeDir}/opencode/opencode.json`,
      },
      configPath: `${runtimeDir}/opencode/opencode.json`,
      // Harbor's mimo.py (OpenCode derivative) documents the compatible SDK override.
      // OpenCode provider.ts resolves single-entry provider.env into the SDK API key.
      config: json({
        provider: {
          "eve-bench-gateway": {
            npm: "@ai-sdk/openai-compatible",
            env: ["OPENAI_API_KEY"],
            options: { baseURL: baseUrl },
            models: {
              [ctx.model]: options.reasoning
                ? {
                    reasoning: true,
                    variants: { [options.reasoning]: { reasoningEffort: options.reasoning } },
                  }
                : {},
            },
          },
        },
      }),
    };
  }
  return {
    protocol: "responses",
    args: [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--model",
      ctx.model,
      "--json",
      "--enable",
      "unified_exec",
      ...(options.reasoning ? ["-c", `model_reasoning_effort=${options.reasoning}`] : []),
      "--",
      instruction,
    ],
    env: { CODEX_HOME: `${runtimeDir}/codex`, OPENAI_BASE_URL: baseUrl },
    configPath: `${runtimeDir}/codex/config.toml`,
    // Unlike Harbor's auth.json, Codex's native env_key needs no persisted credential.
    // Source: openai/codex, codex-rs/model-provider-info/src/lib.rs, ModelProviderInfo.
    config:
      `model_provider = "eve-bench-gateway"\nopenai_base_url = ${JSON.stringify(baseUrl)}\n` +
      `[model_providers.eve-bench-gateway]\nname = "eve-bench-gateway"\n` +
      `base_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\n` +
      `env_key = "AI_GATEWAY_API_KEY"\nrequires_openai_auth = false\n`,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
