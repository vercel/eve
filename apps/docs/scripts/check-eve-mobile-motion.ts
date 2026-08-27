import { strict as assert } from "node:assert";
import {
  MOBILE_AUTO_ROTATE_SPEED,
  evePointerInteractionMode,
  mobileAutoEnvYaw,
} from "../app/[lang]/(home)/components/eve-logo-shader/mobile-motion";

const coarse = evePointerInteractionMode(true);
assert.equal(coarse.paintEnabled, false, "coarse pointer must disable paint");
assert.equal(coarse.autoRotateEnvYaw, true, "coarse pointer must enable auto env yaw");

const fine = evePointerInteractionMode(false);
assert.equal(fine.paintEnabled, true, "fine pointer must keep paint enabled");
assert.equal(fine.autoRotateEnvYaw, false, "fine pointer must keep pointer-driven env yaw");

assertAlmost(mobileAutoEnvYaw(0), 0, "yaw at t=0");
assertAlmost(mobileAutoEnvYaw(10), 1.5, "yaw at t=10s");
assertAlmost(mobileAutoEnvYaw(21), 3.15, "yaw at t=21s");
assertAlmost(
  mobileAutoEnvYaw(3600),
  MOBILE_AUTO_ROTATE_SPEED * 3600,
  "yaw after 1h remains unwrapped",
);
assert(mobileAutoEnvYaw(3600) > Math.PI * 2, "auto yaw must be monotonic and unwrapped");

console.log(
  JSON.stringify(
    {
      ok: true,
      speedRadPerSecond: MOBILE_AUTO_ROTATE_SPEED,
      coarse,
      fine,
      yawSamples: {
        t0: round(mobileAutoEnvYaw(0)),
        t10: round(mobileAutoEnvYaw(10)),
        t21: round(mobileAutoEnvYaw(21)),
        t3600: round(mobileAutoEnvYaw(3600)),
      },
    },
    null,
    2,
  ),
);

function assertAlmost(actual: number, expected: number, label: string) {
  assert(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, received ${actual}`);
}

function round(value: number) {
  return Number(value.toFixed(6));
}
