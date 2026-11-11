import { describe, expect, it } from "vitest";
import { PacketReader, PacketWriter } from "./protocol";

describe("Sauerbraten protocol serialization", () => {
  it("round-trips native signed integer boundaries", () => {
    const values = [-2147483648, -32769, -32768, -127, -126, -1, 0, 127, 128, 32767, 32768, 2147483647];
    const reader = new PacketReader(values.reduce((writer, value) => writer.putInt(value), new PacketWriter()).finish());
    expect(values.map(() => reader.getInt())).toEqual(values);
  });

  it("round-trips native variable unsigned integers and strings", () => {
    const values = [-1, 0, 127, 128, 16383, 16384, 1 << 21, 0x0FFFFFFF];
    const writer = values.reduce((packet, value) => packet.putUInt(value), new PacketWriter()).putString("Sauerbräten");
    const reader = new PacketReader(writer.finish());
    expect(values.map(() => reader.getUInt())).toEqual(values);
    expect(reader.getString()).toBe("Sauerbräten");
  });
});
