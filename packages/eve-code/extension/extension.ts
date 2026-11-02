import { defineExtension } from "eve/extension";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

export type CredentialPolicyBroker = (
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
) => Promise<void>;

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const delivery = z.enum(["firewall", "command"]).default("firewall");

// Point mounts that still pass the removed `worker` option at the replacement
// instead of the generic unrecognized-key error.
const removedWorker =
  "eve-code no longer ships a worker subagent; delegate with the core `agent` tool and remove the `worker` option.";

export default defineExtension({
  config: z.strictObject(
    {
      vercel: z
        .object({
          connector: z.string().min(1),
          delivery,
        })
        .optional(),
      broker: fn<CredentialPolicyBroker>().optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys" && issue.keys.includes("worker")
          ? removedWorker
          : undefined,
    },
  ),
});
