import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { deployedSelfModificationConfigSchema } from "../deployed/config-schema.js";
import { selfModificationConfigSchema } from "./config-schema.js";

class StatefulCredentialProvider {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async resolve() {
    return this.token;
  }
}

describe("self-modification extension config", () => {
  it("accepts the same static model and reasoning values as agent configuration", () => {
    const languageModel = new MockLanguageModelV3();

    expect(
      selfModificationConfigSchema.parse({ model: "provider/model", reasoning: "high" }),
    ).toMatchObject({ model: "provider/model", reasoning: "high" });
    expect(selfModificationConfigSchema.parse({ model: languageModel }).model).toBe(languageModel);
  });

  it.each([
    { model: 42 },
    { model: { provider: "test", modelId: "model" } },
    { reasoning: "maximum" },
    { reasoning: {} },
  ])("rejects invalid agent options: %j", (config) => {
    expect(() => selfModificationConfigSchema.parse(config)).toThrow();
  });

  it("rejects the former deployed option with migration guidance", () => {
    expect(() => selfModificationConfigSchema.parse({ deployed: {} })).toThrow(
      "eve/self-modification/deployed",
    );
  });

  it("preserves application-supplied credential providers on the deployed mount", async () => {
    const credentials = new StatefulCredentialProvider("github-token");
    const parsed = deployedSelfModificationConfigSchema.parse({
      authorize: () => true,
      credentials,
      source: { git: { directory: ".", repository: "github.com/acme/agent" } },
      target: { branch: "main" },
    });

    expect(parsed.credentials).toBe(credentials);
    if (parsed.credentials === undefined || "pat" in parsed.credentials) {
      throw new Error("Expected credential provider.");
    }
    await expect(
      parsed.credentials.resolve({
        capability: "publish",
        repository: { owner: "acme", repo: "agent" },
      }),
    ).resolves.toBe("github-token");
  });
});
