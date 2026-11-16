import { channel } from "node:diagnostics_channel";
import dns from "node:dns";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { requestPublicPage } from "./public-page";

const resolver: {
  lookup: (
    hostname: string,
    options: LookupAllOptions
  ) => Promise<LookupAddress[]>;
} = dns.promises;

const socketChannel = channel("net.client.socket");
const observeAttempts = (onAttempt: (address: string) => void) => {
  const observe: Parameters<typeof socketChannel.subscribe>[0] = (message) => {
    const { socket } = z
      .object({ socket: z.instanceof(Socket) })
      .parse(message);
    socket.on("connectionAttempt", onAttempt);
  };
  socketChannel.subscribe(observe);
  return () => {
    socketChannel.unsubscribe(observe);
  };
};

const redirectResponse = (location: string) => {
  const response = new IncomingMessage(new Socket());
  response.statusCode = 302;
  response.headers.location = location;
  return response;
};

describe(requestPublicPage, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(
    [
      [{ address: "10.1.2.3", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "fd00::1", family: 6 }],
      [{ address: "fe80::1", family: 6 }],
      [{ address: "::ffff:7f00:1", family: 6 }],
      [
        { address: "1.1.1.1", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ],
    ].map((addresses) => ({ addresses }))
  )(
    "rejects private DNS answers before connecting: $addresses",
    async ({ addresses }) => {
      const attempts: string[] = [];
      const stop = observeAttempts((address) => {
        attempts.push(address);
      });
      const lookup = vi.spyOn(resolver, "lookup").mockResolvedValue(addresses);
      try {
        await expect(
          requestPublicPage(
            new URL("https://preview.example"),
            AbortSignal.timeout(1000)
          )
        ).rejects.toThrow("not public");
        expect(attempts).toStrictEqual([]);
        expect(lookup).toHaveBeenCalledOnce();
      } finally {
        stop();
      }
    }
  );

  it("connects to the validated public answer without resolving again", async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    const stop = observeAttempts((address) => {
      attempts.push(address);
      controller.abort();
    });
    const lookup = vi
      .spyOn(resolver, "lookup")
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    try {
      await expect(
        requestPublicPage(new URL("https://preview.example"), controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(attempts).toStrictEqual(["1.1.1.1"]);
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("checks new DNS answers on subsequent requests instead of reusing a socket", async () => {
    const controller = new AbortController();
    const stop = observeAttempts(() => {
      controller.abort();
    });
    const lookup = vi
      .spyOn(resolver, "lookup")
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    try {
      await expect(
        requestPublicPage(new URL("https://preview.example"), controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        requestPublicPage(
          new URL("https://preview.example/redirected"),
          AbortSignal.timeout(1000)
        )
      ).rejects.toThrow("not public");
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("preserves the final URL and response for a relative public redirect", async () => {
    const final = new IncomingMessage(new Socket());
    final.statusCode = 200;
    const responses = [redirectResponse("/article"), final];
    const request = new ClientRequest({ createConnection: () => new Socket() });
    vi.spyOn(https, "get").mockImplementation((_url, _options, listener) => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected extra request.");
      }
      queueMicrotask(() => {
        listener?.(response);
      });
      return request;
    });
    try {
      await expect(
        requestPublicPage(
          new URL("https://public.example/start"),
          AbortSignal.timeout(1000)
        )
      ).resolves.toStrictEqual({
        response: final,
        url: new URL("https://public.example/article"),
      });
    } finally {
      final.destroy();
      request.destroy();
    }
  });

  it("rejects a public page redirecting to a hostname with private DNS", async () => {
    const attempts: string[] = [];
    const stop = observeAttempts((address) => {
      attempts.push(address);
    });
    const lookup = vi
      .spyOn(resolver, "lookup")
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const response = redirectResponse("https://private.example/secret");
    const request = new ClientRequest({ createConnection: () => new Socket() });
    const get = vi
      .spyOn(https, "get")
      .mockImplementationOnce((_url, _options, listener) => {
        queueMicrotask(() => {
          listener?.(response);
        });
        return request;
      });
    try {
      await expect(
        requestPublicPage(
          new URL("https://public.example"),
          AbortSignal.timeout(1000)
        )
      ).rejects.toThrow("not public");
      expect(get).toHaveBeenCalledTimes(2);
      expect(lookup).toHaveBeenCalledWith("private.example", {
        all: true,
        order: "verbatim",
      });
      expect(attempts).toStrictEqual([]);
      expect(response.destroyed).toBeTruthy();
    } finally {
      request.destroy();
      stop();
    }
  });
});
