import { defineExtension } from "eve/extension";
import { z } from "zod";

export { untrustedContentPolicy, untrustedContentRuntimeContext } from "./lib/policy.ts";
export {
  EXTERNAL_TAG,
  IRREVERSIBLE_TAG,
  PUBLIC_SINK_TAG,
  UNTRUSTED_TAG,
  type Exposure,
  type UntrustedContentPolicyOptions,
} from "./lib/untrusted-content.ts";

export default defineExtension({
  config: z.object({
    /**
     * Whether a message from anyone other than the session's initiator exposes the session.
     * Default `true`.
     */
    untrustedMessages: z.boolean().default(true),
  }),
});
