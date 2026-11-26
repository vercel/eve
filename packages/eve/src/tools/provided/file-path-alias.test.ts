import { describe, expect, it } from "vitest";

import { READ_FILE_INPUT_SCHEMA } from "./read-file.js";
import { WRITE_FILE_INPUT_SCHEMA } from "./write-file.js";

describe("read_file and write_file path alias", () => {
  it("normalizes path to filePath on read_file and write_file schemas", async () => {
    expect(
      await READ_FILE_INPUT_SCHEMA["~standard"].validate({ limit: 50, path: "src/app.ts" }),
    ).toEqual({
      value: { filePath: "src/app.ts", limit: 50 },
    });
    expect(
      await WRITE_FILE_INPUT_SCHEMA["~standard"].validate({
        content: "hello\n",
        path: "src/app.ts",
      }),
    ).toEqual({
      value: { content: "hello\n", filePath: "src/app.ts" },
    });
  });

  it("rejects extra fields when filePath is already supplied", async () => {
    const read = await READ_FILE_INPUT_SCHEMA["~standard"].validate({
      filePath: "a.ts",
      path: "b.ts",
    });
    expect("issues" in read && read.issues !== undefined).toBe(true);
    const readInvalid = await READ_FILE_INPUT_SCHEMA["~standard"].validate({
      filePath: null,
      path: "b.ts",
    });
    expect("issues" in readInvalid && readInvalid.issues !== undefined).toBe(true);
    const write = await WRITE_FILE_INPUT_SCHEMA["~standard"].validate({
      content: "x",
      filePath: "a.ts",
      path: "b.ts",
    });
    expect("issues" in write && write.issues !== undefined).toBe(true);
    const writeInvalid = await WRITE_FILE_INPUT_SCHEMA["~standard"].validate({
      content: "x",
      filePath: 123,
      path: "b.ts",
    });
    expect("issues" in writeInvalid && writeInvalid.issues !== undefined).toBe(true);
  });

  it("omits path from the advertised JSON schemas", () => {
    const readSchema = READ_FILE_INPUT_SCHEMA["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    const writeSchema = WRITE_FILE_INPUT_SCHEMA["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(readSchema.properties).toHaveProperty("filePath");
    expect(readSchema.properties).not.toHaveProperty("path");
    expect(writeSchema.properties).toHaveProperty("filePath");
    expect(writeSchema.properties).not.toHaveProperty("path");
  });
});
