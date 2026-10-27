import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("npm and pnpm pack only the current release without changing the repository changelog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-changelog-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = resolve("scripts/write-package-changelog.mjs");
  const manifest = {
    name: "eve",
    version: "1.2.3",
    repository: {
      type: "git",
      url: "git+https://github.com/vercel/eve.git",
      directory: "packages/eve",
    },
    files: ["dist"],
    scripts: { prepack: `node "${script}" .` },
  };
  const source =
    "# eve\n\n## 1.2.4\n\n- Future change.\n\n## 1.2.3\n\n### Release eve@1.2.3 | 2026-10-27 | patch\n\n### 🚀 Features\n\n- Current change.\n\n```md\n## 9.9.9\n### 🚀 Features\n```\n\nText after the code block.\n\n## 1.2.2\n\n- Older change.\n";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "CHANGELOG.md"), source);
  const pnpmTarball = join(root, "pnpm.tgz");
  execFileSync("pnpm", ["pack", "--out", pnpmTarball], { cwd: root, stdio: "pipe" });
  const npmOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: root,
    encoding: "utf8",
  });
  const npmTarball = join(root, JSON.parse(npmOutput)[0].filename);
  for (const tarball of [pnpmTarball, npmTarball]) {
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    assert.match(files, /package\/dist\/CHANGELOG\.md/u);
    assert.doesNotMatch(files, /^package\/CHANGELOG\.md$/mu);
    const changelog = execFileSync("tar", ["-xOf", tarball, "package/dist/CHANGELOG.md"], {
      encoding: "utf8",
    });
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
      /\[full changelog through this version\]\(https:\/\/raw\.githubusercontent\.com\/vercel\/eve\/refs\/tags\/eve%401\.2\.3\/packages\/eve\/CHANGELOG\.md\)/u,
    );
  }
  assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), source);
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
  const preview = execFileSync("tar", ["-xOf", pnpmTarball, "package/dist/CHANGELOG.md"], {
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
  const releasePreview = execFileSync("tar", ["-xOf", pnpmTarball, "package/dist/CHANGELOG.md"], {
    encoding: "utf8",
  });
  assert.match(releasePreview, /^# Release eve@1\.2\.4$/mu);
  assert.match(releasePreview, new RegExp(`/${sourceSha}/packages/eve/CHANGELOG\\.md`, "u"));
  execFileSync("pnpm", ["pack", "--out", pnpmTarball], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, VERCEL_GIT_COMMIT_SHA: "" },
  });
  const localPreview = execFileSync("tar", ["-xOf", pnpmTarball, "package/dist/CHANGELOG.md"], {
    encoding: "utf8",
  });
  assert.match(localPreview, /\/abcdef0123456789\/packages\/eve\/CHANGELOG\.md/u);
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
