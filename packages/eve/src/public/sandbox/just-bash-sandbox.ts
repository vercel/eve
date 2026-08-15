import type { IFileSystem } from "just-bash";

/**
 * Context passed to a custom just-bash filesystem factory for each live handle.
 */
export interface JustBashFilesystemContext {
  /** Stable application root for this backend create call. */
  readonly appRoot: string;
  /** eve's durable, session-owned filesystem, including `/workspace`. */
  readonly defaultFilesystem: IFileSystem;
}

/**
 * Options accepted by `justbash(opts)`.
 *
 * The just-bash backend runs the workspace under the pure-JS `just-bash`
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
   * Composes the filesystem used by each live sandbox handle. The factory is
   * called when a handle opens with eve's durable default filesystem; return a
   * fresh filesystem that preserves eve-owned paths such as `/workspace`,
   * `/tmp`, and the home directory.
   *
   * This just-bash-specific escape hatch requires the application to install
   * a compatible `just-bash` version. It is not invoked during template
   * prewarming.
   */
  readonly filesystem?: (context: JustBashFilesystemContext) => IFileSystem | Promise<IFileSystem>;
}
