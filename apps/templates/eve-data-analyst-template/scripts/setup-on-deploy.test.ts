import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* Runs the deploy step as `vercel-build` does, with only the given variables so local settings can't leak in. */
const runSetup = (env: Record<string, string>) => {
  const result = spawnSync(process.execPath, ["scripts/setup-on-deploy.ts"], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 20_000,
  });
  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
};

describe("setup-on-deploy", { timeout: 30_000 }, () => {
  it("exits successfully when the client can't be created", () => {
    const { output, status } = runSetup({
      DATABASE_URL:
        "postgres://u:p@127.0.0.1:1/db?sslrootcert=/nonexistent/ca.pem",
    });
    expect(output).toContain("Setup didn't finish");
    expect(status).toBe(0);
  });

  it("exits successfully when Postgres refuses the connection", () => {
    const { output, status } = runSetup({
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    });
    expect(output).toContain("Setup didn't finish");
    expect(status).toBe(0);
  });

  it("skips a DATABASE_URL without a password", () => {
    const { output, status } = runSetup({
      DATABASE_URL: "postgres://u@127.0.0.1:1/db",
    });
    expect(output).toContain("Skipped");
    expect(output).toContain("password");
    expect(status).toBe(0);
  });

  it("skips a DATABASE_URL that isn't a URL", () => {
    const { output, status } = runSetup({ DATABASE_URL: "not a url" });
    expect(output).toContain("Skipped");
    expect(status).toBe(0);
  });

  it("skips when ANALYST_DATABASE_URL is set", () => {
    const { output, status } = runSetup({
      ANALYST_DATABASE_URL: "postgres://eve_analyst:x@127.0.0.1:1/db",
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    });
    expect(output).toContain("Skipped");
    expect(status).toBe(0);
  });
});
