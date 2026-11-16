import { describe, expect, it } from "vitest";

import { listTasksRequestSchema, messageSchema, partSchema } from "./protocol.js";

describe("A2A wire schemas", () => {
  it("accepts a part with exactly one content member", () => {
    expect(partSchema.safeParse({ text: "hi" }).success).toBe(true);
    expect(partSchema.safeParse({ data: { a: 1 } }).success).toBe(true);
    expect(partSchema.safeParse({ text: "hi", data: 1 }).success).toBe(false);
    expect(partSchema.safeParse({ mediaType: "text/plain" }).success).toBe(false);
  });

  it("accepts only web URLs for file parts", () => {
    expect(partSchema.safeParse({ url: "https://example.com/a.png" }).success).toBe(true);
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)"]) {
      expect(partSchema.safeParse({ url }).success).toBe(false);
    }
  });

  it("reads an absent role as unspecified, which the user's messages may leave", () => {
    const parsed = messageSchema.parse({ messageId: "m-1", parts: [{ text: "hi" }] });
    expect(parsed.role).toBe("ROLE_UNSPECIFIED");
  });

  it("reads ProtoJSON int32 strings and bounds ListTasks", () => {
    expect(listTasksRequestSchema.parse({ historyLength: "3", pageSize: "10" })).toMatchObject({
      historyLength: 3,
      pageSize: 10,
    });
    expect(listTasksRequestSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(listTasksRequestSchema.safeParse({ historyLength: -1 }).success).toBe(false);
    expect(listTasksRequestSchema.safeParse({ status: "TASK_STATE_RUNNING" }).success).toBe(false);
    expect(listTasksRequestSchema.safeParse({ status: "TASK_STATE_UNSPECIFIED" }).success).toBe(
      true,
    );
  });
});
