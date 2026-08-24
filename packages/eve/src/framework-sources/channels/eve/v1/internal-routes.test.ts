import type { CompiledChannel } from "#channel/compiled-channel.js";
import createSessionCallbackChannel from "#framework-sources/channels/eve/v1/callback/post.js";
import createConnectionCallbackGetChannel from "#framework-sources/channels/eve/v1/connections/callback/get.js";
import createLegacyConnectionCallbackGetChannel from "#framework-sources/channels/eve/v1/connections/callback/legacy/get.js";
import createLegacyConnectionCallbackPostChannel from "#framework-sources/channels/eve/v1/connections/callback/legacy/post.js";
import createConnectionCallbackPostChannel from "#framework-sources/channels/eve/v1/connections/callback/post.js";
import createTaskInputChannel from "#framework-sources/channels/eve/v1/task-input/post.js";
import {
  EVE_CALLBACK_ROUTE_PATTERN,
  EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_TASK_INPUT_ROUTE_PATTERN,
} from "#protocol/routes.js";
import {
  handleConnectionCallbackRequest,
  handleLegacyConnectionCallbackRequest,
} from "#runtime/connections/callback-route.js";
import { handleSessionCallbackRequest } from "#runtime/session-callback-route.js";
import { handleTaskInputResponseRequest } from "#runtime/task-input-response-route.js";
import { describe, expect, it } from "vitest";

describe("framework internal channel sources", () => {
  it.each([
    [
      "session callback",
      createSessionCallbackChannel,
      "POST",
      EVE_CALLBACK_ROUTE_PATTERN,
      handleSessionCallbackRequest,
    ],
    [
      "connection callback GET",
      createConnectionCallbackGetChannel,
      "GET",
      EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
      handleConnectionCallbackRequest,
    ],
    [
      "connection callback POST",
      createConnectionCallbackPostChannel,
      "POST",
      EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
      handleConnectionCallbackRequest,
    ],
    [
      "legacy connection callback GET",
      createLegacyConnectionCallbackGetChannel,
      "GET",
      EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN,
      handleLegacyConnectionCallbackRequest,
    ],
    [
      "legacy connection callback POST",
      createLegacyConnectionCallbackPostChannel,
      "POST",
      EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN,
      handleLegacyConnectionCallbackRequest,
    ],
    [
      "task input",
      createTaskInputChannel,
      "POST",
      EVE_TASK_INPUT_ROUTE_PATTERN,
      handleTaskInputResponseRequest,
    ],
  ] as const)(
    "wires the %s handler through an ordinary channel module",
    (_name, create, method, path, handler) => {
      const channel = create() as CompiledChannel;
      const route = channel.routes[0];
      if (route === undefined || route.transport !== "http") {
        throw new Error("Missing HTTP route.");
      }

      expect(channel.routes).toHaveLength(1);
      expect(route.method).toBe(method);
      expect(route.path).toBe(path);
      expect(route.handler).toBe(handler);
    },
  );
});
