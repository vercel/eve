import { createHash, randomBytes } from "node:crypto";
import { get, put } from "@vercel/blob";
import { z } from "zod";
import { betterAuthSecretSchema, env } from "@/lib/environment/env";

const installationSecretsSchema = z.object({
  betterAuthSecret: betterAuthSecretSchema,
  version: z.literal(1),
});

export type InstallationSecrets = z.infer<typeof installationSecretsSchema>;

const maximumInstallationSecretsBytes = 1024;
let installationSecretsPromise: Promise<InstallationSecrets> | undefined;

// The auth secret signs sessions and contact-card links. An explicit
// BETTER_AUTH_SECRET wins; otherwise one is generated once per Vercel project
// and kept in the connected private Blob store.
export function getInstallationSecrets() {
  installationSecretsPromise ??= resolveInstallationSecretsWithRetry();
  return installationSecretsPromise;
}

async function resolveInstallationSecretsWithRetry() {
  try {
    return await resolveInstallationSecrets();
  } catch (error) {
    installationSecretsPromise = undefined;
    throw error;
  }
}

async function resolveInstallationSecrets() {
  if (env.BETTER_AUTH_SECRET) {
    return installationSecretsSchema.parse({
      betterAuthSecret: env.BETTER_AUTH_SECRET,
      version: 1,
    });
  }

  if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "Installation secrets are unavailable. Connect a private Vercel Blob store or set BETTER_AUTH_SECRET.",
    );
  }
  const pathname = installationSecretsPathname();
  const existing = await readInstallationSecrets(pathname);
  if (existing) return existing;

  const generated = installationSecretsSchema.parse({
    betterAuthSecret: randomBytes(32).toString("base64"),
    version: 1,
  });
  try {
    await put(pathname, JSON.stringify(generated), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 365 * 24 * 60 * 60,
      contentType: "application/json",
      maximumSizeInBytes: maximumInstallationSecretsBytes,
    });
    return generated;
  } catch (error) {
    // Another instance may have written the secret first.
    const winner = await readInstallationSecrets(pathname);
    if (winner) return winner;
    throw error;
  }
}

async function readInstallationSecrets(pathname: string) {
  const result = await get(pathname, {
    access: "private",
    useCache: false,
  });
  if (!result) return undefined;
  if (result.statusCode !== 200) {
    throw new Error("The installation secrets Blob returned no content.");
  }
  if (result.blob.size > maximumInstallationSecretsBytes) {
    throw new Error("The installation secrets Blob is unexpectedly large.");
  }
  const value: unknown = await new Response(result.stream).json();
  return installationSecretsSchema.parse(value);
}

function installationSecretsPathname() {
  const scope = createHash("sha256")
    .update(env.VERCEL_PROJECT_ID ?? "standalone")
    .digest("hex")
    .slice(0, 32);
  return `evey/system/${scope}/installation-secrets.v1.json`;
}
