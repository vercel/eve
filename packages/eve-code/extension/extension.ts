import { defineExtension } from "eve/extension";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

export type CredentialPolicyBroker = (
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
) => Promise<void>;

export interface GitHubLeaseRule {
  readonly match?: {
    readonly headers?: readonly {
      readonly key?: { readonly exact: string };
      readonly value?: { readonly exact?: string; readonly regex?: string };
    }[];
  };
  readonly transform: readonly { readonly headers: Readonly<Record<string, string>> }[];
}

export type GitHubLeaseBroker = (
  sandbox: SandboxSession,
  rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
) => Promise<void>;

const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const delivery = z.enum(["firewall", "command"]).default("firewall");
const reasoning = z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]);
const openaiReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export default defineExtension({
  config: z.object({
    github: z
      .object({
        connector: z.string().min(1),
        org: z.string().min(1),
        broker: fn<GitHubLeaseBroker>(),
      })
      .optional(),
    vercel: z
      .object({
        connector: z.string().min(1),
        delivery,
      })
      .optional(),
    broker: fn<CredentialPolicyBroker>().optional(),
    worker: z
      .object({
        model: z.string().min(1),
        reasoning,
        openaiReasoningEffort: openaiReasoningEffort.optional(),
      })
      .optional(),
  }),
});
