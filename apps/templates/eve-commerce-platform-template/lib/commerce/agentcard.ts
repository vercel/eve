import { AgentcardClient } from "@agent-cards/commerce-sdk";
import { env } from "@/lib/environment/env";

// One client per deployment shares the company access token across shoppers,
// for the buy tool and for the webhook that reads where a purchase stands.
let client: AgentcardClient | undefined;

// Undefined when the deployment has no Agentcard credentials.
export function agentcardClient() {
  const clientId = env.AGENTCARD_CLIENT_ID;
  const clientSecret = env.AGENTCARD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  client ??= new AgentcardClient({ clientId, clientSecret });
  return client;
}
