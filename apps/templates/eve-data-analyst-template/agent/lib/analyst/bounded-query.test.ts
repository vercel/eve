import { once } from "node:events";
import { createServer } from "node:net";
import type { Socket } from "node:net";

import { Pool } from "pg";
import { expect, it } from "vitest";
import { z } from "zod";

import { queryBounded } from "./bounded-query";

const int32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};

const message = (tag: string, body: Buffer) =>
  Buffer.concat([Buffer.from(tag), int32(body.length + 4), body]);

const field = () => {
  const metadata = Buffer.alloc(18);
  metadata.writeInt32BE(25, 6);
  metadata.writeInt16BE(-1, 10);
  metadata.writeInt32BE(-1, 12);
  return message(
    "T",
    Buffer.concat([Buffer.from([0, 1]), Buffer.from("value\0"), metadata])
  );
};

const row = (value: string) =>
  message(
    "D",
    Buffer.concat([
      Buffer.from([0, 1]),
      int32(Buffer.byteLength(value)),
      Buffer.from(value),
    ])
  );

const ready = message("Z", Buffer.from("I"));

const withServer = async (
  respond: (socket: Socket) => void,
  run: (pool: Pool) => Promise<void>
) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.concat([message("R", int32(0)), ready]));
      socket.once("data", () => respond(socket));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).parse(server.address());
  const pool = new Pool({
    host: "127.0.0.1",
    port: address.port,
    ssl: false,
    user: "test",
  });
  try {
    await run(pool);
  } finally {
    await pool.end();
    for (const socket of sockets) {
      socket.destroy();
    }
    const closed = once(server, "close");
    server.close();
    await closed;
  }
};

it("preserves a normal driver's typed rows and metadata", async () => {
  await withServer(
    (socket) => {
      socket.write(
        Buffer.concat([
          field(),
          row("hello"),
          message("C", Buffer.from("SELECT 1\0")),
          ready,
        ])
      );
    },
    async (pool) => {
      const client = await pool.connect();
      try {
        await expect(
          queryBounded(client, { text: "SELECT 'hello'" })
        ).resolves.toMatchObject({
          fields: [{ dataTypeID: 25, name: "value" }],
          rows: [{ value: "hello" }],
        });
      } finally {
        client.release(true);
      }
    }
  );
});

it.each([
  "SELECT large_cell",
  "EXPLAIN (VERBOSE, FORMAT JSON) SELECT large_constant",
])(
  "aborts %s before an oversized field has finished arriving",
  async (text) => {
    await withServer(
      (socket) => {
        socket.write(field());
        // Declare a 64 MiB field, but never send its remaining bytes. A row-level
        // or post-query check cannot reject this unfinished protocol message.
        socket.write(
          Buffer.concat([
            Buffer.from("D"),
            int32(64 * 1024 * 1024 + 10),
            Buffer.from([0, 1]),
            int32(64 * 1024 * 1024),
          ])
        );
        socket.write(Buffer.alloc(1024 * 1024 + 1, 120));
      },
      async (pool) => {
        const client = await pool.connect();
        try {
          await expect(queryBounded(client, { text })).rejects.toThrow(
            "Query response exceeds 1 MiB"
          );
        } finally {
          client.release(true);
        }
      }
    );
  },
  2000
);

it("aborts aggregate bytes across otherwise small complete rows", async () => {
  await withServer(
    (socket) => {
      socket.write(field());
      for (let index = 0; index < 32; index += 1) {
        socket.write(row("x".repeat(40_000)));
      }
      socket.write(
        Buffer.concat([message("C", Buffer.from("SELECT 32\0")), ready])
      );
    },
    async (pool) => {
      const client = await pool.connect();
      try {
        await expect(
          queryBounded(client, { text: "SELECT small_cells" })
        ).rejects.toThrow("Query response exceeds 1 MiB");
      } finally {
        client.release(true);
      }
    }
  );
});
