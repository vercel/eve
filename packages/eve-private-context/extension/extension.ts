import { defineExtension } from "eve/extension";

export { audiencePolicy, privateContext, privateContextPolicy, strictest } from "./lib/policy.ts";
export {
  EXPORT_TAG,
  EXTERNAL_TAG,
  PERSONAL_TAG,
  type AudiencePolicyOptions,
  type PersonalContext,
  type PrivateContextPolicyOptions,
} from "./lib/private-context.ts";

export default defineExtension();
