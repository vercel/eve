import { expect, it } from "vitest";
import { handleExpiredLegacyAuthorization } from "./authorization.js";

it("expires historical URLs that do not identify an authorization attempt", async () => {
  expect((await handleExpiredLegacyAuthorization()).status).toBe(410);
});
