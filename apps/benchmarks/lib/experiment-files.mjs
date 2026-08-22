import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fixtureNames(evalsRoot) {
  return readdirSync(evalsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(evalsRoot, entry.name, "CASE.ts")))
    .map((entry) => entry.name)
    .sort();
}

export function prepareFixtures(evalsRoot, names = fixtureNames(evalsRoot)) {
  for (const name of names) {
    const fixtureRoot = join(evalsRoot, name);
    writeFileSync(join(fixtureRoot, "PROMPT.md"), "");
    writeFileSync(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ name: `eve-authoring-${name}`, private: true, type: "module" }, null, 2)}\n`,
    );
  }
}

export function resetExperiments(experimentsRoot) {
  rmSync(experimentsRoot, { recursive: true, force: true });
  mkdirSync(experimentsRoot, { recursive: true });
}

export function writeSubjectArchives(experimentsRoot, subject, name) {
  const archiveName = `${name}.source.tar.gz`;
  const dependencyArchiveName = `${name}.dependencies.tar.gz`;
  writeFileSync(join(experimentsRoot, archiveName), subject.archive);
  writeFileSync(join(experimentsRoot, dependencyArchiveName), subject.dependencyArchive);
  return { archiveName, dependencyArchiveName };
}

export function writeExperiment(experimentsRoot, name, options) {
  writeFileSync(
    join(experimentsRoot, `${name}.ts`),
    `import { readFileSync } from "node:fs";\n` +
      `import { authoringExperiment } from "../lib/experiment.js";\n\n` +
      `export default authoringExperiment({\n` +
      `  archive: readFileSync(new URL(${JSON.stringify(`./${options.archiveName}`)}, import.meta.url)),\n` +
      `  dependencyArchive: readFileSync(new URL(${JSON.stringify(`./${options.dependencyArchiveName}`)}, import.meta.url)),\n` +
      `  digest: ${JSON.stringify(options.digest)},\n` +
      `  dependencyDigest: ${JSON.stringify(options.dependencyDigest)},\n` +
      `  runs: ${options.runs},\n` +
      (options.evals === undefined ? "" : `  evals: ${JSON.stringify(options.evals)},\n`) +
      `  benchmark: ${JSON.stringify(options.benchmark)},\n` +
      `  treatment: ${JSON.stringify(options.treatment)},\n` +
      (options.verbose === undefined ? "" : `  verbose: ${options.verbose},\n`) +
      `});\n`,
  );
}
