import { describe, expect, it } from "vitest";

import { runMigrationChain, type VersionMigration } from "./chain.js";

/**
 * Exercises the chain runner with synthetic versioned shapes. The
 * snapshot-specific wiring is covered in `snapshot.test.ts`.
 */
describe("runMigrationChain", () => {
  it("returns value unchanged when already at the target version", () => {
    const value = { id: "abc", version: 1 as const };

    const result = runMigrationChain<{ readonly version: 1; readonly id: string }>({
      label: "test shape",
      migrations: [],
      targetVersion: 1,
      value,
    });

    expect(result).toBe(value);
  });

  it("walks a value through every registered migration in order", () => {
    interface V1 {
      readonly version: 1;
      readonly name: string;
    }
    interface V2 {
      readonly version: 2;
      readonly name: string;
      readonly count: number;
    }
    interface V3 {
      readonly version: 3;
      readonly id: string;
      readonly count: number;
    }

    const migrations: VersionMigration[] = [
      {
        from: 1,
        migrate: (prior) => {
          const v1 = prior as V1;
          return { count: 0, name: v1.name, version: 2 } satisfies V2;
        },
        to: 2,
      },
      {
        from: 2,
        migrate: (prior) => {
          const v2 = prior as V2;
          return { count: v2.count, id: v2.name, version: 3 } satisfies V3;
        },
        to: 3,
      },
    ];

    const result = runMigrationChain<V3>({
      label: "test shape",
      migrations,
      targetVersion: 3,
      value: { name: "alpha", version: 1 } satisfies V1,
    });

    expect(result).toEqual({ count: 0, id: "alpha", version: 3 });
  });

  it("applies only the migrations between the current and target versions", () => {
    const applied: number[] = [];
    const migrations: VersionMigration[] = [
      {
        from: 1,
        migrate: (v) => {
          applied.push(1);
          return { ...(v as object), version: 2 };
        },
        to: 2,
      },
      {
        from: 2,
        migrate: (v) => {
          applied.push(2);
          return { ...(v as object), version: 3 };
        },
        to: 3,
      },
      {
        from: 3,
        migrate: (v) => {
          applied.push(3);
          return { ...(v as object), version: 4 };
        },
        to: 4,
      },
    ];

    runMigrationChain<{ readonly version: 3 }>({
      label: "test shape",
      migrations,
      targetVersion: 3,
      value: { version: 2 },
    });

    expect(applied).toEqual([2]);
  });

  it("throws when no migration is registered for an intermediate version", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [
          {
            from: 2,
            migrate: (v) => ({ ...(v as object), version: 3 }),
            to: 3,
          },
        ],
        targetVersion: 3,
        value: { version: 1 },
      }),
    ).toThrow(/no migration registered for version 1 → 2/);
  });

  it("throws when a migration produces the wrong target version", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [
          {
            from: 1,
            // Misbehaving migration: declares v2 but produces v3.
            migrate: (v) => ({ ...(v as object), version: 3 }),
            to: 2,
          },
        ],
        targetVersion: 2,
        value: { version: 1 },
      }),
    ).toThrow(/migration 1 → 2 produced a value with version 3/);
  });

  it("throws when a migration declares more than one version step", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [
          {
            from: 1,
            migrate: (v) => ({ ...(v as object), version: 3 }),
            to: 3,
          },
        ],
        targetVersion: 3,
        value: { version: 1 },
      }),
    ).toThrow(/migration 1 → 3 must step exactly one version at a time/);
  });

  it("throws when the value version is newer than the target", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [],
        targetVersion: 1,
        value: { version: 2 },
      }),
    ).toThrow(/version 2, which is newer than the supported version 1/);
  });

  it("throws when the value has no numeric version field", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [],
        targetVersion: 1,
        value: { name: "no version" },
      }),
    ).toThrow(/no numeric "version" field/);
  });

  it("throws when the value version is not a positive integer", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [],
        targetVersion: 1,
        value: { version: 0 },
      }),
    ).toThrow(/version 0 is not a positive integer/);
  });

  it("throws when value is null", () => {
    expect(() =>
      runMigrationChain({
        label: "test shape",
        migrations: [],
        targetVersion: 1,
        value: null,
      }),
    ).toThrow(/no numeric "version" field/);
  });

  it("reads a versionless value as initialVersion when provided", () => {
    const migrations: VersionMigration[] = [
      {
        from: 0,
        migrate: (v) => ({ ...(v as object), version: 1 }),
        to: 1,
      },
    ];

    const result = runMigrationChain<{ readonly version: 1; readonly id: string }>({
      initialVersion: 0,
      label: "test shape",
      migrations,
      targetVersion: 1,
      value: { id: "abc" },
    });

    expect(result).toEqual({ id: "abc", version: 1 });
  });

  it("rejects a present but non-numeric version even when initialVersion is set", () => {
    expect(() =>
      runMigrationChain({
        initialVersion: 0,
        label: "test shape",
        migrations: [],
        targetVersion: 1,
        value: { version: "1" },
      }),
    ).toThrow(/no numeric "version" field/);
  });
});
