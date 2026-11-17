export interface BootstrapOptions {
  cliEntrypointPath?: string;

  packageRoot?: string;

  postBuildScriptPaths?: readonly string[];

  tscCliPath?: string;
}

export interface BootstrapCommandOptions {
  cwd: string;
}

export interface BootstrapBuildDependencies {
  exists?: (path: string) => Promise<boolean>;
  getLatestBuildInputMtimeMs?: (input: { packageRoot: string }) => Promise<number>;
  getPathMtimeMs?: (path: string) => Promise<number | undefined>;
  runCommand?: (
    command: string,
    args: readonly string[],
    options: BootstrapCommandOptions,
  ) => Promise<void>;
}

export interface BootstrapCliModule {
  runCli(argv?: string[]): Promise<void>;
}

export interface BootstrapSemverModule {
  default: {
    validRange(range: string | undefined): string | null;
    satisfies(version: string, range: string): boolean;
  };
}

export interface BootstrapDependencies extends BootstrapBuildDependencies {
  importBootstrapModule?: (specifier: string) => Promise<BootstrapSemverModule>;

  importModule?: (specifier: string) => Promise<BootstrapCliModule>;

  nodeVersion?: string;

  nodeEngineRequirement?: string;
}

export function ensureBuiltCli(
  overrides?: BootstrapOptions,
  dependencies?: BootstrapBuildDependencies,
): Promise<string>;

export function runEveCli(
  argv?: string[],
  overrides?: BootstrapOptions,
  dependencies?: BootstrapDependencies,
): Promise<void>;
