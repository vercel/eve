import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";

import { createBoundedWritable } from "./docker.ts";

const TRUNCATED_LINE = "[eve-bench] log truncated at 64 MiB\n";

test("bounded writable keeps the head and appends one truncation line", async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const log = createBoundedWritable(output, 5);

  log.write("abc");
  log.write("def");
  log.write("ignored");
  log.end();
  await finished(log);

  assert.equal(Buffer.concat(chunks).toString(), `abcde${TRUNCATED_LINE}`);
});

test("bounded writable does not mark a log within the limit", async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const log = createBoundedWritable(output, 5);

  log.end("abcde");
  await finished(log);

  assert.equal(Buffer.concat(chunks).toString(), "abcde");
});
