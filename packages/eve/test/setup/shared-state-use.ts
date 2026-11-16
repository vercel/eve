/**
 * `vi.mock`-style calls, module graph resets, and process-wide writes that outlive a test file.
 *
 * A file this matches keeps its own process and module graph: `vi.mock` only applies to a module
 * the worker has not imported yet, and a stub, fake timer or `process.env` write changes what the
 * next file in the worker sees. Both tiers' configs decide their isolated project from it.
 */
export const SHARED_STATE_USE =
  /\bvi\.(?:mock|doMock|resetModules|stubGlobal|stubEnv|useFakeTimers|setSystemTime)\(|process\.env(?:\.\w+|\[[^\]]+\])\s*(?:=|\+=)|process\.chdir\(/;
