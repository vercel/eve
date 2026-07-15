import type { Bounds, MeshData } from "./render";

type Vec3 = [number, number, number];

type GltfDocument = {
  buffers?: Array<{ uri: string }>;
  bufferViews: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  accessors: Array<{
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
  }>;
  meshes?: Array<{
    primitives?: Array<{
      mode?: number;
      attributes?: { POSITION?: number; NORMAL?: number };
      indices?: number;
    }>;
  }>;
};

const GLTF_MODE_TRIANGLES = 4;
const GL_FLOAT = 5126;
const GL_UNSIGNED_BYTE = 5121;
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const POSITION_COMPONENTS = 3;
const NORMAL_COMPONENTS = 3;

export async function decodeGltfMesh(
  gltf: GltfDocument,
  loadBuffer: (uri: string) => Promise<ArrayBufferLike>,
): Promise<MeshData> {
  const buffers = await Promise.all((gltf.buffers ?? []).map((buffer) => loadBuffer(buffer.uri)));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.mode !== undefined && primitive.mode !== GLTF_MODE_TRIANGLES) continue;

      const positionAccessorIndex = primitive.attributes?.POSITION;
      const positionAccessor =
        positionAccessorIndex === undefined ? undefined : gltf.accessors[positionAccessorIndex];
      if (!positionAccessor) continue;

      const normalAccessorIndex = primitive.attributes?.NORMAL;
      const normalAccessor =
        normalAccessorIndex === undefined ? undefined : gltf.accessors[normalAccessorIndex];
      const primitivePositions = readFloatAccessor(
        buffers,
        gltf,
        positionAccessor,
        POSITION_COMPONENTS,
      );
      const primitiveNormals = normalAccessor
        ? readFloatAccessor(buffers, gltf, normalAccessor, NORMAL_COMPONENTS)
        : fallbackNormals(primitivePositions);
      const vertexOffset = positions.length / POSITION_COMPONENTS;

      for (const value of primitivePositions) positions.push(value);
      for (const value of primitiveNormals) normals.push(value);

      if (primitive.indices !== undefined) {
        const primitiveIndices = readIndexAccessor(
          buffers,
          gltf,
          gltf.accessors[primitive.indices]!,
        );
        for (const index of primitiveIndices) indices.push(vertexOffset + index);
      } else {
        for (let i = 0; i < primitivePositions.length / POSITION_COMPONENTS; i++)
          indices.push(vertexOffset + i);
      }
    }
  }

  if (!positions.length || !indices.length)
    throw new Error("No triangle mesh data found in glTF asset.");

  const positionArray = new Float32Array(positions);
  return {
    positions: positionArray,
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    bounds: meshBounds(positionArray),
  };
}

export function meshAspect(mesh: MeshData) {
  const width = mesh.bounds.max[0] - mesh.bounds.min[0];
  const height = mesh.bounds.max[1] - mesh.bounds.min[1];
  return width / height;
}

function readFloatAccessor(
  buffers: ArrayBufferLike[],
  gltf: GltfDocument,
  accessor: GltfDocument["accessors"][number],
  components: number,
) {
  const view = gltf.bufferViews[accessor.bufferView]!;
  const buffer = buffers[view.buffer]!;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (accessor.componentType !== GL_FLOAT)
    throw new Error(`Unsupported float accessor component type ${accessor.componentType}`);
  if (!view.byteStride || view.byteStride === components * Float32Array.BYTES_PER_ELEMENT) {
    return new Float32Array(buffer, byteOffset, accessor.count * components);
  }

  const source = new DataView(buffer, byteOffset, view.byteLength - (accessor.byteOffset ?? 0));
  const out = new Float32Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i++) {
    for (let component = 0; component < components; component++) {
      out[i * components + component] = source.getFloat32(
        i * view.byteStride + component * Float32Array.BYTES_PER_ELEMENT,
        true,
      );
    }
  }
  return out;
}

function readIndexAccessor(
  buffers: ArrayBufferLike[],
  gltf: GltfDocument,
  accessor: GltfDocument["accessors"][number],
) {
  const view = gltf.bufferViews[accessor.bufferView]!;
  const buffer = buffers[view.buffer]!;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (accessor.componentType === GL_UNSIGNED_BYTE)
    return new Uint8Array(buffer, byteOffset, accessor.count);
  if (accessor.componentType === GL_UNSIGNED_SHORT)
    return new Uint16Array(buffer, byteOffset, accessor.count);
  if (accessor.componentType === GL_UNSIGNED_INT)
    return new Uint32Array(buffer, byteOffset, accessor.count);
  throw new Error(`Unsupported index accessor component type ${accessor.componentType}`);
}

function fallbackNormals(positions: Float32Array) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 9) {
    const normal = faceNormal(
      [positions[i]!, positions[i + 1]!, positions[i + 2]!],
      [positions[i + 3]!, positions[i + 4]!, positions[i + 5]!],
      [positions[i + 6]!, positions[i + 7]!, positions[i + 8]!],
    );
    normals.set(normal, i);
    normals.set(normal, i + 3);
    normals.set(normal, i + 6);
  }
  return normals;
}

function meshBounds(positions: Float32Array): Bounds {
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < positions.length; i += POSITION_COMPONENTS) {
    min[0] = Math.min(min[0], positions[i]!);
    min[1] = Math.min(min[1], positions[i + 1]!);
    min[2] = Math.min(min[2], positions[i + 2]!);
    max[0] = Math.max(max[0], positions[i]!);
    max[1] = Math.max(max[1], positions[i + 1]!);
    max[2] = Math.max(max[2], positions[i + 2]!);
  }
  return { min, max };
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return normalize3([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
