import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parsePublicationResponse, publicationArguments, publishBuzzReply } from "./publisher.js";

const eventId = "a".repeat(64);

describe("Buzz publication", () => {
  it("passes content over stdin and preserves the selected reply anchor", () => {
    expect(
      publicationArguments({
        channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
        replyTo: eventId,
        triggeringEventId: eventId,
      }),
    ).toEqual([
      "messages",
      "send",
      "--channel",
      "8bdf2680-5c6d-52e6-be27-8c688fb81262",
      "--content",
      "-",
      "--reply-to",
      eventId,
    ]);
  });

  it("omits a reply anchor for a top-level message", () => {
    expect(
      publicationArguments({
        channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
        triggeringEventId: eventId,
      }),
    ).toEqual([
      "messages",
      "send",
      "--channel",
      "8bdf2680-5c6d-52e6-be27-8c688fb81262",
      "--content",
      "-",
    ]);
  });

  it("accepts only an authoritative delivered response", () => {
    expect(parsePublicationResponse(JSON.stringify({ accepted: true, event_id: eventId }))).toEqual(
      {
        accepted: true,
        eventId,
      },
    );
    expect(parsePublicationResponse(JSON.stringify({ accepted: false }))).toEqual({
      accepted: false,
    });
  });

  it("reports delivery only when the Buzz process confirms acceptance", async () => {
    await expect(
      publishBuzzReply({
        buzzCli: "buzz",
        environment: {},
        route: {
          channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
          replyTo: eventId,
          triggeringEventId: eventId,
        },
        spawnProcess: respondingProcess({ accepted: true, event_id: eventId }),
        text: "hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "delivered", eventId });

    await expect(
      publishBuzzReply({
        buzzCli: "buzz",
        environment: {},
        route: {
          channelId: "8bdf2680-5c6d-52e6-be27-8c688fb81262",
          replyTo: eventId,
          triggeringEventId: eventId,
        },
        spawnProcess: respondingProcess({ accepted: false }),
        text: "hello",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "not-delivered", reason: "buzz rejected the message" });
  });

  it("rejects malformed or incomplete delivery responses", () => {
    expect(parsePublicationResponse("not json")).toBeUndefined();
    expect(parsePublicationResponse(JSON.stringify({ accepted: true }))).toBeUndefined();
    expect(
      parsePublicationResponse(JSON.stringify({ accepted: true, event_id: "not-an-event" })),
    ).toBeUndefined();
  });
});

function respondingProcess(
  response: unknown,
): NonNullable<Parameters<typeof publishBuzzReply>[0]["spawnProcess"]> {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    queueMicrotask(() => {
      child.emit("spawn");
      stdout.end(JSON.stringify(response));
      stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
}
