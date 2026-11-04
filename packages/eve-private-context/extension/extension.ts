import { defineExtension } from "eve/extension";

export {
  audiencePolicy,
  exceedsCap,
  privateContext,
  privateContextPolicy,
  strictest,
} from "./lib/policy.ts";
export {
  EXTERNAL_TAG,
  INTERNAL_SINK_TAG,
  IRREVERSIBLE_TAG,
  PERSONAL_TAG,
  PUBLIC_SINK_TAG,
  SENSITIVE_TAG,
  USER_SINK_TAG,
  type AudiencePolicyOptions,
  type PersonalContext,
  type PrivateContextPolicyOptions,
  type ReadLevel,
  type SinkCap,
  type SinkOptions,
} from "./lib/private-context.ts";

export default defineExtension();
