import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_VIDEO_MODEL,
  isVideoModelLike,
  resolveConfiguredModel,
  resolveJobModel,
} from "../../extension/lib/model.ts";
import { createAsyncVideoModel, createSyncVideoModel } from "../helpers.ts";

describe("isVideoModelLike", () => {
  test("accepts v4 and v3 models implementing doGenerate or doStart+doStatus", () => {
    assert.equal(
      isVideoModelLike(createAsyncVideoModel({ specificationVersion: "v4" }).model),
      true,
    );
    assert.equal(
      isVideoModelLike(createAsyncVideoModel({ specificationVersion: "v3" }).model),
      true,
    );
    assert.equal(
      isVideoModelLike(createSyncVideoModel({ specificationVersion: "v4" }).model),
      true,
    );
    assert.equal(
      isVideoModelLike(createSyncVideoModel({ specificationVersion: "v3" }).model),
      true,
    );
  });

  test("rejects invalid shapes, unsupported versions, and incomplete async models", () => {
    const invalidValues: readonly unknown[] = [
      null,
      undefined,
      "google/veo-3.1-fast-generate-001",
      123,
      {},
      { specificationVersion: "v2", provider: "p", modelId: "m", doGenerate: async () => ({}) },
      { specificationVersion: "v4", provider: "  ", modelId: "m", doGenerate: async () => ({}) },
      { specificationVersion: "v4", provider: "p", modelId: "", doGenerate: async () => ({}) },
      { specificationVersion: "v4", provider: "p", modelId: "m" },
      { specificationVersion: "v4", provider: "p", modelId: "m", doStart: async () => ({}) },
      { specificationVersion: "v4", provider: "p", modelId: "m", doStatus: async () => ({}) },
    ];
    for (const candidate of invalidValues) {
      assert.equal(isVideoModelLike(candidate), false);
    }
  });
});

describe("resolveConfiguredModel", () => {
  test("defaults to DEFAULT_VIDEO_MODEL when config is empty", () => {
    const resolved = resolveConfiguredModel({});
    assert.equal(resolved.modelId, DEFAULT_VIDEO_MODEL);
    assert.equal(isVideoModelLike(resolved.model), true);
  });

  test("enforces array models allowlist and uses first entry as default when model is omitted", () => {
    const config = {
      models: ["google/veo-3.1-fast-generate-001", "klingai/kling-v2.6-pro"] as const,
    };

    const defaultResolved = resolveConfiguredModel(config);
    assert.equal(defaultResolved.modelId, "google/veo-3.1-fast-generate-001");

    const requested = resolveConfiguredModel(config, "klingai/kling-v2.6-pro");
    assert.equal(requested.modelId, "klingai/kling-v2.6-pro");

    assert.throws(
      () => resolveConfiguredModel(config, "openai/sora-2"),
      /is not allowed\. Allowed models: google\/veo-3\.1-fast-generate-001, klingai\/kling-v2\.6-pro\./,
    );
  });

  test("resolves record alias catalogs by alias, alias-as-default, and resolved modelId", () => {
    const fast = createAsyncVideoModel({ modelId: "provider/fast-v1" }).model;
    const cinema = createSyncVideoModel({ modelId: "provider/cinema-v2" }).model;

    const config = {
      model: "cinema",
      models: {
        fast,
        cinema,
      },
    };

    const defaultResolved = resolveConfiguredModel(config);
    assert.equal(defaultResolved.model, cinema);
    assert.equal(defaultResolved.modelId, "provider/cinema-v2");

    const fastByAlias = resolveConfiguredModel(config, "fast");
    assert.equal(fastByAlias.model, fast);
    assert.equal(fastByAlias.modelId, "provider/fast-v1");

    const fastById = resolveConfiguredModel(config, "provider/fast-v1");
    assert.equal(fastById.model, fast);
    assert.equal(fastById.modelId, "provider/fast-v1");

    assert.throws(
      () => resolveConfiguredModel(config, "draft"),
      /is not allowed\. Allowed model aliases: fast, cinema\./,
    );
  });

  test("rejects switching to another model when models catalog is omitted", () => {
    const primary = createAsyncVideoModel({ modelId: "test/primary" }).model;
    const config = { model: primary };

    const same = resolveConfiguredModel(config, "test/primary");
    assert.equal(same.model, primary);

    assert.throws(
      () => resolveConfiguredModel(config, "test/other"),
      /Video model switching is not enabled because "models" is not configured/,
    );
    assert.throws(() => resolveConfiguredModel(config, "   "), /must be a non-empty string/);
  });

  test("passes through custom VideoModelLike instances unchanged", () => {
    const custom = createAsyncVideoModel({ modelId: "custom/my-video-model" }).model;
    const resolved = resolveConfiguredModel({ model: custom });
    assert.equal(resolved.model, custom);
    assert.equal(resolved.modelId, "custom/my-video-model");
  });

  test("uses globalThis.AI_SDK_DEFAULT_PROVIDER for string model IDs unless custom gateway options are provided", () => {
    const previous = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    const requestedIds: string[] = [];
    const customResolved = createAsyncVideoModel({ modelId: "override/video-1" }).model;

    try {
      Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", {
        videoModel(id: string) {
          requestedIds.push(id);
          return customResolved;
        },
      });

      const resolved = resolveConfiguredModel({ model: "acme/video-1" });
      assert.deepEqual(requestedIds, ["acme/video-1"]);
      assert.equal(resolved.model, customResolved);
      assert.equal(resolved.modelId, "override/video-1");

      const withGateway = resolveConfiguredModel({
        model: "acme/video-2",
        gateway: {
          apiKey: "test-gateway-key",
          baseURL: "https://gateway.example.test/v1",
          headers: { "x-custom": "1" },
        },
      });
      assert.deepEqual(requestedIds, ["acme/video-1"]);
      assert.equal(withGateway.modelId, "acme/video-2");
      assert.notEqual(withGateway.model, customResolved);

      Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", {
        videoModel() {
          return { invalid: true };
        },
      });
      assert.throws(
        () => resolveConfiguredModel({ model: "acme/video-3" }),
        /did not return a valid v4\/v3 video model/,
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      } else {
        Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previous);
      }
    }
  });
});

describe("resolveJobModel", () => {
  test("resolves catalog entries by alias or resolved modelId and resolves arbitrary string IDs when config is omitted", () => {
    const quality = createAsyncVideoModel({ modelId: "provider/quality-v3" }).model;
    const config = { models: { quality } };

    assert.equal(resolveJobModel(config, "quality").model, quality);
    assert.equal(resolveJobModel(config, "provider/quality-v3").model, quality);
    assert.throws(() => resolveJobModel(config, "   "), /must be a non-empty string/);

    const previous = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    const dynamicModel = createAsyncVideoModel({ modelId: "klingai/kling-v2.6-pro" }).model;
    const requested: string[] = [];
    try {
      Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", {
        videoModel(id: string) {
          requested.push(id);
          return dynamicModel;
        },
      });
      const resolved = resolveJobModel({}, "klingai/kling-v2.6-pro");
      assert.deepEqual(requested, ["klingai/kling-v2.6-pro"]);
      assert.equal(resolved.model, dynamicModel);
      assert.equal(resolved.modelId, "klingai/kling-v2.6-pro");
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      } else {
        Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previous);
      }
    }
  });
});
