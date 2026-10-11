/**
 * A PNG signature and IHDR chunk for the given dimensions, padded with
 * `paddingBytes` of zeros to model a realistic payload size.
 */
export function pngBytes(width: number, height: number, paddingBytes = 0): Buffer {
  const header = Buffer.alloc(24 + paddingBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}
