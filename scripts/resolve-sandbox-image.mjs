/**
 * Resolves eve's sandbox image for a CI run the way
 * .github/actions/sandbox-image does on GitHub Actions, step for step: fail on
 * a stale pin, use the pinned image when GHCR has it, fall back to :latest when
 * GHCR reports it missing, and fail on any other inspect error. A change that
 * edits packages/eve/Dockerfile pins a tag the release workflow publishes only
 * after merge, which is when the fallback applies. The fallback sets
 * EVE_SANDBOX_IMAGE_TAG=latest in process.env, so child processes inherit it.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const tagScript = join(import.meta.dirname, "sandbox-image-tag.mjs");

export function resolveSandboxImage() {
  execFileSync(process.execPath, [tagScript, "--check"], { stdio: "inherit" });
  const tag = execFileSync(process.execPath, [tagScript], { encoding: "utf8" }).trim();
  const image = `ghcr.io/vercel/eve:${tag}`;
  try {
    execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", image], { stdio: "pipe" });
    process.stdout.write(`Using pinned sandbox image ${image}\n`);
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}` || error.message;
    if (!/: not found|manifest unknown/u.test(output)) throw new Error(output);
    process.stdout.write(
      `Unpublished sandbox image: ${image} is not published. This happens when this change edits packages/eve/Dockerfile, because the release workflow publishes the image after the change reaches main. If main already has this Dockerfile, check the latest Release workflow run on main for a failed image publish. This run uses ghcr.io/vercel/eve:latest, so it does not test the pinned image.\n`,
    );
    process.env.EVE_SANDBOX_IMAGE_TAG = "latest";
  }
}
