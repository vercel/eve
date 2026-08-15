// Shared scene uniform ABI for glass and environment entry shaders.
// INVARIANT: 176 bytes / 44 f32; field order must match render/params.ts writeParams.
// 0-15 viewProj, 16-18 cameraPos, 19 passKind, 20-22 cameraRight, 23 fov,
// 24-26 cameraUp, 27 aspect, 28-30 cameraForward, 31 materialKind,
// 32 thicknessScale, 33 envYaw, 34 envPitch, 35 glassAbsorption,
// 36 imprintProgress, 37 gridScale, 38 glyphScale, 39 time,
// 40-41 mouse, 42-43 originCell.

export struct Params {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  passKind: f32,
  cameraRight: vec3f,
  fov: f32,
  cameraUp: vec3f,
  aspect: f32,
  cameraForward: vec3f,
  materialKind: f32,
  thicknessScale: f32,
  envYaw: f32,
  envPitch: f32,
  glassAbsorption: f32,
  // x = imprint progress, y = grid scale (cells/model unit), z = glyph scale, w = time seconds.
  ascii0: vec4f,
  // x/y = normalized mouse offset; z/w = origin cell.
  ascii1: vec4f,
};

export const WIRE_PASS_THRESHOLD = 1.5;
