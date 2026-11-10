export class BinaryReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private cursor = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get offset(): number {
    return this.cursor;
  }

  get remaining(): number {
    return this.view.byteLength - this.cursor;
  }

  ensure(length: number, context: string): void {
    if (length < 0 || this.cursor + length > this.view.byteLength) {
      throw new Error(`Unexpected end of map while reading ${context} at byte ${this.cursor}.`);
    }
  }

  skip(length: number, context: string): void {
    this.ensure(length, context);
    this.cursor += length;
  }

  uint8(context = "byte"): number {
    this.ensure(1, context);
    return this.view.getUint8(this.cursor++);
  }

  uint16(context = "16-bit value"): number {
    this.ensure(2, context);
    const result = this.view.getUint16(this.cursor, true);
    this.cursor += 2;
    return result;
  }

  int16(context = "signed 16-bit value"): number {
    this.ensure(2, context);
    const result = this.view.getInt16(this.cursor, true);
    this.cursor += 2;
    return result;
  }

  int32(context = "signed 32-bit value"): number {
    this.ensure(4, context);
    const result = this.view.getInt32(this.cursor, true);
    this.cursor += 4;
    return result;
  }

  float32(context = "float"): number {
    this.ensure(4, context);
    const result = this.view.getFloat32(this.cursor, true);
    this.cursor += 4;
    return result;
  }

  byteArray(length: number, context = "bytes"): Uint8Array {
    this.ensure(length, context);
    const result = this.bytes.slice(this.cursor, this.cursor + length);
    this.cursor += length;
    return result;
  }

  text(length: number, context = "text"): string {
    return new TextDecoder().decode(this.byteArray(length, context));
  }
}
