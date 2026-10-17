import { expect, expectTypeOf, it } from "vitest";
import * as client from "#client/index.js";
import type { ClientSession, SessionStreamOptions } from "#client/index.js";
import type { SessionInfo, SessionSchedule } from "#public/context/index.js";
import type { SessionReader } from "#public/server/index.js";

it("exposes client-created handles as types, not public constructors", () => {
  expect(client).not.toHaveProperty("ClientSession");
  expect(client).not.toHaveProperty("ClientAgentSession");
  expect(client).not.toHaveProperty("ClientSessions");
  expectTypeOf<ClientSession>().toExtend<SessionReader>();
});

it("lets client and server readers accept one line-cursor options type", () => {
  expectTypeOf<Parameters<ClientSession["stream"]>[0]>().toEqualTypeOf<
    SessionStreamOptions | undefined
  >();
  expectTypeOf<Parameters<SessionReader["stream"]>[0]>().toEqualTypeOf<
    SessionStreamOptions | undefined
  >();
});

it("names the metadata callbacks receive, not the internal session record", () => {
  expectTypeOf<SessionInfo["id"]>().toEqualTypeOf<string>();
  expectTypeOf<SessionInfo["schedule"]>().toEqualTypeOf<SessionSchedule | undefined>();
  expectTypeOf<SessionInfo>().not.toHaveProperty("sessionId");
});
