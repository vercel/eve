// `fixture_digest`: sha256 over the git tree ids of the fixture directory and
// the shared e2e config at the planned commit. Hashing whole trees cannot miss
// a helper an eval imports, at the cost of per-eval granularity: any edit to a
// fixture breaks comparability for all of its evals. eve itself is excluded,
// since eve's version is what benchmarks compare.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const SHARED_PATHS = ["e2e/fixtures/e2e-config"];

/** @returns {string} hex digest */
export function fixtureDigest(sha, fixtureDir) {
  const hash = createHash("sha256");
  for (const path of [fixtureDir, ...SHARED_PATHS]) {
    const tree = execFileSync("git", ["rev-parse", `${sha}:${path}`], { encoding: "utf8" }).trim();
    hash.update(`${path}\0${tree}\n`);
  }
  return hash.digest("hex");
}
