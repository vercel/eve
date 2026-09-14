import { execFileSync } from "node:child_process";

const PACKAGE_HOST = "https://pkg.eve.dev";
const IMMUTABLE_PACKAGE_PATH = /^\/([0-9a-f]{40})\/eve\.tgz$/u;

/** Resolves a mutable canary ref to the immutable artifact all runs must share. */
export function canarySubject(ref, label, resolve = resolveCanaryPackageSpec) {
  const packageSpec = resolve(ref);
  const revision = packageRevision(packageSpec);
  return {
    label,
    revision,
    description: revision.slice(0, 12),
    packageSpec,
  };
}

export function resolveCanaryPackageSpec(ref) {
  const requested = `${PACKAGE_HOST}/${encodeURIComponent(ref)}/eve.tgz`;
  let resolved;
  try {
    resolved = execFileSync(
      "curl",
      ["-fsSL", "-o", "/dev/null", "-w", "%{url_effective}", requested],
      {
        encoding: "utf8",
      },
    ).trim();
  } catch {
    throw new Error(
      `No eve canary artifact is available for ${JSON.stringify(ref)}. Publish that revision or use a published canary ref such as "main".`,
    );
  }
  packageRevision(resolved);
  return resolved;
}

export function packageRevision(packageSpec) {
  const url = new URL(packageSpec);
  if (url.origin !== PACKAGE_HOST) {
    throw new Error(`Eve canary resolved outside ${PACKAGE_HOST}: ${packageSpec}`);
  }
  const revision = url.pathname.match(IMMUTABLE_PACKAGE_PATH)?.[1];
  if (revision === undefined) {
    throw new Error(`Eve canary did not resolve to an immutable revision: ${packageSpec}`);
  }
  return revision;
}
