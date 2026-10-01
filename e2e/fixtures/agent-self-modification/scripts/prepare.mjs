import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(fixtureRoot, "../../..");
const targetDirectory = "agent/extensions/self-modification";

/** Materialize the checkout's registry scaffold without network access or installer setup. */
export async function prepareSelfModification(options = {}) {
  const fixture = options.fixtureRoot ?? fixtureRoot;
  const docs = resolve(options.repoRoot ?? repoRoot, "apps/docs");
  const registry = JSON.parse(await readFile(resolve(docs, "registry.json"), "utf8"));
  const item = registry.items.find((item) => item.name === "eve/self-modification");
  if (!item?.files?.length)
    throw new Error("eve/self-modification has no registry scaffold files.");

  const destination = resolve(fixture, targetDirectory);
  const files = await Promise.all(
    item.files.map(async (file) => {
      const source = resolve(docs, file.path);
      const target = resolve(fixture, file.target);
      requireDescendant(resolve(docs, "registry"), source);
      requireDescendant(destination, target);
      return { target, contents: await readFile(source) };
    }),
  );

  // Only this generated subtree is disposable; leave the fixture's authored tools intact.
  await rm(destination, { recursive: true, force: true });
  for (const { target, contents } of files) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const model =
    process.env.EVE_EVAL_EXPERIMENT === "1"
      ? process.env.EVE_EXPERIMENT_SELF_MODIFICATION_MODEL
      : undefined;
  const reasoning = process.env.EVE_EXPERIMENT_SELF_MODIFICATION_REASONING;
  if (process.env.EVE_EVAL_EXPERIMENT === "1" && (model || reasoning)) {
    const extension = resolve(fixture, "agent/extensions/self-modification/extension.ts");
    await mkdir(dirname(extension), { recursive: true });
    await writeFile(
      extension,
      [
        'import selfModification from "eve/self-modification";',
        "",
        "export default selfModification({",
        ...(model ? [`  model: ${JSON.stringify(model)},`] : []),
        ...(reasoning ? [`  reasoning: ${JSON.stringify(reasoning)},`] : []),
        "});",
        "",
      ].join("\n"),
    );
  }
}

function requireDescendant(root, path) {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Registry scaffold path is outside ${root}: ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareSelfModification();
}
