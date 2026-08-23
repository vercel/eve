import { InstrumentationControlsKey } from "#context/keys.js";

/** Retains a delivery decision while rolling back the rest of a cancelled turn. */
export function preserveSerializedInstrumentationControls(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const controls = after[InstrumentationControlsKey.name];
  return controls === undefined
    ? before
    : { ...before, [InstrumentationControlsKey.name]: controls };
}
