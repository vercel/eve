export async function readDynamicImportMarker() {
  const { marker } = await import("./marker.js");
  return marker;
}
