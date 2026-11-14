// eve's Vite entries declare their plugin without importing `vite`. eve doesn't
// declare `vite` as a peer, so its declarations would otherwise resolve
// whichever copy is hoisted, not the app's.

/**
 * The Vite plugin eve's Vite entries return. Register it in Vite's `plugins`.
 * It is a Vite `Plugin`, typed by its name alone so the type holds for any
 * Vite version the app installs.
 */
export interface EveVitePlugin {
  readonly name: string;
}

/**
 * Options for eve's Vite plugins.
 */
export interface EveVitePluginOptions {
  /**
   * Maximum time in milliseconds to wait for each eve development server to
   * start, including waiting for another Vite process to start it. Defaults
   * to 180000 (three minutes).
   */
  readonly devServerTimeoutMs?: number;
  /**
   * Path to the eve project root, relative to the Vite root unless absolute.
   * The root may contain one `agent/` or an `agents/` workspace. Defaults to
   * the Vite root.
   */
  readonly eveRoot?: string;
  /**
   * Command that builds each eve agent inside its generated Vercel service.
   * Defaults to running the installed eve binary from the agent root
   * (`node <path-to>/eve/bin/eve.js build`).
   */
  readonly eveBuildCommand?: string;
}
