import { withPackageUserAgent } from "#internal/user-agent.js";

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

export const AI_GATEWAY_MODELS_URL = `${GATEWAY_BASE_URL}/v1/models`;

export const AI_GATEWAY_MODELS_CATALOG_URL = `${GATEWAY_BASE_URL}/v1/models/catalog`;

export const vercelGatewayFetch: typeof globalThis.fetch = withPackageUserAgent();
