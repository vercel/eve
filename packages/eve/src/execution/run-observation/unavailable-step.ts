import type { ObservationState } from "#execution/run-observation/state.js";

/** A failed child read is an observation gap, never a failed child task. */
export async function markObservationUnavailableStep(input: {
  readonly state: ObservationState;
  readonly sourceKey: string;
}): Promise<ObservationState> {
  "use step";
  const source = input.state.sources[input.sourceKey];
  if (source === undefined || source.unavailable) return input.state;
  return {
    ...input.state,
    revision: input.state.revision + 1,
    sources: { ...input.state.sources, [input.sourceKey]: { ...source, unavailable: true } },
  };
}

/** A successful empty read closes an observation gap without changing child execution state. */
export async function markObservationAvailableStep(input: {
  readonly state: ObservationState;
  readonly sourceKey: string;
}): Promise<ObservationState> {
  "use step";
  const source = input.state.sources[input.sourceKey];
  if (source?.unavailable !== true) return input.state;
  return {
    ...input.state,
    revision: input.state.revision + 1,
    sources: { ...input.state.sources, [input.sourceKey]: { ...source, unavailable: false } },
  };
}
