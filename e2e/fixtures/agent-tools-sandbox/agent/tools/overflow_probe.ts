import { defineTool } from "eve/tools";
import { z } from "zod";
import { OVERFLOW_PROBE_PAYLOAD_BYTES, OVERFLOW_PROBE_TOKEN } from "../lib/overflow-probe.js";

export default defineTool({
  description:
    "Smoke-test fixture: returns deterministic oversized JSON. Only call when explicitly asked to use `overflow_probe`.",
  inputSchema: z.object({}),
  execute() {
    return {
      marker: OVERFLOW_PROBE_TOKEN,
      payload: "x".repeat(OVERFLOW_PROBE_PAYLOAD_BYTES),
    };
  },
});
