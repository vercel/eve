import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeGltfMesh } from "../../app/[lang]/(home)/components/eve-logo-shader/mesh";

// Owns disk glTF loading for the offline Eve renderer.
// INVARIANT: data URI and relative-buffer decoding match the original script.
// Imported only by render-eve-5.ts.

export async function loadMeshFromDisk(path: string) {
  const gltf = JSON.parse(await readFile(path, "utf8"));
  return decodeGltfMesh(gltf, async (uri) => {
    if (uri.startsWith("data:application/octet-stream;base64,")) {
      const [, payload] = uri.split(",");
      return exactArrayBuffer(Buffer.from(payload!, "base64"));
    }
    const bufferPath = resolve(path, "..", uri);
    return exactArrayBuffer(await readFile(bufferPath));
  });
}

function exactArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
