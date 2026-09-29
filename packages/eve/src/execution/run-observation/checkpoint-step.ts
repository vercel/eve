import {
  applyObservationPage,
  type IndexedRecord,
  type ObservationState,
} from "#execution/run-observation/state.js";

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_SOURCES = 32;
const MAX_TURNS = 10;

/** Commits cursor, projection, discovery and reply provenance as one durable result. */
export async function checkpointObservationStep(input: {
  readonly state: ObservationState;
  readonly sourceKey: string;
  readonly records: readonly IndexedRecord[];
}): Promise<ObservationState> {
  "use step";
  const next = applyObservationPage(input.state, input.sourceKey, input.records);
  if (
    next.sourceOrder.length > MAX_SOURCES ||
    Object.keys(next.sources[next.rootKey]?.conversation.turns ?? {}).length > MAX_TURNS
  ) {
    throw new Error("Run observation fixture capacity exceeded (sources or root turns).");
  }
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_CHECKPOINT_BYTES) {
    throw new Error("Run observation checkpoint exceeds 4 MiB; source cursor was not advanced.");
  }
  return next;
}
