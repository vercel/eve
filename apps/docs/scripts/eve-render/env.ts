import type { EveMaterial } from "../../app/[lang]/(home)/components/eve-logo-shader/render";

// Owns environment-variable parsing for the offline Eve renderer.
// INVARIANT: EVE_LOGO_RENDER_* and EVE_LOGO_PAINT_* names/accepted values are unchanged.
// Imported by config, paint-fixtures, and views.

export function readFiniteNumberEnv(name: string, fallback: number) {
  return readOptionalFiniteNumberEnv(name) ?? fallback;
}

export function readOptionalFiniteNumberEnv(name: string) {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return parsed;
}

export function readPositiveIntegerEnv(name: string, fallback: number, minimumExclusive = 0) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= minimumExclusive) {
    throw new Error(`${name} must be an integer greater than ${minimumExclusive}.`);
  }
  return parsed;
}

export function readPositiveNumberEnv(name: string, fallback: number) {
  return readOptionalPositiveNumberEnv(name) ?? fallback;
}

export function readOptionalPositiveNumberEnv(name: string) {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

export function readNonNegativeNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}

export function readUnitIntervalEnv(name: string) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1.`);
  }
  return parsed;
}

export function readRangeEnv(name: string, fallback: number, min: number, max: number) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return parsed;
}

export function readNonNegativeIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value.`);
}

export function readRenderStageEnv(): EveMaterial {
  const values: Record<string, EveMaterial> = {
    glass: "glass",
    "back-albedo": "back-albedo",
    "back-depth": "back-depth",
    thickness: "thickness",
    normal: "normal",
    "camera-reflected-normal": "camera reflected normal",
    metallic: "metallic",
    "paint-debug": "paint-debug",
  };
  const value = process.env.EVE_LOGO_RENDER_STAGE ?? "glass";
  const stage = values[value];
  if (!stage) {
    throw new Error(`EVE_LOGO_RENDER_STAGE must be one of: ${Object.keys(values).join(", ")}.`);
  }
  return stage;
}

export function stageFileName(stage: EveMaterial) {
  return stage.replaceAll(" ", "-");
}

export function formatProgressForFile(progress: number) {
  return progress.toFixed(3).replace(/0+$/, "").replace(/\.$/, "").replace(".", "p");
}

export function readNoiseTimeEnv() {
  const value = process.env.EVE_LOGO_RENDER_NOISE_TIME;
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("EVE_LOGO_RENDER_NOISE_TIME must be a finite number.");
  }
  return parsed;
}

export function readThemeEnv(): "light" | "dark" {
  const value = process.env.EVE_LOGO_RENDER_THEME ?? "dark";
  if (value === "light" || value === "dark") return value;
  throw new Error('EVE_LOGO_RENDER_THEME must be "light" or "dark".');
}
