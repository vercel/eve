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
}
