/** The mock model asks for every label in one step when a prompt names this tool. */
export const FANOUT_TOOL_NAME = "fanout-barrier";

export const FANOUT_LABELS = Array.from(
  { length: 10 },
  (_, index) => `fanout-${String(index + 1).padStart(2, "0")}`,
);

export const FANOUT_REPLY = "fanout complete";
