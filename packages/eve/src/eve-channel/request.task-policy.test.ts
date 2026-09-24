import { describe, expect, it } from "vitest";
import { parseCreateBody, parseSessionMessageBody } from "#eve-channel/request.js";

describe("task delivery policy on HTTP sends", () => {
  it.each([parseCreateBody, parseSessionMessageBody])("validates policy at %s", async (parse) => {
    for (const taskDeliveryPolicy of ["auto", "cohort", "auto-silent", "cohort-silent"] as const) {
      expect(parse({ message: "Prepare reports", taskDeliveryPolicy })).toMatchObject({
        taskDeliveryPolicy,
      });
    }
    const messageFree = parse({ taskDeliveryPolicy: "cohort" });
    expect(messageFree).toBeInstanceOf(Response);
    expect((messageFree as Response).status).toBe(400);
    const invalid = parse({ message: "Prepare reports", taskDeliveryPolicy: "individual" });
    expect(invalid).toBeInstanceOf(Response);
    expect((invalid as Response).status).toBe(400);
    expect(await (invalid as Response).json()).toMatchObject({
      error: expect.stringContaining("taskDeliveryPolicy"),
    });
  });
});
