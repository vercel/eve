import { cube_dir } from "../shared/cube-face.wgsl";

const MAX_ENV_LIGHTS = 16u;

struct EnvLight {
  positionRadius: vec4f,
  colorIntensity: vec4f,
  params: vec4f,
};

struct CubeParams {
  face: f32,
  lightCount: f32,
  _pad0: f32,
  _pad1: f32,
  lights: array<EnvLight, 16>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) uv: vec2f,
};

@group(0) @binding(0) var<uniform> params: CubeParams;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let xy = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let p = xy[vertexIndex];
  var output: VertexOutput;
  output.clipPosition = vec4f(p, 0.0, 1.0);
  // The rasterizer writes clip-top (p.y = +1) to texel row 0, but cube_dir/cube_lookup_uv_face
  // treat uv.y as texture-v growing DOWNWARD (p.y = 2v-1). Without flipping v here, the baked
  // face is stored vertically mirrored relative to how the sampler reads it, which inverts +Y
  // and disagrees with the /cube-camera rasterized capture. Flip v so bake matches read.
  output.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return output;
}

fn spot(dir: vec3f, center: vec3f, radius: f32, softness: f32, luminance: f32, color: vec3f, intensity: f32) -> vec3f {
  let d = distance(normalize(dir), normalize(center));
  let soft = clamp(softness, 0.0, 1.0);
  // Gaussian softboxes keep an HDR tail instead of clamping to exact zero at radius.
  // This avoids content-driven hard cuts in reflected highlights when only one or two
  // manually edited lights are enabled. Radius still controls apparent card size;
  // softness widens/narrows the falloff without changing the desaturated white color.
  let sigma = max(radius * mix(0.35, 0.85, soft), 0.001);
  let t = exp(-0.5 * (d / sigma) * (d / sigma));
  // Units are scene-linear relative cd/m^2-ish values.
  return color * (t * luminance * intensity);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let dir = cube_dir(params.face, input.uv);

  // Dim black studio with high-dynamic-range configurable cards/softboxes.
  var radiance = vec3f(0.0);
  let lightCount = min(u32(params.lightCount), MAX_ENV_LIGHTS);

  for (var index = 0u; index < MAX_ENV_LIGHTS; index += 1u) {
    if (index >= lightCount) {
      break;
    }

    let light = params.lights[index];
    radiance += spot(
      dir,
      light.positionRadius.xyz,
      light.positionRadius.w,
      light.params.x,
      light.params.y,
      light.colorIntensity.rgb,
      light.colorIntensity.w,
    );
  }

  return vec4f(radiance, 1.0);
}
