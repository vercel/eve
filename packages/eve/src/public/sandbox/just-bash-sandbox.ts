/**
 * The filesystem a just-bash interpreter runs on. just-bash's own filesystems,
 * such as `ReadWriteFs`, `OverlayFs`, and `MountableFs`, satisfy it.
 */
export interface JustBashFilesystem {
  readFile(
    path: string,
    options?: { encoding?: JustBashEncoding | null } | JustBashEncoding,
  ): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: JustBashEncoding } | JustBashEncoding,
  ): Promise<void>;
  appendFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: JustBashEncoding } | JustBashEncoding,
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<JustBashFileStat>;
  lstat(path: string): Promise<JustBashFileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<JustBashDirectoryEntry[]>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void>;
  mv(source: string, destination: string): Promise<void>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  utimes(path: string, accessTime: Date, modificationTime: Date): Promise<void>;
}

type JustBashEncoding = "ascii" | "base64" | "binary" | "hex" | "latin1" | "utf-8" | "utf8";

export interface JustBashFileStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  mtime: Date;
  size: number;
}

export interface JustBashDirectoryEntry {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  name: string;
}

/**
 * A command registered in each live just-bash interpreter. just-bash's
 * `defineCommand()` returns one; use it when a command needs the rest of
 * just-bash's command context, such as standard input or `exec`.
 */
export interface JustBashCommand {
  readonly name: string;
  /** Runs the command with direct access to Node.js globals, as `defineCommand()` does. */
  readonly trusted?: boolean;
  execute(args: string[], context: JustBashCommandContext): Promise<JustBashCommandResult>;
}

/** A command that just-bash loads on its first run. */
export interface JustBashLazyCommand {
  readonly name: string;
  load(): Promise<JustBashCommand>;
}

export type JustBashCustomCommand = JustBashCommand | JustBashLazyCommand;

export interface JustBashCommandContext {
  readonly cwd: string;
  readonly env: ReadonlyMap<string, string>;
  readonly fs: JustBashFilesystem;
  readonly signal?: AbortSignal;
}

export interface JustBashCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Context passed to a custom just-bash filesystem factory for each live handle.
 */
export interface JustBashFilesystemContext {
  /** Resolves an application-relative path without exposing project layout. */
  resolveProjectPath(path: string): string;
  /** Stable provider-private storage directory for this sandbox. */
  readonly storagePath: string;
  /** eve's durable, session-owned filesystem, including `/workspace`. */
  readonly defaultFilesystem: JustBashFilesystem;
  /** The just-bash engine resolved by eve after its optional installation check. */
  readonly justBash: typeof import("just-bash");
}

/**
 * Options accepted by just-bash environment constructors.
 *
 * The just-bash provider runs the workspace under the pure-JS `just-bash`
 * interpreter with a virtual filesystem — no daemon or VM required, but
 * no real binaries either. The `just-bash` package is not bundled with
 * eve; it is loaded lazily from the application install.
 */
export interface JustBashSandboxCreateOptions {
  /**
   * When the `just-bash` package is missing from the application,
   * install it automatically with the project's package manager. Only
   * runs during `eve dev`; production processes always fail with an
   * actionable install error instead. Defaults to `true`.
   */
  readonly autoInstall?: boolean;
  /**
   * Registers trusted host application code as commands in each live
   * just-bash interpreter. Custom commands can participate in normal shell
   * composition, including pipelines and redirections.
   *
   * Custom commands are not available during environment preparation. They run in
   * eve's host process, outside the virtual filesystem security boundary, and
   * are responsible for validating their own inputs and cleaning up host
   * resources.
   */
  readonly customCommands?: ReadonlyArray<JustBashCustomCommand>;
  /**
   * Composes the filesystem used by each live sandbox handle. The factory is
   * called when a handle opens with eve's durable default filesystem; return a
   * fresh filesystem that preserves eve-owned paths such as `/workspace`,
   * `/tmp`, and the home directory.
   *
   * This just-bash-specific escape hatch requires the application to install
   * a compatible `just-bash` version. It is not invoked during template
   * preparation.
   */
  readonly filesystem?: (
    context: JustBashFilesystemContext,
  ) => JustBashFilesystem | Promise<JustBashFilesystem>;
}
