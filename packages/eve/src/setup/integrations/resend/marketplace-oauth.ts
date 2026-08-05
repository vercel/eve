import { randomUUID } from "node:crypto";

import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import { runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

const ConnectorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  supportedSubjectTypes: z.array(z.string()).optional(),
});
const TokenSchema = z.object({ token: z.string().min(1) });
const ApiKeySchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
});

export interface MarketplaceOAuthDeps {
  fetch: typeof fetch;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const defaultDeps: MarketplaceOAuthDeps = { fetch, runVercelCaptureStdout };

function parseJson(stdout: string, description: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`Vercel returned invalid JSON for ${description}.`);
  }
}

async function cleanupSetupConnector(input: {
  connectorUid: string;
  projectRoot: string;
  orgId: string;
  signal?: AbortSignal;
  deps: MarketplaceOAuthDeps;
}): Promise<void> {
  await input.deps.runVercelCaptureStdout(
    [
      "connect",
      "revoke-tokens",
      input.connectorUid,
      "--my-tokens",
      "--yes",
      "--format",
      "json",
      "--scope",
      input.orgId,
    ],
    { cwd: input.projectRoot, nonInteractive: true, signal: input.signal },
  );
  const removed = await input.deps.runVercelCaptureStdout(
    [
      "connect",
      "remove",
      input.connectorUid,
      "--disconnect-all",
      "--yes",
      "--format",
      "json",
      "--scope",
      input.orgId,
    ],
    { cwd: input.projectRoot, nonInteractive: true, signal: input.signal },
  );
  if (!removed.ok) {
    throw new Error(
      `Could not remove temporary connector ${input.connectorUid}. Run \`vercel connect remove ${input.connectorUid} --disconnect-all --yes\`.`,
    );
  }
}

/** Dedicated Resend API key created with a temporary setup authorization. */
export interface CreatedResendApiKey {
  readonly id: string;
  readonly token: string;
}

/** Creates a full-access API key for durable runtime use. */
export async function createResendApiKey(input: {
  accessToken: string;
  name: string;
  signal?: AbortSignal;
  deps?: Pick<MarketplaceOAuthDeps, "fetch">;
}): Promise<CreatedResendApiKey> {
  const response = await (input.deps ?? defaultDeps).fetch("https://api.resend.com/api-keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: input.name.slice(0, 50), permission: "full_access" }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Resend API-key creation failed with HTTP ${response.status}.`);
  const parsed = ApiKeySchema.safeParse((await response.json()) as unknown);
  if (!parsed.success) throw new Error("Resend returned an invalid API key.");
  return parsed.data;
}

/** Deletes a setup-created API key after a later failure. */
export async function deleteResendApiKey(input: {
  accessToken: string;
  id: string;
  signal?: AbortSignal;
  deps?: Pick<MarketplaceOAuthDeps, "fetch">;
}): Promise<void> {
  const response = await (input.deps ?? defaultDeps).fetch(
    `https://api.resend.com/api-keys/${encodeURIComponent(input.id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: input.signal,
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Resend API-key cleanup failed with HTTP ${response.status}.`);
  }
}

/** Temporary user OAuth authorization used only during guided setup. */
export interface ResendSetupAuthorization {
  readonly accessToken: string;
  readonly connectorUid: string;
  cleanup(): Promise<void>;
}

/** Authorizes Resend full access through Connect without reading project environment secrets. */
export async function authorizeResendMarketplaceSetup(input: {
  log: ChannelSetupLog;
  projectRoot: string;
  orgId: string;
  signal?: AbortSignal;
  deps?: MarketplaceOAuthDeps;
}): Promise<ResendSetupAuthorization> {
  const deps = input.deps ?? defaultDeps;
  const onOutput = createPromptCommandOutput(input.log);
  const name = `eve-resend-setup-${randomUUID().slice(0, 8)}`;
  const created = await withPhase(
    input.log,
    "Creating a temporary Resend authorization...",
    () =>
      deps.runVercelCaptureStdout(
        [
          "connect",
          "create",
          "api.resend.com",
          "--name",
          name,
          "--format",
          "json",
          "--scope",
          input.orgId,
        ],
        { cwd: input.projectRoot, onOutput, signal: input.signal },
      ),
    { kind: "external-action", emphasis: "browser" },
  );
  if (!created.ok) {
    throw new Error("Could not create the temporary Resend OAuth connector.");
  }
  const connector = ConnectorSchema.safeParse(
    parseJson(created.stdout, "the temporary Resend connector"),
  );
  if (!connector.success || !connector.data.supportedSubjectTypes?.includes("user")) {
    throw new Error("The temporary Resend connector does not support user OAuth authorization.");
  }

  try {
    const tokenResult = await withPhase(
      input.log,
      "Authorize Resend full access in the browser...",
      () =>
        deps.runVercelCaptureStdout(
          [
            "connect",
            "token",
            connector.data.uid,
            "--scopes",
            "full_access",
            "--yes",
            "--format",
            "json",
            "--scope",
            input.orgId,
          ],
          { cwd: input.projectRoot, onOutput, signal: input.signal },
        ),
      { kind: "external-action", emphasis: "browser" },
    );
    if (!tokenResult.ok) throw new Error("Resend OAuth authorization was not completed.");
    const token = TokenSchema.safeParse(parseJson(tokenResult.stdout, "the Resend OAuth token"));
    if (!token.success) throw new Error("Vercel returned an invalid Resend OAuth token.");
    return {
      accessToken: token.data.token,
      connectorUid: connector.data.uid,
      cleanup: () =>
        cleanupSetupConnector({
          connectorUid: connector.data.uid,
          projectRoot: input.projectRoot,
          orgId: input.orgId,
          signal: input.signal,
          deps,
        }),
    };
  } catch (error) {
    await cleanupSetupConnector({
      connectorUid: connector.data.uid,
      projectRoot: input.projectRoot,
      orgId: input.orgId,
      signal: input.signal,
      deps,
    }).catch(() => {});
    throw error;
  }
}
