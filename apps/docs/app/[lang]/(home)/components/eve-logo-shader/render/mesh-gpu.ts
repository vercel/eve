// GPU mesh upload plus normalization and line-index generation.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import { Device } from "@vgpu/core";
import type { Bounds, GpuMesh, MeshData } from "./types";

export function createGpuMesh(device: Device, mesh: MeshData): GpuMesh {
  const vertices = normalizeMeshForGpu(mesh);
  const lineIndices = triangleIndicesToLineIndices(mesh.indices);

  const vertexBuffer = device.createBuffer({
    label: "eve-5-logo-vertices",
    size: vertices.byteLength,
    usage: ["vertex", "copy_dst"],
  });
  vertexBuffer.write(vertices);

  const indexBuffer = device.createBuffer({
    label: "eve-5-logo-indices",
    size: mesh.indices.byteLength,
    usage: ["index", "copy_dst"],
  });
  indexBuffer.write(new Uint32Array(mesh.indices));

  const lineIndexBuffer = device.createBuffer({
    label: "eve-5-logo-line-indices",
    size: lineIndices.byteLength,
    usage: ["index", "copy_dst"],
  });
  lineIndexBuffer.write(lineIndices);

  return {
    vertexBuffer,
    indexBuffer,
    lineIndexBuffer,
    indexCount: mesh.indices.length,
    lineIndexCount: lineIndices.length,
  };
}

export function normalizedMeshBounds(bounds: Bounds): Bounds {
  const height = bounds.max[1] - bounds.min[1] || 1;
  const centerX = (bounds.min[0] + bounds.max[0]) * 0.5;
  const centerY = (bounds.min[1] + bounds.max[1]) * 0.5;
  const frontZ = bounds.max[2];
  return {
    min: [
      (bounds.min[0] - centerX) / height,
      (bounds.min[1] - centerY) / height,
      (bounds.min[2] - frontZ) / height,
    ],
    max: [
      (bounds.max[0] - centerX) / height,
      (bounds.max[1] - centerY) / height,
      (bounds.max[2] - frontZ) / height,
    ],
  };
}

function normalizeMeshForGpu(mesh: MeshData) {
  const height = mesh.bounds.max[1] - mesh.bounds.min[1];
  const centerX = (mesh.bounds.min[0] + mesh.bounds.max[0]) * 0.5;
  const centerY = (mesh.bounds.min[1] + mesh.bounds.max[1]) * 0.5;
  const frontZ = mesh.bounds.max[2];
  const data = new Float32Array((mesh.positions.length / 3) * 6);

  for (let i = 0, j = 0; i < mesh.positions.length; i += 3, j += 6) {
    data[j] = (mesh.positions[i]! - centerX) / height;
    data[j + 1] = (mesh.positions[i + 1]! - centerY) / height;
    data[j + 2] = (mesh.positions[i + 2]! - frontZ) / height;
    data[j + 3] = mesh.normals[i]!;
    data[j + 4] = mesh.normals[i + 1]!;
    data[j + 5] = mesh.normals[i + 2]!;
  }

  return data;
}

function triangleIndicesToLineIndices(indices: Uint32Array) {
  const lines = new Uint32Array(indices.length * 2);
  for (let i = 0, j = 0; i < indices.length; i += 3, j += 6) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    lines[j] = a;
    lines[j + 1] = b;
    lines[j + 2] = b;
    lines[j + 3] = c;
    lines[j + 4] = c;
    lines[j + 5] = a;
  }
  return lines;
}
