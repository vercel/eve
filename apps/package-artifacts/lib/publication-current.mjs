import { githubRequest } from "./github-request.mjs";
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
  const request = { token, action: "revalidating package publication" };
  if (ref === "main") {
    const branch = await githubRequest(
      `/repos/${repository}/branches/main`,
      request,
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

  const pull = await githubRequest(
    `/repos/${repository}/pulls/${ref}`,
    request,
    fetchImplementation,
  );
  if (pull.state !== "open" || pull.head?.sha !== sourceSha) {
    throw new Error(`Refusing to update PR #${ref} package pointer from stale build ${sourceSha}.`);
  }
}
