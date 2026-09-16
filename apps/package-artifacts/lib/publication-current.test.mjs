import { describe, expect, test, vi } from "vitest";

import { assertCurrentPublicationTarget } from "./publication-current.mjs";

const sha = "a".repeat(40);
const input = { repository: "vercel/eve", ref: "123", sourceSha: sha, token: "token" };

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("current package publication target", () => {
  test("accepts the current main build", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(response({ commit: { sha } }));
    await expect(
      assertCurrentPublicationTarget({ ...input, ref: "main" }, fetchImplementation),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/repos/vercel/eve/branches/main",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  test("rejects a stale main build", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(response({ commit: { sha: "b".repeat(40) } }));
    await expect(
      assertCurrentPublicationTarget({ ...input, ref: "main" }, fetchImplementation),
    ).rejects.toThrow("stale build");
  });

  test("accepts the current open stacked pull request build without a GitHub token", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(response({ state: "open", base: { ref: "stack-base" }, head: { sha } }));
    await expect(
      assertCurrentPublicationTarget({ ...input, token: undefined }, fetchImplementation),
    ).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/repos/vercel/eve/pulls/123",
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  test("rejects stale and closed pull requests", async () => {
    const invalidPulls = [
      { state: "open", base: { ref: "main" }, head: { sha: "b".repeat(40) } },
      { state: "closed", base: { ref: "main" }, head: { sha } },
    ];
    for (const pull of invalidPulls) {
      const fetchImplementation = vi.fn().mockResolvedValue(response(pull));
      await expect(assertCurrentPublicationTarget(input, fetchImplementation)).rejects.toThrow(
        "stale build",
      );
    }
  });

  test("rejects invalid configuration and GitHub failures", async () => {
    await expect(
      assertCurrentPublicationTarget({ ...input, repository: "eve" }, vi.fn()),
    ).rejects.toThrow("GITHUB_REPOSITORY");
    await expect(
      assertCurrentPublicationTarget(input, vi.fn().mockResolvedValue(response({}, 503))),
    ).rejects.toThrow("GitHub returned 503");
  });
});
