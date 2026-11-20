import { determineAgent } from "#compiled/@vercel/detect-agent/index.js";

export async function isCodingAgentLaunch(): Promise<boolean> {
  return (await determineAgent()).isAgent;
}
