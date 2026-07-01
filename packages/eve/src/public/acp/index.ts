import type { LanguageModel } from "ai";
import { createACPProvider } from "@mcpc-tech/acp-ai-provider";

export type AcpPreset = "claude" | "codex" | "gemini" | "opencode";

export interface AcpMcpServerConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: readonly AcpMcpServerEnvVariable[];
  readonly name: string;
  readonly type?: "stdio";
}

export interface AcpMcpServerEnvVariable {
  readonly name: string;
  readonly value: string;
}

export type AcpMcpServers =
  | readonly AcpMcpServerConfig[]
  | Readonly<Record<string, Omit<AcpMcpServerConfig, "name">>>;

export interface AcpModelOptions {
  readonly args?: readonly string[];
  readonly authMethodId?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly mcpServers?: AcpMcpServers;
  readonly mode?: string;
  readonly model?: string;
  readonly persistSession?: boolean;
  readonly sessionDelayMs?: number;
}

export interface ResolvedAcpProviderConfig {
  readonly args: readonly string[];
  readonly authMethodId?: string;
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly mode?: string;
  readonly model?: string;
  readonly persistSession: boolean;
  readonly session: {
    readonly cwd: string;
    readonly mcpServers: readonly AcpMcpServerConfig[];
  };
  readonly sessionDelayMs?: number;
}

const ACP_PRESETS = {
  claude: {
    args: [],
    command: "claude-code-acp",
  },
  codex: {
    args: [],
    command: "codex-acp",
  },
  gemini: {
    args: ["--experimental-acp"],
    command: "gemini",
  },
  opencode: {
    args: ["acp"],
    command: "opencode",
  },
} as const satisfies Readonly<
  Record<AcpPreset, { readonly args: readonly string[]; readonly command: string }>
>;

export function acp(preset?: AcpPreset): LanguageModel;
export function acp(preset: AcpPreset, model: string): LanguageModel;
export function acp(preset: AcpPreset, options: AcpModelOptions): LanguageModel;
export function acp(options: AcpModelOptions): LanguageModel;
export function acp(
  presetOrOptions: AcpPreset | AcpModelOptions = "opencode",
  modelOrOptions?: string | AcpModelOptions,
): LanguageModel {
  const config = resolveAcpProviderConfig(presetOrOptions, modelOrOptions);
  const provider = createACPProvider({
    args: [...config.args],
    authMethodId: config.authMethodId,
    command: config.command,
    env: config.env === undefined ? undefined : { ...config.env },
    persistSession: config.persistSession,
    session: {
      cwd: config.session.cwd,
      mcpServers: config.session.mcpServers.map((server) => ({
        ...server,
        args: [...server.args],
        env: server.env === undefined ? [] : server.env.map((entry) => ({ ...entry })),
      })),
    },
    sessionDelayMs: config.sessionDelayMs,
  });

  return provider.languageModel(config.model, config.mode) as LanguageModel;
}

export function resolveAcpProviderConfig(
  presetOrOptions: AcpPreset | AcpModelOptions = "opencode",
  modelOrOptions?: string | AcpModelOptions,
): ResolvedAcpProviderConfig {
  const preset = typeof presetOrOptions === "string" ? ACP_PRESETS[presetOrOptions] : undefined;
  const inputOptions = typeof presetOrOptions === "string" ? undefined : presetOrOptions;
  const overrideOptions =
    typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
  const options = { ...inputOptions, ...overrideOptions };
  const command = options.command ?? preset?.command;

  if (command === undefined) {
    throw new Error("acp() requires a preset or command.");
  }

  return {
    args: options.args ?? preset?.args ?? [],
    authMethodId: options.authMethodId,
    command,
    env: options.env,
    mode: options.mode,
    model: options.model,
    persistSession: options.persistSession ?? false,
    session: {
      cwd: options.cwd ?? process.cwd(),
      mcpServers: normalizeMcpServers(options.mcpServers),
    },
    sessionDelayMs: options.sessionDelayMs,
  };
}

function normalizeMcpServers(mcpServers: AcpMcpServers | undefined): readonly AcpMcpServerConfig[] {
  if (mcpServers === undefined) {
    return [];
  }

  if (Array.isArray(mcpServers)) {
    return mcpServers.map((server) => ({
      ...server,
      args: [...server.args],
      env:
        server.env === undefined
          ? []
          : server.env.map((entry: AcpMcpServerEnvVariable) => ({ ...entry })),
    }));
  }

  return Object.entries(mcpServers).map(([name, server]) => ({
    name,
    ...server,
    args: [...server.args],
    env:
      server.env === undefined
        ? []
        : server.env.map((entry: AcpMcpServerEnvVariable) => ({ ...entry })),
  }));
}
