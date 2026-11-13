import type * as Eve from "eve";
import type * as EveTools from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";

vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);

import personalInfoMemory from "@agent/memory/personal_info";
import workstreamMemory from "@agent/memory/workstreams";
import browserAgent from "@agent/subagents/browser-agent/agent";
import calendar from "@agent/tools/calendar";
import contacts from "@agent/tools/contacts";
import gmail from "@agent/tools/gmail";
import messaging from "@agent/tools/messaging";
import schedules from "@agent/tools/schedules";
import vault from "@agent/tools/vault";

const groupedTools = [calendar, contacts, gmail, messaging, schedules, vault];

describe("authored mode capability matrix", () => {
  it("gives interactive turns the authored coordinator capabilities", async () => {
    expect(await authoredCapabilities("linq-message")).toEqual([
      "browser-agent",
      "calendar-check-availability",
      "calendar-create-event",
      "calendar-list-events",
      "contacts-search",
      "gmail-read-thread",
      "gmail-search",
      "gmail-send",
      "gmail-update",
      "personal_info__update",
      "react_to_message",
      "request_vault_import",
      "request_vault_setup",
      "schedules-answer",
      "schedules-create",
      "schedules-list",
      "schedules-update",
      "send_message",
      "share_contact",
      "workstreams__find",
      "workstreams__forget",
      "workstreams__read",
      "workstreams__save",
    ]);
  });

  it("gives scheduled workers only authored read and execution capabilities", async () => {
    expect(await authoredCapabilities("scheduled-worker")).toEqual([
      "browser-agent",
      "calendar-check-availability",
      "calendar-list-events",
      "contacts-search",
      "gmail-read-thread",
      "gmail-search",
    ]);
  });

  it("limits authored scheduled reporting tools to delivery or resuming its own run", async () => {
    expect(await authoredCapabilities("scheduled-result")).toEqual([
      "request_vault_setup",
      "schedules-answer",
      "send_message",
    ]);
  });
});

async function authoredCapabilities(authenticator: string) {
  const context = dynamicContext(authenticator);
  const capabilities: string[] = [];

  const resolvedGroups = await Promise.all(
    groupedTools.map(async (definition) => {
      const resolved = await evaluateDynamic(definition, context);
      return resolved && !("execute" in resolved) ? Object.keys(resolved) : [];
    })
  );
  capabilities.push(...resolvedGroups.flat());

  const personalInfoTools = await personalInfoMemory.provider.tools({
    abortSignal: new AbortController().signal,
    channel: context.channel,
    session: context.session,
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-personal-info-v1",
        value: "personal:workspace",
      },
      slot: "personal_info",
    },
  });
  if (personalInfoTools) {
    capabilities.push(
      ...Object.keys(personalInfoTools).map((name) => `personal_info__${name}`)
    );
  }

  const workstreamTools = await workstreamMemory.provider.tools({
    abortSignal: new AbortController().signal,
    channel: context.channel,
    session: context.session,
    memory: {
      scope: {
        key: "workstreams-key",
        namespace: "workstreams",
        value: "personal:workspace",
      },
      slot: "workstreams",
    },
  });
  if (workstreamTools)
    capabilities.push(
      ...Object.keys(workstreamTools).map((name) => `workstreams__${name}`)
    );

  if (await evaluateDynamic(browserAgent, context)) {
    capabilities.push("browser-agent");
  }

  return capabilities.toSorted();
}

function dynamicContext(authenticator: string) {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: { workspaceId: "personal:workspace" },
        authenticator,
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    channel: { kind: "channel:linq", metadata: {} },
    sessionId: "session-1",
  });
}
