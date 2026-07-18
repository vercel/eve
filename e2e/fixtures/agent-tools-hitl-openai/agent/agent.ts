import { defineAgent } from "eve";

/**
 * HITL fixture whose OpenAI matrix leg covers the Responses provider path
 * (https://github.com/vercel/eve/issues/236). Approval-gated executable
 * tools must complete an approve and execute cycle when the replayed history is
 * validated by OpenAI's `function_call` / `function_call_output` pairing.
 */
export default defineAgent({
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
});
