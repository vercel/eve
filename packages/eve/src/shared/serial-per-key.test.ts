import { describe, expect, it } from "vitest";

import { serialPerKey } from "./serial-per-key.js";

describe("serialPerKey", () => {
  it("runs one key's work in order, past a failure, beside other keys'", async () => {
    const serial = serialPerKey();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = serial.run("a", async () => {
      await gate;
      order.push("a1");
      throw new Error("a1 failed");
    });
    const second = serial.run("a", async () => order.push("a2"));
    await serial.run("b", async () => order.push("b1"));
    release();
    await expect(first).rejects.toThrow("a1 failed");
    await second;
    await serial.settled("a");
    expect(order).toEqual(["b1", "a1", "a2"]);
  });
});
