import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Drive,
  vercel,
  type VercelSandboxOptions,
  type VercelSandboxSessionCreateOptions,
} from "#public/sandbox/vercel.js";

describe("vercel", () => {
  it("exposes Drive and accepts session-scoped mounts", () => {
    const options = {
      sessionCreateOptions: ({ session }) => ({
        mounts: {
          "/workspace": { drive: `repo-${session.id}`, mode: "read-write" },
        },
      }),
    } satisfies VercelSandboxOptions;

    expect(vercel(options).name).toBe("vercel");
    expectTypeOf(Drive.getOrCreate).toBeFunction();
    expectTypeOf(
      options.sessionCreateOptions({ session: { id: "acme" } }),
    ).toMatchTypeOf<VercelSandboxSessionCreateOptions>();
    expectTypeOf<VercelSandboxOptions>().not.toHaveProperty("mounts");
  });
});
