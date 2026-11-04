import { expect, expectTypeOf, it } from "vitest";
import * as client from "#client/index.js";
import type { ClientSession } from "#client/index.js";
import type { SessionInfo, SessionSchedule } from "#public/context/index.js";
import type {
  PrewarmSessionResult,
  Session,
  SessionReader,
  SessionStreamOptions,
} from "#public/sessions/index.js";

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

it("keeps preparation on command-capable handles with one shared result type", () => {
  expectTypeOf<ReturnType<ClientSession["prewarm"]>>().toEqualTypeOf<
    Promise<PrewarmSessionResult>
  >();
  expectTypeOf<ReturnType<Session["prewarm"]>>().toEqualTypeOf<Promise<PrewarmSessionResult>>();
  expectTypeOf<SessionReader>().not.toHaveProperty("prewarm");
});
