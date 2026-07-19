import type { LanguageModel } from "ai";

import { appendPackageUserAgent, buildPackageUserAgent } from "#internal/user-agent.js";

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

export function buildGatewayURL(pathname: `/${string}`): string {
  return `${GATEWAY_BASE_URL}${pathname}`;
}

export function buildGatewayUA(): string {
  return buildPackageUserAgent();
}

export function addGatewayUA(headers: Headers): Headers {
  return appendPackageUserAgent(headers);
}

export function isGatewayModel(model: LanguageModel): boolean {
  return typeof model === "string" || model.provider?.split(".")[0] === "gateway";
}
