import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.wire");

/**
 * Surfaces a durable payload dropped by a wire codec's decode.
 *
 * Workflow-context consumers cannot log directly — the logging module pulls
 * Node builtins the workflow driver bundle must not contain — so the report
 * crosses a step boundary. The recorded step also leaves a durable trace in
 * the run's event log, which is the operator-visible half of the "drop
 * loudly, never reinterpret" wire contract.
 */
export async function reportDroppedWirePayloadStep(input: {
  readonly detail: string;
  readonly family: string;
}): Promise<void> {
  "use step";

  log.error("dropping undecodable wire payload", { detail: input.detail, family: input.family });
}
