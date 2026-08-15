/**
 * Public definition for an instructions prompt authored in markdown or
 * TypeScript.
 *
 * Authored at the agent root as either `instructions.md` or
 * `instructions.{ts,cts,mts,js,cjs,mjs}`, or inside the
 * `agent/instructions/` directory for multi-file setups. Module-backed
 * static instructions execute once at build time. The compiler captures
 * the resulting content into the compiled manifest.
 */
export type PublicInstructionsDefinition =
  | {
      readonly content: string;
      readonly role?: "system" | "user";
      readonly markdown?: never;
    }
  | {
      /** @deprecated Use `content`. */
      readonly markdown: string;
      readonly content?: never;
      readonly role?: never;
    };

export type InstructionsRole = "system" | "user";

/**
 * Internal definition for an instructions prompt authored in markdown or
 * TypeScript.
 */
export interface InternalInstructionsDefinition {
  readonly content: string;
  readonly name: string;
  readonly role: InstructionsRole;
}
