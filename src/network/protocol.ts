const textEncoder = new TextEncoder();

// Original: src/shared/tools.cpp
// Functions: putint(), putuint(), sendstring(), getint(), getuint(), getstring()
// Sauerbraten reference: SVN r6488
export class PacketWriter {
  private readonly bytes: number[] = [];

  putByte(value: number): this {
    this.bytes.push(value & 0xFF);
    return this;
  }

  putBytes(values: Uint8Array): this {
    for (const value of values) this.bytes.push(value);
    return this;
  }

  putInt(value: number): this {
    value |= 0;
    if (value < 128 && value > -127) this.putByte(value);
    else if (value < 0x8000 && value >= -0x8000) {
      this.putByte(0x80).putByte(value).putByte(value >> 8);
    } else {
      this.putByte(0x81).putByte(value).putByte(value >> 8).putByte(value >> 16).putByte(value >> 24);
    }
    return this;
  }

  putUInt(value: number): this {
    value |= 0;
    if (value < 0 || value >= (1 << 21)) {
      this.putByte(0x80 | (value & 0x7F)).putByte(0x80 | ((value >> 7) & 0x7F))
        .putByte(0x80 | ((value >> 14) & 0x7F)).putByte(value >> 21);
    } else if (value < (1 << 7)) this.putByte(value);
    else if (value < (1 << 14)) this.putByte(0x80 | (value & 0x7F)).putByte(value >> 7);
    else this.putByte(0x80 | (value & 0x7F)).putByte(0x80 | ((value >> 7) & 0x7F)).putByte(value >> 14);
    return this;
  }

  putString(value: string): this {
    for (const byte of textEncoder.encode(value)) this.putInt(byte);
    return this.putInt(0);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export class PacketReader {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number { return this.bytes.length - this.offset; }

  getByte(): number {
    if (!this.remaining) throw new RangeError("Unexpected end of Sauerbraten packet.");
    return this.bytes[this.offset++];
  }

  getInt(): number {
    const marker = this.getByte() << 24 >> 24;
    if (marker === -128) return (this.getByte() | ((this.getByte() << 24 >> 24) << 8)) << 16 >> 16;
    if (marker === -127) {
      return (this.getByte() | (this.getByte() << 8) | (this.getByte() << 16) | (this.getByte() << 24)) | 0;
    }
    return marker;
  }

  getUInt(): number {
    let value = this.getByte();
    if (value & 0x80) {
      value += (this.getByte() << 7) - 0x80;
      if (value & (1 << 14)) value += (this.getByte() << 14) - (1 << 14);
      if (value & (1 << 21)) value += (this.getByte() << 21) - (1 << 21);
      if (value & (1 << 28)) value |= ~0 << 28;
    }
    return value | 0;
  }

  getString(maximumBytes = 260): string {
    const bytes: number[] = [];
    while (this.remaining) {
      const value = this.getInt();
      if (!value) break;
      if (bytes.length < maximumBytes - 1) bytes.push(value & 0xFF);
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }

  subReader(length: number): PacketReader {
    if (length < 0 || length > this.remaining) throw new RangeError("Invalid Sauerbraten packet sub-buffer length.");
    const reader = new PacketReader(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return reader;
  }
}
