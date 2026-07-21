import { describe, expect, it } from "vitest";
import { getIntegration } from "./data";
import { integrationSearchText } from "./discovery";

describe("integration discovery", () => {
  it("includes presentation keywords in searchable text", () => {
    const slack = getIntegration("slack");
    expect(slack).toBeDefined();

    expect(integrationSearchText(slack!)).toContain("Slack");
    expect(integrationSearchText(slack!)).toContain("Channel");
    expect(integrationSearchText(slack!)).toContain("messaging");
  });
});
