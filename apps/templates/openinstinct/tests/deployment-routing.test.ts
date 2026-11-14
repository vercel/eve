import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect, it } from "vitest";
import scheduledRun from "@agent/channels/scheduled-run";

it("routes every scheduled callback to the generated Eve service in production", () => {
  const config = z
    .object({
      routes: z.array(
        z.object({
          src: z.string(),
          destination: z.object({
            type: z.literal("service"),
            service: z.string(),
          }),
        })
      ),
    })
    .parse(JSON.parse(readFileSync("vercel.json", "utf8")));
  const callbackPaths = scheduledRun.routes.map((route) => route.path);
  expect(callbackPaths).toHaveLength(2);
  for (const path of callbackPaths) {
    const matched = config.routes.find((route) =>
      new RegExp(route.src).test(path)
    );
    expect(matched?.destination).toEqual({ type: "service", service: "eve" });
    // Authored routes must stay outside Eve's reserved protocol namespace.
    expect(path.startsWith("/eve/v1/")).toBe(false);
  }
  for (const path of [
    "/",
    "/chat",
    "/vault",
    "/internal/scheduled-run/other",
  ]) {
    expect(
      config.routes.some((route) => new RegExp(route.src).test(path))
    ).toBe(false);
  }
});
