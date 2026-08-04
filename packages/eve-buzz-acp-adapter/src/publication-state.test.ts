import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicationKey, reservePublication } from "./publication-state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "eve-buzz-publications-"));
  directories.push(value);
  return value;
}

describe("publication state", () => {
  it("uses the selected channel and triggering event as its idempotency key", () => {
    expect(
      publicationKey({
        channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
        replyTo: "a".repeat(64),
      }),
    ).not.toBe(
      publicationKey({
        channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
        replyTo: "b".repeat(64),
      }),
    );
    expect(() => publicationKey({ channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262" })).toThrow(
      "require an event anchor",
    );
  });

  it("permits exactly one successful publication for a triggering event", async () => {
    const reservation = await reservePublication({
      directory: await directory(),
      key: "event",
      staleAfterMs: 1_000,
    });
    expect(reservation).not.toBe("published");
    expect(reservation).not.toBe("unknown");
    if (typeof reservation === "string") return;

    await expect(
      reservePublication({ directory: directories[0]!, key: "event", staleAfterMs: 1_000 }),
    ).rejects.toThrow("already being published");
    await reservation.commit();
    await expect(
      reservePublication({ directory: directories[0]!, key: "event", staleAfterMs: 1_000 }),
    ).resolves.toBe("published");
  });

  it("blocks retries whose delivery status is unknown", async () => {
    const stateDirectory = await directory();
    const reservation = await reservePublication({
      directory: stateDirectory,
      key: "event",
      staleAfterMs: 1_000,
    });
    expect(reservation).not.toBe("published");
    expect(reservation).not.toBe("unknown");
    if (typeof reservation === "string") return;

    await reservation.markUnknown();
    await expect(
      reservePublication({ directory: stateDirectory, key: "event", staleAfterMs: -1 }),
    ).resolves.toBe("unknown");
  });

  it("releases a failed publication for a later retry", async () => {
    const stateDirectory = await directory();
    const reservation = await reservePublication({
      directory: stateDirectory,
      key: "event",
      staleAfterMs: 1_000,
    });
    expect(reservation).not.toBe("published");
    expect(reservation).not.toBe("unknown");
    if (typeof reservation === "string") return;

    await reservation.release();
    await expect(
      reservePublication({ directory: stateDirectory, key: "event", staleAfterMs: 1_000 }),
    ).resolves.not.toBe("published");
  });

  it("reclaims an abandoned reservation after its lease expires", async () => {
    const stateDirectory = await directory();
    const reservation = await reservePublication({
      directory: stateDirectory,
      key: "event",
      staleAfterMs: -1,
    });
    expect(reservation).not.toBe("published");
    const reclaimed = await reservePublication({
      directory: stateDirectory,
      key: "event",
      staleAfterMs: -1,
    });
    expect(reclaimed).not.toBe("published");
  });
});
