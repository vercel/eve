import { describe, expect, it } from "vitest";

import { validateModelSlug } from "./model-source-change.js";

describe("validateModelSlug", () => {
  it("accepts a valid ChatGPT selection without consulting the Gateway catalog", async () => {
    await expect(validateModelSlug("/app", "chatgpt/gpt-5.6-sol")).resolves.toBeNull();
  });

  it("rejects a ChatGPT selection whose model is not a bare OpenAI id", async () => {
    await expect(validateModelSlug("/app", "chatgpt/not/a-bare-slug")).resolves.toBe(
      "Choose a bare OpenAI model id after `chatgpt/`.",
    );
  });
});
