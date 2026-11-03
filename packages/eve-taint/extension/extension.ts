import { defineExtension } from "eve/extension";
import { z } from "zod";

export { taintPolicy, taintRuntimeContext } from "./lib/policy.ts";
export {
  EXPORT_TAG,
  EXTERNAL_TAG,
  UNTRUSTED_TAG,
  type Exposure,
  type TaintPolicyOptions,
} from "./lib/taint.ts";

export default defineExtension({
  config: z.object({
    /**
     * Whether a message from anyone other than the session's initiator exposes the session.
     * Default `true`.
     */
    untrustedMessages: z.boolean().default(true),
  }),
});
