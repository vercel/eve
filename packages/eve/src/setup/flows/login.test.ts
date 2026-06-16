import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Prompter } from "#setup/prompter.js";
import type { VercelAuthStatus } from "#setup/vercel-project.js";

import { runLoginFlow, type LoginFlowDeps } from "./login.js";

const APP_ROOT = "/app/my-agent";

/** Auth probe that returns the given sequence of results across successive calls. */
function authProbe(...results: VercelAuthStatus[]): LoginFlowDeps["getVercelAuthStatus"] {
  let call = 0;
  return vi.fn(async () => results[Math.min(call++, results.length - 1)] ?? "logged-out");
}

function run(deps: Partial<LoginFlowDeps>, runVercelLogin?: LoginFlowDeps["runVercelLogin"]) {
  const { prompter } = createFakePrompter({});
  const merged: Partial<LoginFlowDeps> = { ...deps };
  if (runVercelLogin !== undefined) merged.runVercelLogin = runVercelLogin;
  // No `awaitChoice` on the fake prompter → the headless branch runs the login
  // subprocess to completion behind a spinner.
  return runLoginFlow({ appRoot: APP_ROOT, prompter, deps: merged });
}

describe("runLoginFlow", () => {
  it("short-circuits when already logged in and never runs vercel login", async () => {
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(async () => true);
    await expect(
      run({ getVercelAuthStatus: authProbe("authenticated") }, runVercelLogin),
    ).resolves.toEqual({ kind: "already" });
    expect(runVercelLogin).not.toHaveBeenCalled();
  });

  it("runs vercel login and confirms with a re-probe on success", async () => {
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(async () => true);
    // First probe: logged out; second probe (after login): logged in.
    await expect(
      run({ getVercelAuthStatus: authProbe("logged-out", "authenticated") }, runVercelLogin),
    ).resolves.toEqual({ kind: "logged-in" });
    expect(runVercelLogin).toHaveBeenCalledWith(expect.objectContaining({ cwd: APP_ROOT }));
  });

  it("reports failed when vercel login exits non-zero", async () => {
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(async () => false);
    await expect(
      run({ getVercelAuthStatus: authProbe("logged-out") }, runVercelLogin),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("reports failed when login exits clean but the re-probe is still logged out", async () => {
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(async () => true);
    await expect(
      run({ getVercelAuthStatus: authProbe("logged-out", "logged-out") }, runVercelLogin),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("reports a missing CLI without starting vercel login", async () => {
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(async () => true);
    await expect(
      run({ getVercelAuthStatus: authProbe("cli-missing") }, runVercelLogin),
    ).resolves.toEqual({ kind: "cli-missing" });
    expect(runVercelLogin).not.toHaveBeenCalled();
  });

  it("reports an unavailable Vercel API without starting vercel login", async () => {
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(async () => true);
    await expect(
      run({ getVercelAuthStatus: authProbe("unavailable") }, runVercelLogin),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(runVercelLogin).not.toHaveBeenCalled();
  });

  it("cancels and aborts the subprocess when the user stops waiting", async () => {
    const { prompter: base } = createFakePrompter({});
    // An interactive prompter whose Cancel resolves immediately, so the choice
    // wins the race against the still-running login subprocess.
    const prompter: Prompter = {
      ...base,
      awaitChoice: () => ({ choice: Promise.resolve("cancel"), close: () => {} }),
    };
    // The login subprocess hangs until its signal aborts (the browser wait).
    const runVercelLogin = vi.fn<LoginFlowDeps["runVercelLogin"]>(
      ({ signal }) =>
        new Promise<boolean>((resolve) => {
          if (signal?.aborted === true) return resolve(false);
          signal?.addEventListener("abort", () => resolve(false));
        }),
    );
    await expect(
      runLoginFlow({
        appRoot: APP_ROOT,
        prompter,
        deps: { getVercelAuthStatus: authProbe("logged-out"), runVercelLogin },
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(runVercelLogin).toHaveBeenCalledOnce();
    // The subprocess was handed an abort signal that fired on Cancel.
    expect(runVercelLogin.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});
