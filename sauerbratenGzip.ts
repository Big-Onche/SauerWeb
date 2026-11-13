import zlib from "node:zlib";

export function normalizeSauerbratenGzip(compressed: Buffer): Buffer {
  return zlib.gzipSync(zlib.inflateRawSync(compressed.subarray(gzipPayloadOffset(compressed))));
}

function gzipPayloadOffset(compressed: Buffer): number {
  if (compressed.length < 10 || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8) {
    throw new Error("Invalid Sauerbraten gzip header.");
  }
  const flags = compressed[3];
  if (flags & 0xe0) throw new Error("Invalid Sauerbraten gzip flags.");
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > compressed.length) throw new Error("Truncated Sauerbraten gzip extra field.");
    const length = compressed.readUInt16LE(offset);
    offset += 2 + length;
  }
  if (flags & 0x08) offset = skipTerminatedField(compressed, offset, "filename");
  if (flags & 0x10) offset = skipTerminatedField(compressed, offset, "comment");
  if (flags & 0x02) offset += 2;
  if (offset > compressed.length) throw new Error("Truncated Sauerbraten gzip header.");
  return offset;
}

function skipTerminatedField(compressed: Buffer, offset: number, field: string): number {
  const terminator = compressed.indexOf(0, offset);
  if (terminator < 0) throw new Error(`Unterminated Sauerbraten gzip ${field}.`);
  return terminator + 1;
}
