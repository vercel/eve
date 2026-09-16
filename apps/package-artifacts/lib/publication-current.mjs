import { PULL_REQUEST_PATTERN, SHA_PATTERN } from "./package.mjs";

export async function assertCurrentPublicationTarget(
  { repository, ref, sourceSha, token },
  fetchImplementation = fetch,
) {
  if (!/^[^/]+\/[^/]+$/.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY must identify an owner and repository.");
  }
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    throw new Error("Publication source SHA must be a 40-character Git commit SHA.");
  }
  if (ref === "main") {
    const branch = await githubRequest(
      `/repos/${repository}/branches/main`,
      token,
      fetchImplementation,
    );
    if (branch.commit?.sha !== sourceSha) {
      throw new Error(`Refusing to update main package pointer from stale build ${sourceSha}.`);
    }
    return;
  }
  if (!PULL_REQUEST_PATTERN.test(ref ?? "")) {
    throw new Error("Package ref must be main or a positive pull request number.");
  }

  const pull = await githubRequest(`/repos/${repository}/pulls/${ref}`, token, fetchImplementation);
  if (pull.state !== "open" || pull.head?.sha !== sourceSha) {
    throw new Error(`Refusing to update PR #${ref} package pointer from stale build ${sourceSha}.`);
  }
}

async function githubRequest(pathname, token, fetchImplementation) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (typeof token === "string" && token.length > 0) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImplementation(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while revalidating package publication.`);
  }
  return response.json();
}
