import { decodeGltfMesh } from "../mesh";

// Owns browser glTF fetch/decode for the Eve logo mesh.
// INVARIANT: dev no-store fetch behavior is preserved for HMR/content updates.
// Imported only by index.tsx startup.

export const MODEL_URL = "/eve-5/eve-logo.gltf";

const DEV_FETCH_OPTIONS = { cache: "no-store" } as const;

function meshFetchOptions() {
  return process.env.NODE_ENV === "production" ? undefined : DEV_FETCH_OPTIONS;
}

export async function loadMesh() {
  const response = await fetch(MODEL_URL, meshFetchOptions());
  if (!response.ok) throw new Error(`Failed to load ${MODEL_URL}: ${response.status}`);
  return decodeGltfMesh(await response.json(), (uri) => loadGltfBuffer(uri, MODEL_URL));
}

async function loadGltfBuffer(uri: string, modelUrl: string) {
  if (uri.startsWith("data:application/octet-stream;base64,")) {
    return Uint8Array.from(atob(uri.split(",")[1]!), (char) => char.charCodeAt(0)).buffer;
  }
  const url = new URL(uri, window.location.origin + modelUrl);
  const response = await fetch(url, meshFetchOptions());
  if (!response.ok)
    throw new Error(`Failed to load glTF buffer ${url.pathname}: ${response.status}`);
  return response.arrayBuffer();
}
