import { createHash } from "node:crypto";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER } from "#internal/workflow/development-world-protocol.js";
import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import { resolveModelApiKey } from "./api-key.js";
import { resolveGatewayModelCredential } from "./gateway-credential.js";
import {
  DEVELOPMENT_MODEL_CREDENTIAL_ROUTE,
  DEVELOPMENT_MODEL_REJECTED_HEADER,
  type DevelopmentModelCredential,
} from "./development-broker-protocol.js";

export async function handleDevelopmentModelCredentialRequest(
  request: Request,
  input: { appRoot: string; secret: string },
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== DEVELOPMENT_MODEL_CREDENTIAL_ROUTE) return undefined;
  const headers = { "cache-control": "no-store" };
  const authorization = request.headers.get(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER);
  if (authorization === null || !timingSafeEqualStrings(authorization, input.secret))
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (request.method !== "GET")
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  const provider = url.searchParams.get("provider");
  const rejected = request.headers.get(DEVELOPMENT_MODEL_REJECTED_HEADER);
  if (
    !["gateway", "chatgpt", "openai", "anthropic"].includes(provider ?? "") ||
    (rejected !== null && !/^[a-f0-9]{64}$/u.test(rejected))
  )
    return Response.json({ error: "Invalid credential request" }, { status: 400, headers });
  const wasRejected = (token: string) =>
    rejected === createHash("sha256").update(token).digest("hex");
  try {
    await loadDevelopmentEnvironmentFiles(input.appRoot);
    let credential: DevelopmentModelCredential;
    if (provider === "gateway") {
      credential = await resolveGatewayModelCredential();
      if (wasRejected(credential.token) && credential.kind === "oauth")
        credential = await resolveGatewayModelCredential(credential.token);
    } else if (provider === "chatgpt") {
      const broker = getDefaultCodexTokenBroker();
      let token = await broker.getToken({ reason: "request" });
      if (wasRejected(token.token)) token = await broker.getToken({ reason: "rejected" });
      credential = { kind: "oauth", ...token };
    } else {
      credential = {
        kind: "api-key",
        token: await resolveModelApiKey(provider as "openai" | "anthropic"),
      };
    }
    return Response.json(credential, { headers });
  } catch {
    return Response.json(
      { error: "The model connection is unavailable. Run /login to reconnect." },
      { status: 503, headers },
    );
  }
}
