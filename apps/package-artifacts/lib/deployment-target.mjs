import { PULL_REQUEST_PATTERN, SHA_PATTERN } from "./package.mjs";

const REPOSITORY = "vercel/eve";
const REPOSITORY_OWNER = "vercel";
const REPOSITORY_SLUG = "eve";

export async function resolveDeploymentTarget(env, fetchImplementation = fetch) {
  if (
    env.VERCEL_GIT_REPO_OWNER !== REPOSITORY_OWNER ||
    env.VERCEL_GIT_REPO_SLUG !== REPOSITORY_SLUG
  ) {
    return undefined;
  }

  const isMain = env.VERCEL_ENV === "production" && env.VERCEL_GIT_COMMIT_REF === "main";
  const isPreview = env.VERCEL_ENV === "preview";
  if (!isMain && !isPreview) return undefined;

  const sourceSha = env.VERCEL_GIT_COMMIT_SHA;
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
  }
  const packageDomain = env.VERCEL_PROJECT_PRODUCTION_URL;
  if (typeof packageDomain !== "string" || packageDomain.length === 0) {
    throw new Error("VERCEL_PROJECT_PRODUCTION_URL is required for package publishing.");
  }

  const ref = isMain ? "main" : await resolvePullRequest(env, sourceSha, fetchImplementation);
  if (ref === undefined) return undefined;
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

async function resolvePullRequest(env, sourceSha, fetchImplementation) {
  const pullRequest = env.VERCEL_GIT_PULL_REQUEST_ID;
  if (PULL_REQUEST_PATTERN.test(pullRequest ?? "")) {
    const pull = await githubRequest(
      `/repos/${REPOSITORY}/pulls/${pullRequest}`,
      fetchImplementation,
    );
    return isCurrentPullRequest(pull, sourceSha, env.VERCEL_GIT_COMMIT_REF)
      ? pullRequest
      : undefined;
  }

  const branch = env.VERCEL_GIT_COMMIT_REF;
  if (typeof branch !== "string" || branch.length === 0) return undefined;
  const query = new URLSearchParams({
    base: "main",
    head: `${REPOSITORY_OWNER}:${branch}`,
    state: "open",
  });
  const pulls = await githubRequest(`/repos/${REPOSITORY}/pulls?${query}`, fetchImplementation);
  const matches = pulls.filter((pull) => isCurrentPullRequest(pull, sourceSha, branch));
  return matches.length === 1 ? String(matches[0].number) : undefined;
}

function isCurrentPullRequest(pull, sourceSha, branch) {
  return (
    pull.state === "open" &&
    pull.base?.ref === "main" &&
    pull.head?.ref === branch &&
    pull.head?.repo?.full_name === REPOSITORY &&
    pull.head?.sha === sourceSha
  );
}

async function githubRequest(pathname, fetchImplementation) {
  const response = await fetchImplementation(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while resolving package publication.`);
  }
  return response.json();
}
