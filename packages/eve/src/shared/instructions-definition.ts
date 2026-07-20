/**
 * Public definition for an instructions prompt authored in markdown or
 * TypeScript.
 *
 * Authored at the agent root as either `instructions.md` or
 * `instructions.{ts,cts,mts,js,cjs,mjs}`, or inside the
 * `agent/instructions/` directory for multi-file setups. Module-backed
 * static instructions execute once at build time. The compiler captures
 * the resulting markdown into the compiled manifest.
 *
 * When used inside a `defineDynamic` handler, the runtime lowers the
 * returned markdown to `{ role: "system", content: markdown }`.
 * Instructions produce system messages only. Use channel `context` for
 * user-role messages.
 */
export interface PublicInstructionsDefinition {
  markdown: string;
}

/**
 * Internal definition for an instructions prompt authored in markdown or
 * TypeScript.
 */
export interface InternalInstructionsDefinition {
  name: string;
  markdown: string;
}
