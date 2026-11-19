import { defineExtension } from "eve/extension";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

/**
 * Callback that merges credential header rules, keyed by host, into the consumer's own sandbox network policy.
 * Pass it as `broker` when firewall delivery should not replace the sandbox's network policy itself.
 */
export type CredentialPolicyBroker = (
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
) => Promise<void>;

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const delivery = z.enum(["firewall", "command"]).default("firewall");

function removedWorkerMessage(keys: readonly string[]): string | undefined {
  if (!keys.includes("worker")) return undefined;
  const others = keys.filter((key) => key !== "worker");
  const also =
    others.length === 0
      ? ""
      : ` Also unrecognized: ${others.map((key) => JSON.stringify(key)).join(", ")}.`;
  return `eve-code no longer ships a worker subagent; delegate with the built-in \`agent\` tool and remove the \`worker\` option.${also}`;
}

/**
 * Adds coding support to an agent: coding instructions for eve's file tools, the workspace's `AGENTS.md` or `CLAUDE.md` as project instructions, investigation and review skills, and sandbox tooling.
 * Set `vercel` to broker Connect-backed Vercel credentials into the sandbox before each turn.
 */
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
        issue.code === "unrecognized_keys" ? removedWorkerMessage(issue.keys) : undefined,
    },
  ),
});
