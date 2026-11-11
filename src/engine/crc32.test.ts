import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32";

describe("Sauerbraten map CRC", () => {
  it("matches the zlib CRC-32 used by gzstream", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
