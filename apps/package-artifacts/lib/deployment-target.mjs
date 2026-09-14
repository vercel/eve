import { PULL_REQUEST_PATTERN, SHA_PATTERN } from "./package.mjs";

const REPOSITORY_OWNER = "vercel";
const REPOSITORY_SLUG = "eve";

export function resolveDeploymentTarget(env) {
  if (
    env.VERCEL_GIT_REPO_OWNER !== REPOSITORY_OWNER ||
    env.VERCEL_GIT_REPO_SLUG !== REPOSITORY_SLUG
  ) {
    return undefined;
  }

  let ref;
  if (env.VERCEL_ENV === "production" && env.VERCEL_GIT_COMMIT_REF === "main") {
    ref = "main";
  } else if (
    env.VERCEL_ENV === "preview" &&
    PULL_REQUEST_PATTERN.test(env.VERCEL_GIT_PULL_REQUEST_ID ?? "")
  ) {
    ref = env.VERCEL_GIT_PULL_REQUEST_ID;
  } else {
    return undefined;
  }

  const sourceSha = env.VERCEL_GIT_COMMIT_SHA;
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
  }
  const packageDomain = env.VERCEL_PROJECT_PRODUCTION_URL;
  if (typeof packageDomain !== "string" || packageDomain.length === 0) {
    throw new Error("VERCEL_PROJECT_PRODUCTION_URL is required for package publishing.");
  }

  return { sourceSha, ref, origin: `https://${packageDomain}` };
}

export function vercelOidcCredentials(env) {
  const oidcToken = env.VERCEL_OIDC_TOKEN;
  const storeId = env.BLOB_STORE_ID;
  if (typeof oidcToken !== "string" || oidcToken.length === 0) {
    throw new Error("VERCEL_OIDC_TOKEN is required for package publishing.");
  }
  if (typeof storeId !== "string" || storeId.length === 0) {
    throw new Error("BLOB_STORE_ID is required for package publishing.");
  }
  return { oidcToken, storeId };
}
