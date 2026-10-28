import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveCatalogReferences } from "./package-catalog.mjs";
import { runPack } from "./package-publish-report.mjs";

test("npm and pnpm pack only the current release without changing the repository changelog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-changelog-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = resolve("scripts/stage-package.mjs");
  const manifest = {
    name: "eve",
    version: "1.2.3",
    packageManager: "pnpm@12.14.0",
    repository: {
      type: "git",
      url: "git+https://github.com/vercel/eve.git",
      directory: "packages/eve",
    },
    files: ["dist", "!dist/CHANGELOG.md"],
    publishConfig: { directory: ".package" },
    peerDependencies: { example: "catalog:" },
    peerDependenciesMeta: { example: { optional: true } },
    devDependencies: { other: "catalog:stable", local: "workspace:*" },
    scripts: { prepack: `node "${script}" .` },
  };
  const source =
    "# eve\n\n## 1.2.4\n\n- Future change.\n\n## 1.2.3\n\n### Release eve@1.2.3 | 2026-10-27 | patch\n\n### 🚀 Features\n\n- Current change.\n\n```md\n## 9.9.9\n### 🚀 Features\n```\n\nText after the code block.\n\n## 1.2.2\n\n- Older change.\n";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    'verifyDepsBeforeRun: false\npackages:\n  - packages/*\ncatalog:\n  example: "1.2.3"\ncatalogs:\n  stable:\n    other: "2.3.4"\n',
  );
  await mkdir(join(root, "packages/local"), { recursive: true });
  await writeFile(
    join(root, "packages/local/package.json"),
    JSON.stringify({ name: "local", version: "3.4.5" }),
  );
  await writeFile(join(root, "CHANGELOG.md"), source);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/CHANGELOG.md"), "Stale notes.\n");
  const pnpmTarball = join(root, "pnpm.tgz");
  execFileSync("pnpm", ["pack", "--out", pnpmTarball], { cwd: root, stdio: "pipe" });
  assert.throws(
    () =>
      execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
        cwd: root,
        stdio: "pipe",
      }),
    (error) => {
      assert.match(`${error.stdout}\n${error.stderr}`, /Run pnpm pack/u);
      return true;
    },
  );
  const sourcePack = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { cwd: root, encoding: "utf8" },
  );
  const sourceFiles = execFileSync(
    "tar",
    ["-tzf", join(root, JSON.parse(sourcePack)[0].filename)],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(sourceFiles, /CHANGELOG\.md/u);
  const npmOutput = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    {
      cwd: join(root, ".package"),
      encoding: "utf8",
    },
  );
  const npmTarball = join(root, "npm-direct.tgz");
  await copyFile(join(root, JSON.parse(npmOutput)[0].filename), npmTarball);
  const reportPack = await runPack(root, root);
  const reportTarball = join(root, reportPack.filename);
  assert.equal(reportPack.size, (await stat(pnpmTarball)).size);
  assert.equal(reportPack.size, (await stat(reportTarball)).size);
  const consumer = join(root, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      npmTarball,
    ],
    {
      cwd: consumer,
      stdio: "pipe",
    },
  );
  for (const tarball of [pnpmTarball, npmTarball, reportTarball]) {
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    assert.match(files, /^package\/CHANGELOG\.md$/mu);
    assert.doesNotMatch(files, /package\/dist\/CHANGELOG\.md/u);
    assert.doesNotMatch(files, /eve-changelog-backup/u);
    const changelog = execFileSync("tar", ["-xOf", tarball, "package/CHANGELOG.md"], {
      encoding: "utf8",
    });
    const packedManifest = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    assert.equal(packedManifest.peerDependencies.example, "1.2.3");
    assert.equal(packedManifest.devDependencies.other, "2.3.4");
    if (tarball !== npmTarball) assert.equal(packedManifest.devDependencies.local, "3.4.5");
    assert.match(
      changelog,
      /^# Release eve@1\.2\.3 \| 2026-10-27 \| patch\n\n## 🚀 Features\n\n- Current change\./u,
    );
    assert.doesNotMatch(changelog, /^# eve$|^## 1\.2\.3$/mu);
    assert.match(changelog, /```md\n## 9\.9\.9\n### 🚀 Features\n```/u);
    assert.match(changelog, /Text after the code block\./u);
    assert.doesNotMatch(changelog, /Older change/u);
    assert.doesNotMatch(changelog, /Future change/u);
    assert.match(
      changelog,
      /For an upgrade across multiple releases, review each version between the installed and target versions in the \[target version's changelog\]\(https:\/\/raw\.githubusercontent\.com\/vercel\/eve\/refs\/tags\/eve%401\.2\.3\/packages\/eve\/CHANGELOG\.md\)\./u,
    );
  }
  assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), source);
  execFileSync("pnpm", ["pack", "--config.ignore-scripts=true", "--out", pnpmTarball], {
    cwd: root,
    stdio: "pipe",
  });
  const scriptsDisabled = execFileSync("tar", ["-xOf", pnpmTarball, "package/CHANGELOG.md"], {
    encoding: "utf8",
  });
  assert.match(scriptsDisabled, /Current change\./u);
  assert.doesNotMatch(scriptsDisabled, /Older change/u);
  const sourceSha = "abcdef0123456789abcdef0123456789abcdef01";
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ ...manifest, version: "1.2.3+git.abcdef0123456789" }),
  );
  execFileSync("pnpm", ["pack", "--out", pnpmTarball], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, VERCEL_GIT_COMMIT_SHA: sourceSha },
  });
  const preview = execFileSync("tar", ["-xOf", pnpmTarball, "package/CHANGELOG.md"], {
    encoding: "utf8",
  });
  assert.match(preview, /development build/u);
  assert.match(preview, /^# Release eve@1\.2\.3 \| 2026-10-27 \| patch/mu);
  assert.match(preview, /refs\/tags\/eve%401\.2\.3\/packages\/eve\/CHANGELOG\.md/u);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ ...manifest, version: "1.2.4+git.abcdef0123456789" }),
  );
  execFileSync("pnpm", ["pack", "--out", pnpmTarball], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, VERCEL_GIT_COMMIT_SHA: sourceSha },
  });
  const releasePreview = execFileSync("tar", ["-xOf", pnpmTarball, "package/CHANGELOG.md"], {
    encoding: "utf8",
  });
  assert.match(releasePreview, /^# Release eve@1\.2\.4$/mu);
  assert.match(releasePreview, new RegExp(`/${sourceSha}/packages/eve/CHANGELOG\\.md`, "u"));
  execFileSync("pnpm", ["pack", "--out", pnpmTarball], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, VERCEL_GIT_COMMIT_SHA: "" },
  });
  const localPreview = execFileSync("tar", ["-xOf", pnpmTarball, "package/CHANGELOG.md"], {
    encoding: "utf8",
  });
  assert.match(localPreview, /\/abcdef0123456789\/packages\/eve\/CHANGELOG\.md/u);
});

test("catalog default aliases resolve from either workspace form", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-default-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const config of [
    'catalog:\n  example: "1.2.3"\n',
    'catalogs:\n  default:\n    example: "1.2.3"\n',
  ]) {
    await writeFile(join(root, "pnpm-workspace.yaml"), config);
    for (const range of ["catalog:", "catalog:default"]) {
      const { manifest } = await resolveCatalogReferences(root, {
        dependencies: { example: range },
      });
      assert.equal(manifest.dependencies.example, "1.2.3");
    }
  }
});

test("packing fails when the package version has no release notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-changelog-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@vercel/agent-runs",
      version: "1.0.0",
      repository: { directory: "packages/tracing" },
    }),
  );
  await writeFile(join(root, "CHANGELOG.md"), "# tracing\n\n## 0.9.0\n\nOld notes.\n");
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/write-package-changelog.mjs", root], {
        stdio: "pipe",
      }),
    (error) => {
      assert.match(error.stderr.toString(), /No changelog entry for @vercel\/agent-runs@1\.0\.0/u);
      return true;
    },
  );
  await writeFile(
    join(root, "CHANGELOG.md"),
    "# tracing\n\n## 1.0.0\n\nCurrent notes.\n\n## 0.9.0\n\nOld notes.\n",
  );
  execFileSync(process.execPath, ["scripts/write-package-changelog.mjs", root], { stdio: "pipe" });
  const changelog = await readFile(join(root, "dist/CHANGELOG.md"), "utf8");
  assert.match(changelog, /^# Release @vercel\/agent-runs@1\.0\.0$/mu);
  assert.match(
    changelog,
    /https:\/\/raw\.githubusercontent\.com\/vercel\/eve\/refs\/tags\/%40vercel%2Fagent-runs%401\.0\.0\/packages\/tracing\/CHANGELOG\.md/u,
  );
  assert.match(changelog, /Current notes\./u);
  assert.doesNotMatch(changelog, /Old notes\./u);
});

test("a failed pack leaves the repository changelog intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-changelog-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = "# eve\n\n## 1.0.0\n\nCurrent notes.\n\n## 0.9.0\n\nOlder notes.\n";
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "eve",
      version: "1.0.0",
      repository: { directory: "packages/eve" },
      files: ["dist"],
      publishConfig: { directory: ".package" },
      scripts: { prepack: `node "${resolve("scripts/stage-package.mjs")}" .` },
    }),
  );
  await writeFile(join(root, "CHANGELOG.md"), source);
  assert.throws(() =>
    execFileSync("pnpm", ["pack", "--out", join(root, "CHANGELOG.md", "package.tgz")], {
      cwd: root,
      stdio: "pipe",
    }),
  );
  assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), source);
});
