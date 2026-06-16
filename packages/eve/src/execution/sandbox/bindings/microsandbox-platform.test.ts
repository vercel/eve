import { describe, expect, it } from "vitest";

import { ensureMicrosandboxBaseRuntime } from "#execution/sandbox/bindings/microsandbox-platform.js";

describe.skipIf(process.platform === "win32")("ensureMicrosandboxBaseRuntime", () => {
  it("streams base runtime setup step logs", async () => {
    const logs: string[] = [];
    const builderState = {
      args: [] as string[],
      cwd: "",
      user: "",
    };
    const builder = {
      args(args: string[]) {
        builderState.args = args;
        return builder;
      },
      cwd(cwd: string) {
        builderState.cwd = cwd;
        return builder;
      },
      user(user: string) {
        builderState.user = user;
        return builder;
      },
    };
    const sandbox = {
      async execStreamWith(command: string, configure: (input: typeof builder) => unknown) {
        expect(command).toBe("bash");
        configure(builder);
        return createExecHandle([
          { data: Buffer.from("eve-base-runtime: checking bash\n"), kind: "stderr" },
          { data: Buffer.from("framework setup output ignored\n"), kind: "stdout" },
          {
            data: Buffer.from("eve-base-runtime: prepare workspace directory: /workspace"),
            kind: "stderr",
          },
          { data: Buffer.from("\n"), kind: "stderr" },
          { code: 0, kind: "exited" },
        ]);
      },
    };

    await ensureMicrosandboxBaseRuntime(sandbox as never, {
      log: (message) => logs.push(message),
    });

    expect(builderState.args[0]).toBe("-lc");
    expect(builderState.args[1]).toContain("checking bash");
    expect(builderState.args[1]).not.toContain("apt-get");
    expect(builderState.args[1]).not.toContain("dnf");
    expect(builderState.args[1]).not.toContain("apk");
    expect(builderState.args[1]).not.toContain("node_24");
    expect(builderState.args[1]).not.toContain("npm install");
    expect(builderState.cwd).toBe("/");
    expect(builderState.user).toBe("root");
    expect(logs).toEqual(["checking bash", "prepare workspace directory: /workspace"]);
  });
});

function createExecHandle(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}
