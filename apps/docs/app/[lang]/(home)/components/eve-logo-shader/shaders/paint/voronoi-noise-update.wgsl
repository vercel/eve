import { voronoi_cell_value_and_edge_3d } from "../shared/voronoi.wgsl";

struct VertexOutput {
  @builtin(position) position: vec4f,
};

struct VoronoiNoiseParams {
  gridScale: f32,
  time: f32,
  originCell: vec2f,
};

struct VoronoiNoiseOutput {
  @location(0) value: f32,
  @location(1) edge: f32,
};

@group(0) @binding(0) var<uniform> params: VoronoiNoiseParams;

const IMPRINT_VORONOI_FREQUENCY = 4.8;
const ASCII_VORONOI_Z_SPEED = 0.35;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0, 1.0),
    vec2f(3.0, 1.0),
  );

  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> VoronoiNoiseOutput {
  let localCell = vec2i(input.position.xy);
  let globalCell = vec2f(localCell) + params.originCell;
  let safeGridScale = max(params.gridScale, 0.001);
  let cellCenter = (globalCell + vec2f(0.5)) / safeGridScale;
  let samplePosition = vec3f(
    cellCenter * IMPRINT_VORONOI_FREQUENCY,
    params.time * ASCII_VORONOI_Z_SPEED,
  );
  let voronoi = voronoi_cell_value_and_edge_3d(samplePosition);

  var output: VoronoiNoiseOutput;
  output.value = voronoi.x;
  output.edge = voronoi.y;
  return output;
}
