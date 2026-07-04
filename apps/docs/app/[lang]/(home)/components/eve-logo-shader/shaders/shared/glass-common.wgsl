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
  // x/y = normalized mouse offset; z/w reserved.
  ascii1: vec4f,
};

export struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

export struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) normal: vec3f,
  @location(1) viewDir: vec3f,
  @location(2) cameraAxisDepth: f32,
  @location(3) modelPos: vec3f,
};

export const OUTSIDE_PASS_THRESHOLD = 0.5;
export const WIRE_PASS_THRESHOLD = 1.5;

export fn glass_vs_main(input: VertexInput, params: Params) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = params.viewProj * vec4f(input.position, 1.0);
  output.normal = normalize(input.normal);
  output.viewDir = normalize(params.cameraPos - input.position);
  // Depth along the camera forward axis in object/world space. Unlike view-space distance,
  // this is independent of orbit radius, so front/back subtraction gives stable thickness.
  output.cameraAxisDepth = dot(input.position, normalize(params.cameraForward));
  output.modelPos = input.position;
  return output;
}

export fn is_back_facing_to_camera(ngeo: vec3f, v: vec3f) -> bool {
  return dot(ngeo, v) <= 0.0;
}
