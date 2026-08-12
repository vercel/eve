import { vercelOidc } from "#public/agents/auth.js";
import {
  defineRemoteAgent,
  type RemoteAgentDefinition,
  type RemoteAgentDefinitionInput,
} from "#public/definitions/remote-agent.js";

/**
 * Defines a remote eve agent at a Vercel branch Preview Deployment.
 *
 * `url` is the branch's stable Preview URL, not an immutable deployment URL.
 * The branch remains user-facing registration identity while Vercel advances
 * the URL to the latest deployment for it. eve does not derive this URL: Vercel
 * preview suffixes and custom branch domains are deployment configuration.
 */
export interface VercelBranchAgentInput extends Omit<RemoteAgentDefinitionInput, "auth" | "url"> {
  /** Git branch represented by the Preview Deployment. */
  readonly branch: string;
  /** Stable Vercel branch Preview URL. */
  readonly url: string;
}

/**
 * Returns a normal remote-agent definition for a Vercel branch Preview
 * Deployment. Outbound Vercel OIDC authenticates this deployment to the
 * preview; forwarding the end-user principal remains an explicit opt-in.
 */
export function defineVercelBranchAgent(input: VercelBranchAgentInput): RemoteAgentDefinition {
  const { branch: rawBranch, ...remote } = input;
  const branch = rawBranch.trim();
  if (!branch) throw new Error("defineVercelBranchAgent requires a non-empty branch.");

  return defineRemoteAgent({
    ...remote,
    auth: vercelOidc(),
  });
}
