import { expect, it } from "vitest";

import { areSchedulesDisabled } from "./disabled.js";

it.each([
  [undefined, false],
  ["", false],
  ["0", false],
  ["false", false],
  ["yes", false],
  ["1", true],
  ["true", true],
  ["TrUe", true],
] as const)("interprets EVE_SCHEDULES_DISABLED=%s as disabled=%s", (value, disabled) => {
  expect(areSchedulesDisabled({ EVE_SCHEDULES_DISABLED: value })).toBe(disabled);
});
