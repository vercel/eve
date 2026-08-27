import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

/**
 * HITL fixture whose OpenAI matrix leg covers the Responses provider path
 * (https://github.com/vercel/eve/issues/236). Approval-gated executable
 * tools must complete an approve and execute cycle when the replayed history is
 * validated by OpenAI's `function_call` / `function_call_output` pairing.
 */
export default defineAgent({
  ...e2eAgentConfig(),
});
