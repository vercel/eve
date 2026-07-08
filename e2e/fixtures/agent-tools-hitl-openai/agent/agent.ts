import { defineAgent } from "eve";

/**
 * HITL fixture pinned to the OpenAI Responses provider path
 * (https://github.com/vercel/eve/issues/236): approval-gated executable
 * tools must complete an approve→execute cycle when the replayed history is
 * validated by OpenAI's `function_call` / `function_call_output` pairing.
 */
export default defineAgent({
  model: "openai/gpt-5.5",
});
