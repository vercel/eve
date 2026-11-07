/**
 * A tool failure whose model-facing text an app chose. The model reads `message`; logs, telemetry,
 * and the published result report `cause`, the error the call failed with.
 */
export class ModelFacingError extends Error {
  constructor(message: string, options: { readonly cause: unknown }) {
    super(message, options);
    this.name = "ModelFacingError";
  }
}
