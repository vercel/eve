// `eval_digest`: sha256 over the git object ids of everything that defines an
// eval's behavior apart from eve itself — the eval file, its fixture's
// evals.config.ts, agent/ tree, and package.json, and the shared e2e config.
// Reading object ids at the planned commit keeps it cheap, deterministic, and
// independent of the eve version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const SHARED_PATHS = ["e2e/fixtures/e2e-config"];

/**
 * @param {{ sha: string, fixtureDir: string, evalIds: string[], resolve?: (specs: string[]) => Map<string, string> }} input
 * @returns {Map<string, string>} eval id → hex digest
 */
export function evalDigests({ sha, fixtureDir, evalIds, resolve = gitObjectIds }) {
  const fixturePaths = ["evals/evals.config.ts", "agent", "package.json"].map(
    (path) => `${fixtureDir}/${path}`,
  );
  // Array-exported evals append segments to their file's id, so try each
  // shorter prefix until one names a file.
  const candidates = new Map(
    evalIds.map((id) => {
      const segments = id.split("/");
      return [
        id,
        segments.map(
          (_, index) =>
            `${fixtureDir}/evals/${segments.slice(0, segments.length - index).join("/")}.eval.ts`,
        ),
      ];
    }),
  );
  const specs = [
    ...new Set([...SHARED_PATHS, ...fixturePaths, ...[...candidates.values()].flat()]),
  ].map((path) => `${sha}:${path}`);
  const ids = resolve(specs);
  const objectId = (path) => ids.get(`${sha}:${path}`) ?? "missing";

  const digests = new Map();
  for (const [id, paths] of candidates) {
    const evalFile = paths.find((path) => ids.has(`${sha}:${path}`));
    const hash = createHash("sha256");
    for (const path of [
      evalFile ?? `${fixtureDir}/evals/${id}.eval.ts`,
      ...fixturePaths,
      ...SHARED_PATHS,
    ])
      hash.update(`${path}\0${objectId(path)}\n`);
    digests.set(id, hash.digest("hex"));
  }
  return digests;
}

/** Resolve `<rev>:<path>` specs to object ids in one git process; missing paths are omitted. */
export function gitObjectIds(specs) {
  const output = execFileSync("git", ["cat-file", "--batch-check=%(objectname)"], {
    input: `${specs.join("\n")}\n`,
    encoding: "utf8",
  });
  const ids = new Map();
  output
    .trimEnd()
    .split("\n")
    .forEach((line, index) => {
      if (!line.endsWith(" missing")) ids.set(specs[index], line.trim());
    });
  return ids;
}
