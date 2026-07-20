// Theme-specific studio light data.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import type { EnvLightConfig } from "./types";

// Editable environment-light knobs. Hex colors are sRGB and are converted to
// linear values before the one-time cubemap bake. Light and dark intentionally
// start as duplicated white studio setups so each theme can be tuned independently.
export const EVE_LIGHT_ENV_LIGHTS = [
  {
    name: "top-left high",
    position: [-1.4, 2, -0.4],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.3,
    softness: 0.02,
    luminance: 10,
  },
  {
    name: "front high",
    position: [0, 0, 2],
    color: "#FFFFFF",
    intensity: 2,
    radius: 0.8,
    softness: 0.02,
    luminance: 1,
  },
  {
    name: "back high",
    position: [1, 0, -2],
    color: "#FFFFFF",
    intensity: 10,
    radius: 0.5,
    softness: 0.1,
    luminance: 0.2,
  },
  {
    name: "back-right",
    position: [0.4, -0.3, -1],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.1,
    softness: 1,
    luminance: 0.5,
  },
  {
    name: "front-bottom-right",
    position: [1, -2, -0.5],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.2,
    softness: 1,
    luminance: 5,
  },
  {
    name: "front-bottom-left",
    position: [-0.3, -0.2, -0.2],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.3,
    softness: 4,
    luminance: 3,
  },
] as const satisfies readonly EnvLightConfig[];

export const EVE_DARK_ENV_LIGHTS = [
  {
    name: "top-left high",
    position: [-1.3, 2, -0.3],
    color: "#FFFFFF",
    intensity: 2,
    radius: 0.3,
    softness: 0.02,
    luminance: 10,
  },
  {
    name: "front-left high",
    position: [-0.4, 1, 1],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.9,
    softness: 0.02,
    luminance: 1,
  },
  {
    name: "front-right",
    position: [5, 0, 10],
    color: "#FFFFFF",
    intensity: 1.5,
    radius: 0.5,
    softness: 0.1,
    luminance: 0.2,
  },
  {
    name: "back-right",
    position: [0.4, -0.3, -1],
    color: "#FFFFFF",
    intensity: 5,
    radius: 0.1,
    softness: 1,
    luminance: 0.5,
  },
  {
    name: "front-bottom-right",
    position: [1, -2, -0.5],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.2,
    softness: 1,
    luminance: 5,
  },
  {
    name: "front-bottom-left",
    position: [-0.3, -0.2, -0.2],
    color: "#FFFFFF",
    intensity: 1,
    radius: 0.3,
    softness: 4,
    luminance: 3,
  },
] as const satisfies readonly EnvLightConfig[];
