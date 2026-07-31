import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  defineSandboxTemplate,
  getSandboxTemplateInternal,
  isSandboxTemplate,
  withSandboxTemplateBindings,
} from "#shared/sandbox-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";

describe("defineSandboxTemplate", () => {
  it("keeps provider references internal and supplies the bound build result to create", async () => {
    const sandbox = mockSandbox();
    const create = vi.fn(() => sandbox.session);
    const template = defineSandboxTemplate<{ snapshotId: string }, { resources: number }>({
      type: "test.dev/template-reference/v1",
      async prewarm() {
        return { snapshotId: "snapshot_123" };
      },
      create,
    });

    expect(isSandboxTemplate(template)).toBe(true);
    await expect(template.create({ resources: 2 })).rejects.toThrow(/no prewarmed build result/);

    const internal = getSandboxTemplateInternal(template);

    await expect(
      withTestContext(
        async () =>
          await withSandboxTemplateBindings(
            new Map([[internal, { snapshotId: "snapshot_123" }]]),
            async () => await template.create({ resources: 2 }),
          ),
      ),
    ).resolves.toBe(sandbox.session);
    expect(create).toHaveBeenCalledWith({
      options: { resources: 2 },
      reference: { snapshotId: "snapshot_123" },
    });
    await expect(template.create({ resources: 2 })).rejects.toThrow(/no prewarmed build result/);
  });

  it("includes provider-owned preparation options in its private implementation identity", () => {
    const createTemplate = (revision: { image: string; pullPolicy: string }) =>
      defineSandboxTemplate({
        revision,
        type: "test.dev/template-revision/v1",
        async prewarm() {
          return { image: "built" };
        },
        async create() {
          return mockSandbox().session;
        },
      });

    const first = getSandboxTemplateInternal(
      createTemplate({ image: "node:24", pullPolicy: "always" }),
    );
    const reordered = getSandboxTemplateInternal(
      createTemplate({ pullPolicy: "always", image: "node:24" }),
    );
    const changed = getSandboxTemplateInternal(
      createTemplate({ image: "node:25", pullPolicy: "always" }),
    );

    expect(reordered.implementationId).toBe(first.implementationId);
    expect(changed.implementationId).not.toBe(first.implementationId);
  });

  it("builds provider-specific author methods over one internal create operation", async () => {
    const create = vi.fn(() => mockSandbox().session);
    const template = defineSandboxTemplate<
      { snapshotId: string },
      { readonly name: string },
      {
        create(): Promise<Sandbox>;
        getOrCreate(name: string): Promise<Sandbox>;
      }
    >(
      {
        type: "test.dev/custom-template-api/v1",
        async prewarm() {
          return { snapshotId: "snapshot_123" };
        },
        create,
      },
      (createFromTemplate) => ({
        async create() {
          return await createFromTemplate({ name: "new" });
        },
        async getOrCreate(name) {
          return await createFromTemplate({ name });
        },
      }),
    );
    const internal = getSandboxTemplateInternal(template);

    await withTestContext(
      async () =>
        await withSandboxTemplateBindings(
          new Map([[internal, { snapshotId: "snapshot_123" }]]),
          async () => await template.getOrCreate("shared"),
        ),
    );

    expect(isSandboxTemplate(template)).toBe(true);
    expect(create).toHaveBeenCalledWith({
      options: { name: "shared" },
      reference: { snapshotId: "snapshot_123" },
    });
  });

  it("includes the provider protocol in its private implementation identity", () => {
    const createTemplate = (type: string) =>
      defineSandboxTemplate({
        type,
        async prewarm() {
          return { image: "built" };
        },
        async create() {
          return mockSandbox().session;
        },
      });

    const first = getSandboxTemplateInternal(createTemplate("test.dev/template/v1"));
    const changed = getSandboxTemplateInternal(createTemplate("test.dev/template/v2"));

    expect(changed.implementationId).not.toBe(first.implementationId);
  });

  it("scopes references to concurrent definition invocations", async () => {
    const seen: string[] = [];
    const template = defineSandboxTemplate<{ snapshotId: string }, undefined>({
      type: "test.dev/concurrent-template/v1",
      async prewarm() {
        return { snapshotId: "unused" };
      },
      async create({ reference }) {
        await Promise.resolve();
        seen.push(reference.snapshotId);
        return mockSandbox({ id: reference.snapshotId }).session;
      },
    });
    const internal = getSandboxTemplateInternal(template);

    const [first, second] = await Promise.all([
      withTestContext(
        async () =>
          await withSandboxTemplateBindings(
            new Map([[internal, { snapshotId: "snapshot-a" }]]),
            async () => await template.create(undefined),
          ),
      ),
      withTestContext(
        async () =>
          await withSandboxTemplateBindings(
            new Map([[internal, { snapshotId: "snapshot-b" }]]),
            async () => await template.create(undefined),
          ),
      ),
    ]);

    expect(first.id).toBe("snapshot-a");
    expect(second.id).toBe("snapshot-b");
    expect(seen).toEqual(expect.arrayContaining(["snapshot-a", "snapshot-b"]));
  });

  it("supports a JSON null provider reference without process-global state", async () => {
    const template = defineSandboxTemplate<null, undefined>({
      type: "test.dev/nullable-template/v1",
      async prewarm() {
        return null;
      },
      async create({ reference }) {
        expect(reference).toBeNull();
        return mockSandbox().session;
      },
    });
    const internal = getSandboxTemplateInternal(template);

    await expect(
      withTestContext(
        async () =>
          await withSandboxTemplateBindings(
            new Map([[internal, null]]),
            async () => await template.create(undefined),
          ),
      ),
    ).resolves.toBeDefined();
  });
});

async function withTestContext<T>(callback: () => Promise<T>): Promise<T> {
  return await contextStorage.run(new ContextContainer(), callback);
}
