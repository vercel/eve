import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.wire");

export async function reportDroppedWirePayloadStep(input: {
  readonly detail: string;
  readonly family: string;
}): Promise<void> {
  "use step";

  log.error("dropping undecodable wire payload", { detail: input.detail, family: input.family });
}
