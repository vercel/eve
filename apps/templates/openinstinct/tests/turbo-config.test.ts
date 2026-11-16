import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const applicationEnvironment = [
  "BETTER_AUTH_*",
  "BLOB_*",
  "DATABASE_URL",
  "*_CONNECTOR_UID",
  "KERNEL_*",
  "LINQ_*",
  "LINK_*",
  "STRIPE_PUBLISHABLE_KEY",
  "NODE_ENV",
  "SECRET_ENCRYPTION_KEY",
  "VERCEL_*",
];
const runtimeEnvironment = applicationEnvironment;

describe("Turbo configuration", () => {
  it("scopes application environment variables to their owning tasks", async () => {
    const turbo = z
      .object({
        tasks: z.object({
          "build:app": z.object({ env: z.array(z.string()) }),
          "build:vercel": z.object({ env: z.array(z.string()) }),
          "dev:app": z.object({ passThroughEnv: z.array(z.string()) }),
          "start:app": z.object({ passThroughEnv: z.array(z.string()) }),
        }),
      })
      .loose()
      .parse(
        JSON.parse(
          await readFile(new URL("../turbo.json", import.meta.url), "utf8")
        )
      );

    expect(turbo).not.toHaveProperty("globalEnv");
    expect(turbo.tasks["build:app"].env).toEqual(
      expect.arrayContaining([...applicationEnvironment, "EVE_NEXT_*"])
    );
    expect(turbo.tasks["build:app"].env).toHaveLength(
      applicationEnvironment.length + 1
    );
    expect(turbo.tasks["build:vercel"].env).toEqual(applicationEnvironment);
    expect(turbo.tasks["dev:app"].passThroughEnv).toEqual(runtimeEnvironment);
    expect(turbo.tasks["start:app"].passThroughEnv).toEqual(runtimeEnvironment);
  });

  it("provisions required one-click deployment configuration", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    );
    const deployButtons = [
      ...readme.matchAll(
        /\[!\[Deploy with Vercel(?: and Linq)?\]\([^)]+\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/gu
      ),
    ].map((match) => new URL(z.url().parse(match[1])));
    expect(deployButtons).toHaveLength(1);
    const [deployButton] = deployButtons;
    expect(deployButton).toBeDefined();
    const blobSetup = readme
      .split("### Blob storage", 2)[1]
      ?.split("### Linq iMessage setup", 1)[0];

    expect(deployButton?.searchParams.get("repository-url")).toBe(
      "https://github.com/Merit-Systems/OpenInstinct"
    );
    expect(deployButton?.searchParams.has("env")).toBe(false);
    expect(deployButton?.searchParams.has("products")).toBe(false);
    expect(
      JSON.parse(deployButton?.searchParams.get("stores") ?? "null")
    ).toEqual([
      {
        integrationSlug: "kernel",
        productSlug: "kernel",
        protocol: "other",
        type: "integration",
      },
      {
        integrationSlug: "neon",
        productSlug: "neon",
        protocol: "storage",
        type: "integration",
      },
      { access: "private", type: "blob" },
    ]);
    expect(
      JSON.parse(deployButton?.searchParams.get("connect") ?? "null")
    ).toEqual([
      {
        env: "LINQ_CONNECTOR",
        triggerPath: "/eve/v1/linq",
        triggers: true,
        type: "linq",
      },
    ]);
    expect(blobSetup).toContain(
      "vercel blob create-store open-instinct-images --access private --yes"
    );
    expect(blobSetup).toContain("BLOB_STORE_ID");
    expect(blobSetup).toContain("BLOB_READ_WRITE_TOKEN");
    expect(blobSetup).toContain("VERCEL_OIDC_TOKEN");
    expect(blobSetup).toContain("persistent per-user memory");
    expect(blobSetup).toContain("Production conversations require it");
    expect(blobSetup).not.toContain("vercel env pull");
    expect(
      blobSetup?.match(/^pnpm exec vercel blob create-store .+$/gmu)
    ).toHaveLength(1);
  });
});
