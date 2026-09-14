import { afterEach, describe, expect, test, vi } from "vitest";

import {
  runNonInteractiveLink,
  type NonInteractiveLinkDependencies,
} from "./vercel-non-interactive.js";

class TestLogger {
  readonly errors: string[] = [];
  readonly logs: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

function dependencies(): NonInteractiveLinkDependencies {
  return {
    isEveProject: vi.fn(async () => true),
    runVercel: vi.fn(async () => true),
    runVercelEnvPull: vi.fn(async () => true),
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runNonInteractiveLink", () => {
  test("requires the project Vercel requires for a non-interactive link", async () => {
    const logger = new TestLogger();
    const deps = dependencies();

    await runNonInteractiveLink({
      logger,
      appRoot: "/agent",
      options: { nonInteractive: true },
      dependencies: deps,
    });

    expect(logger.errors).toEqual([
      "`eve link --non-interactive` requires `--project <name-or-id>`.",
    ]);
    expect(deps.runVercel).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("links the selected project and pulls its environment without stdin", async () => {
    const logger = new TestLogger();
    const deps = dependencies();

    await runNonInteractiveLink({
      logger,
      appRoot: "/agent",
      options: { nonInteractive: true, project: "wayfinder", team: "acme" },
      dependencies: deps,
    });

    expect(deps.runVercel).toHaveBeenCalledWith(
      ["link", "--project", "wayfinder", "--team", "acme", "--yes"],
      { cwd: "/agent", nonInteractive: true },
    );
    expect(deps.runVercelEnvPull).toHaveBeenCalledWith("/agent", undefined, undefined, true);
    expect(logger.logs).toEqual(["Project linked."]);
  });
});
