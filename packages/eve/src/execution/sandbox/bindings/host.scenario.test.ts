import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeBashOnSandbox } from "#execution/sandbox/bash.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import { executeWriteFileOnSandbox } from "#execution/sandbox/write-file.js";
import { createSandboxEnvironmentHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { SandboxSessionGoneError } from "#public/sandbox/provider.js";
import { HostSandbox } from "#sandbox/providers/host.js";
import {
  removeSkillPackageFromSandbox,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import { MODEL_HOST_SKILL_ROOT } from "#shared/skill-paths.js";

const createScratchDirectory = useTemporaryDirectories();

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("HostSandbox live host execution", () => {
  it("runs directly in the configured host cwd with direct fs I/O, fast paths, and stdin support", async () => {
    const workdir = await createScratchDirectory("eve-host-cwd-");
    const storagePath = await createScratchDirectory("eve-host-storage-");
    const env = HostSandbox.environment({
      env: { HOST_CUSTOM: "from-env" },
    });
    const harness = createSandboxEnvironmentHarness(env);
    const prepared = await harness.prepare({ appRoot: storagePath, storagePath });
    const { connection, sandbox, state } = await harness.start({
      appRoot: storagePath,
      options: { cwd: workdir, env: { OPEN_CUSTOM: "from-open" } },
      prepared,
      sandboxName: "host-session-1",
    });

    try {
      expect(connection.close).toBeUndefined();
      expect(sandbox.resolvePath(".")).toBe(workdir);
      expect(sandbox.resolvePath("src/app.ts")).toBe(join(workdir, "src/app.ts"));

      await expect(sandbox.readBinaryFile({ path: "missing.txt" })).resolves.toBeNull();
      await expect(sandbox.readBinaryFile({ path: workdir })).rejects.toThrow(/EISDIR/u);

      const writeRes = await executeWriteFileOnSandbox(sandbox, {
        content: "line 1\nline 2\n",
        filePath: "nested/hello.txt",
      });
      expect(writeRes).toEqual({ existed: false, path: join(workdir, "nested/hello.txt") });
      expect(await readFile(join(workdir, "nested/hello.txt"), "utf8")).toBe("line 1\nline 2\n");

      const readRes = await executeReadFileOnSandbox(sandbox, { filePath: "nested/hello.txt" });
      expect(readRes.content).toBe("1: line 1\n2: line 2");

      const runRes = await sandbox.run({
        command: 'printf "%s|%s|%s|%s" "$(pwd)" "$AI_AGENT" "$HOST_CUSTOM" "$OPEN_CUSTOM"',
      });
      expect(runRes.exitCode).toBe(0);
      expect(runRes.stdout).toContain(`|eve|from-env|from-open`);

      const bashRes = await executeBashOnSandbox(sandbox, {
        command: "cat nested/hello.txt",
      });
      expect(bashRes).toEqual({
        exitCode: 0,
        status: "completed",
        stderr: "",
        stdout: "line 1\nline 2\n",
        truncated: false,
      });

      const proc = await sandbox.spawn({ command: "cat", stdin: true });
      const writer = proc.stdin!.getWriter();
      await writer.write(new TextEncoder().encode("via-stdin\n"));
      await writer.close();
      expect((await proc.wait()).exitCode).toBe(0);
      expect((await readAllText(proc.stdout)).trim()).toBe("via-stdin");

      await sandbox.removePath({ path: "nested", recursive: true });
      expect(existsSync(join(workdir, "nested"))).toBe(false);
    } finally {
      await harness.endSession({
        appRoot: storagePath,
        sandboxName: "host-session-1",
        state,
      });
    }

    expect(existsSync(workdir)).toBe(true);
  });

  it("isolates static and dynamic skills in storagePath under EVE_SKILLS_DIR without touching cwd or HOME", async () => {
    const workdir = await createScratchDirectory("eve-host-skills-cwd-");
    const fakeHome = await createScratchDirectory("eve-host-skills-home-");
    const storagePath = await createScratchDirectory("eve-host-skills-storage-");
    const userSkillDir = join(fakeHome, ".agents/skills/dynamic-skill");
    await mkdir(userSkillDir, { recursive: true });
    await writeFile(join(userSkillDir, "SKILL.md"), "user personal skill\n");

    const env = HostSandbox.environment({
      env: { HOME: fakeHome },
    });
    const harness = createSandboxEnvironmentHarness(env);
    const prepared = await harness.prepare({
      appRoot: storagePath,
      skills: [
        { content: "# Investigate\n", relativePath: "investigate/SKILL.md" },
        { content: "printf 'script-ok'\n", relativePath: "investigate/scripts/check.sh" },
      ],
      storagePath,
    });
    const { sandbox, state } = await harness.start({
      appRoot: storagePath,
      options: { cwd: workdir },
      prepared,
      sandboxName: "host-skills-session",
    });

    const skillsDirProbe = await sandbox.run({ command: 'printf "%s" "$EVE_SKILLS_DIR"' });
    expect(skillsDirProbe.exitCode).toBe(0);
    expect(skillsDirProbe.stdout.startsWith(join(storagePath, "host/sessions"))).toBe(true);

    const readSkill = await executeReadFileOnSandbox(sandbox, {
      filePath: `${MODEL_HOST_SKILL_ROOT}/investigate/SKILL.md`,
    });
    expect(readSkill.content).toBe("1: # Investigate");

    const scriptRun = await sandbox.run({
      command: 'sh "$EVE_SKILLS_DIR/investigate/scripts/check.sh"',
    });
    expect(scriptRun.exitCode).toBe(0);
    expect(scriptRun.stdout).toBe("script-ok");

    await writeSkillPackageToSandbox({
      sandbox,
      skill: {
        content: "# Agent Dynamic\n",
        description: "dynamic",
        files: [
          { content: Buffer.from("# Agent Dynamic\n"), relativePath: "SKILL.md" },
          { content: Buffer.from("ref data\n"), relativePath: "refs/info.txt" },
        ],
        name: "dynamic-skill",
      },
    });
    const readDynamic = await executeReadFileOnSandbox(sandbox, {
      filePath: `${MODEL_HOST_SKILL_ROOT}/dynamic-skill/refs/info.txt`,
    });
    expect(readDynamic.content).toBe("1: ref data");

    await removeSkillPackageFromSandbox({ name: "dynamic-skill", sandbox });
    expect(await readFile(join(userSkillDir, "SKILL.md"), "utf8")).toBe("user personal skill\n");
    expect(existsSync(join(fakeHome, ".agents/skills/investigate"))).toBe(false);
    expect(existsSync(join(workdir, "skills"))).toBe(false);

    await harness.endSession({
      appRoot: storagePath,
      sandboxName: "host-skills-session",
      state,
    });
    expect(existsSync(skillsDirProbe.stdout)).toBe(false);
    expect(existsSync(workdir)).toBe(true);
    expect(await readFile(join(userSkillDir, "SKILL.md"), "utf8")).toBe("user personal skill\n");
  });

  it("preserves open() cwd and env across resume() and throws SandboxSessionGoneError if cwd disappears", async () => {
    const workdir = await createScratchDirectory("eve-host-resume-cwd-");
    const storagePath = await createScratchDirectory("eve-host-resume-storage-");
    const env = HostSandbox.environment({ inheritEnv: false });
    const harness = createSandboxEnvironmentHarness(env);
    const prepared = await harness.prepare({ appRoot: storagePath, storagePath });
    const { state } = await harness.start({
      appRoot: storagePath,
      options: { cwd: workdir, env: { PATH: process.env.PATH ?? "/usr/bin", TASK_TAG: "v42" } },
      prepared,
      sandboxName: "host-resume-session",
    });

    const resumed = await harness.openSession({
      appRoot: storagePath,
      existing: state,
      prepared,
      sandboxName: "host-resume-session",
    });
    const result = await resumed.sandbox.run({ command: 'printf "%s" "$TASK_TAG"' });
    expect(result.stdout).toBe("v42");

    await rm(workdir, { force: true, recursive: true });
    await expect(
      harness.openSession({
        appRoot: storagePath,
        existing: state,
        prepared,
        sandboxName: "host-resume-session",
      }),
    ).rejects.toBeInstanceOf(SandboxSessionGoneError);

    await harness.endSession({
      appRoot: storagePath,
      sandboxName: "host-resume-session",
      state,
    });
  });

  it("kills the entire child process group on abort and onSessionEnd without deleting host files", async () => {
    const workdir = await createScratchDirectory("eve-host-proc-cwd-");
    const storagePath = await createScratchDirectory("eve-host-proc-storage-");
    const sentinel = join(workdir, "keep.txt");
    await writeFile(sentinel, "precious\n");

    const env = HostSandbox.environment();
    const harness = createSandboxEnvironmentHarness(env);
    const prepared = await harness.prepare({ appRoot: storagePath, storagePath });
    const { sandbox, state } = await harness.start({
      appRoot: storagePath,
      options: { cwd: workdir },
      prepared,
      sandboxName: "host-proc-session",
    });

    const abortPidFile = join(workdir, "abort-child.pid");
    const controller = new AbortController();
    const aborted = await sandbox.spawn({
      command: `sleep 60 & echo $! > ${JSON.stringify(abortPidFile)}; wait`,
      signal: controller.signal,
    });
    const survivor = await sandbox.spawn({
      command: "sleep 0.2; printf 'alive'",
    });

    await vi.waitFor(() => expect(existsSync(abortPidFile)).toBe(true), { timeout: 5_000 });
    const abortGrandchildPid = Number(readFileSync(abortPidFile, "utf8").trim());
    expect(isProcessAlive(abortGrandchildPid)).toBe(true);

    controller.abort(new Error("stop one"));
    await expect(aborted.wait()).rejects.toThrow("stop one");
    await vi.waitFor(() => expect(isProcessAlive(abortGrandchildPid)).toBe(false), {
      timeout: 5_000,
    });

    expect((await survivor.wait()).exitCode).toBe(0);
    expect(await readAllText(survivor.stdout)).toBe("alive");

    const endPidFile = join(workdir, "end-child.pid");
    const leftover = await sandbox.spawn({
      command: `sleep 60 & echo $! > ${JSON.stringify(endPidFile)}; wait`,
    });
    await vi.waitFor(() => expect(existsSync(endPidFile)).toBe(true), { timeout: 5_000 });
    const endGrandchildPid = Number(readFileSync(endPidFile, "utf8").trim());
    expect(isProcessAlive(endGrandchildPid)).toBe(true);

    await harness.endSession({
      appRoot: storagePath,
      sandboxName: "host-proc-session",
      state,
    });
    expect((await leftover.wait()).exitCode).not.toBe(0);
    await vi.waitFor(() => expect(isProcessAlive(endGrandchildPid)).toBe(false), {
      timeout: 5_000,
    });
    expect(await readFile(sentinel, "utf8")).toBe("precious\n");
  });
});
