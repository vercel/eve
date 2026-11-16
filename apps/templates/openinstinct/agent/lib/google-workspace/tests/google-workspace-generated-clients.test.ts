import { createHash } from "node:crypto";
import * as CalendarApi from "@googleapis/calendar";
import * as GmailApi from "@googleapis/gmail";
import * as PeopleApi from "@googleapis/people";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCalendarEvent } from "@agent/lib/google-workspace/calendar";
import { withGoogleAuth } from "@agent/lib/google-workspace/client";
import { searchGoogleContacts } from "@agent/lib/google-workspace/contacts";
import { sendGmail } from "@agent/lib/google-workspace/gmail";

interface RequestOptions {
  signal: AbortSignal;
}

const calendarMock = vi.spyOn(CalendarApi, "calendar");
const gmailMock = vi.spyOn(GmailApi, "gmail");
const peopleMock = vi.spyOn(PeopleApi, "people");
const setCredentialsMock = vi.spyOn(
  GmailApi.auth.OAuth2.prototype,
  "setCredentials"
);

afterEach(() => vi.clearAllMocks());

describe("generated Google Workspace clients", () => {
  it("hands the Connect token to Google and requests reauthorization on 401", async () => {
    const ctx = toolContext();
    const error = new GoogleApiError(401);

    await expect(withGoogleAuth(ctx, () => Promise.reject(error))).rejects.toBe(
      error
    );

    expect(ctx.getToken).toHaveBeenCalledOnce();
    expect(setCredentialsMock).toHaveBeenCalledWith({
      access_token: "google-access-token",
    });
    expect(ctx.requireAuth).toHaveBeenCalledOnce();
  });

  it("sends typed Gmail requests with a stable retry-safe message ID", async () => {
    const ctx = toolContext();
    const client = GmailApi.gmail({ version: "v1" });
    const send = vi
      .fn<
        (
          request: {
            requestBody: { raw: string; threadId?: string };
            userId: string;
          },
          options: RequestOptions
        ) => Promise<{ data: { id: string; threadId: string } }>
      >()
      .mockResolvedValue({ data: { id: "sent-1", threadId: "thread-1" } });
    Object.defineProperty(client.users.messages, "send", { value: send });
    googleClients({ gmail: client });

    await sendGmail(ctx, {
      bcc: [],
      body: "Hello",
      cc: [],
      subject: "Status",
      to: ["person@example.com"],
    });

    const stableId = createHash("sha256")
      .update("session-1:call-1")
      .digest("hex")
      .slice(0, 48);
    const raw = Buffer.from(
      [
        "To: person@example.com",
        "Subject: Status",
        `Message-ID: <openinstinct-${stableId}@local>`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
      ].join("\r\n") + "\r\n\r\nHello",
      "utf8"
    ).toString("base64url");
    expect(send).toHaveBeenCalledWith(
      { requestBody: { raw }, userId: "me" },
      { signal: ctx.abortSignal }
    );
  });

  it("recovers a duplicate Calendar insert using the stable event ID", async () => {
    const ctx = toolContext();
    const client = CalendarApi.calendar({ version: "v3" });
    const insert = vi
      .fn<
        (
          request: {
            calendarId: string;
            requestBody: { id?: string };
            sendUpdates?: string;
          },
          options: RequestOptions
        ) => Promise<never>
      >()
      .mockRejectedValue(new GoogleApiError(409));
    const get = vi
      .fn<
        (
          request: { calendarId: string; eventId: string },
          options: RequestOptions
        ) => Promise<{ data: { id: string; summary: string } }>
      >()
      .mockResolvedValue({
        data: { id: "existing-event", summary: "Planning" },
      });
    Object.defineProperty(client.events, "get", { value: get });
    Object.defineProperty(client.events, "insert", { value: insert });
    googleClients({ calendar: client });

    await expect(
      createCalendarEvent(ctx, {
        attendees: ["person@example.com"],
        calendarId: "primary",
        end: "2026-08-28T11:00:00-04:00",
        start: "2026-08-28T10:00:00-04:00",
        summary: "Planning",
        timezone: "America/New_York",
      })
    ).resolves.toEqual({ id: "existing-event", summary: "Planning" });

    const eventId = createHash("sha256")
      .update("session-1:call-1")
      .digest("hex")
      .slice(0, 32);
    expect(insert.mock.calls[0]?.[1]).toEqual({ signal: ctx.abortSignal });
    expect(get).toHaveBeenCalledWith(
      { calendarId: "primary", eventId },
      { signal: ctx.abortSignal }
    );
  });

  it("warms the People search cache before the typed contact query", async () => {
    const ctx = toolContext();
    const client = PeopleApi.people({ version: "v1" });
    const searchContacts = vi
      .fn<
        (
          request: { pageSize?: number; query: string; readMask: string },
          options: RequestOptions
        ) => Promise<{
          data: { results?: { person: { resourceName: string } }[] };
        }>
      >()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({
        data: { results: [{ person: { resourceName: "people/1" } }] },
      });
    Object.defineProperty(client.people, "searchContacts", {
      value: searchContacts,
    });
    googleClients({ people: client });

    await expect(searchGoogleContacts(ctx, "Person", 10)).resolves.toEqual({
      contacts: [{ person: { resourceName: "people/1" } }],
    });

    expect(searchContacts).toHaveBeenNthCalledWith(
      1,
      {
        query: "",
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      },
      { signal: ctx.abortSignal }
    );
    expect(searchContacts).toHaveBeenNthCalledWith(
      2,
      {
        pageSize: 10,
        query: "Person",
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      },
      { signal: ctx.abortSignal }
    );
  });
});

function toolContext() {
  const getToken = vi
    .fn<ToolContext["getToken"]>()
    .mockResolvedValue({ token: "google-access-token" });
  const requireAuth = vi.fn<ToolContext["requireAuth"]>();
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    abortSignal: new AbortController().signal,
    callId: "call-1",
    channel: { kind: "channel:eve", metadata: {} },
    getToken,
    messages: [],
    requireAuth,
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    to() {
      throw new Error("Cross-channel delivery is outside this focused test.");
    },
    toolName: "google-workspace-test",
  } satisfies ToolContext;
}

function googleClients(clients: {
  calendar?: ReturnType<typeof CalendarApi.calendar>;
  gmail?: ReturnType<typeof GmailApi.gmail>;
  people?: ReturnType<typeof PeopleApi.people>;
}) {
  if (clients.calendar) calendarMock.mockReturnValue(clients.calendar);
  if (clients.gmail) gmailMock.mockReturnValue(clients.gmail);
  if (clients.people) peopleMock.mockReturnValue(clients.people);
}

class GoogleApiError extends Error {
  readonly response: { status: number };

  constructor(status: number) {
    super(`Google API returned ${String(status)}`);
    this.response = { status };
  }
}
