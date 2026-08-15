import * as THREE from "three/webgpu";

export type RasterizedSvg = {
  texture: THREE.DataTexture;
  pixels: Uint8Array;
  size: number;
};

export async function rasterizeSvgToTexture(
  svgString: string,
  size: number,
): Promise<RasterizedSvg> {
  const blob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to decode SVG image"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");

    // Stretch the SVG to fill the square texture. The mask shader pairs
    // this with a matching-aspect placeholder in the DOM, so the double
    // transform (SVG stretched into texture, then sampled into the
    // placeholder rect) cancels out and the SVG renders at its true
    // aspect on-screen.
    ctx.drawImage(img, 0, 0, size, size);

    const imageData = ctx.getImageData(0, 0, size, size);

    // Flip Y here so layout coordinates can remain top-origin in the shader.
    const pixels = new Uint8Array(size * size * 4);
    const rowBytes = size * 4;
    for (let y = 0; y < size; y++) {
      const srcOffset = (size - 1 - y) * rowBytes;
      pixels.set(imageData.data.subarray(srcOffset, srcOffset + rowBytes), y * rowBytes);
    }

    const texture = new THREE.DataTexture(
      pixels,
      size,
      size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    return { texture, pixels, size };
  } finally {
    URL.revokeObjectURL(url);
  }
}
