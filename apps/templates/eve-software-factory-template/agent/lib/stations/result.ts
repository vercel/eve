import { sanitizeCommandOutput } from "../github/bootstrap-diagnostics.js";

/**
 * The settled result of a station run, as `ctx.agent(id).send(...).result()`
 * reports it.
 */
export type StationResult =
  | {
      readonly data?: unknown;
      readonly error?: never;
      readonly status: "completed" | "cancelled";
    }
  | {
      readonly data?: unknown;
      readonly error: { readonly message: string };
      readonly status: "failed";
    };

/**
 * Returns a completed station's structured output, or throws with what went
 * wrong.
 *
 * @remarks
 * A station's result does not throw on failure: a station that answered in
 * prose instead of the requested structure settles as `failed`, and one that
 * was interrupted settles as `cancelled`, both with no data. Returning that
 * as-is would hand the orchestrator `undefined` and let it carry on as if the
 * station had nothing to say. Throwing surfaces the failure as a tool error,
 * which is what the orchestrator's retry-once rule keys on.
 *
 * @param station - The station's name, for the error message.
 * @throws When the run failed, was cancelled, or completed with no data.
 */
export const stationOutput = (
  station: string,
  result: StationResult
): unknown => {
  if (result.status === "failed") {
    throw new Error(
      `The ${station} station failed: ${sanitizeCommandOutput(result.error.message).slice(0, 500)}`
    );
  }
  if (result.status === "cancelled") {
    throw new Error(
      `The ${station} station was cancelled before it returned a result.`
    );
  }
  if (result.data === undefined || result.data === null) {
    throw new Error(
      `The ${station} station finished without the structured result it was asked for.`
    );
  }
  return result.data;
};
