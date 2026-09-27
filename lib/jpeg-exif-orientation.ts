/** JPEG EXIF Orientation (TIFF tag 0x0112) without decoding pixels. */

const JPEG_SOI = 0xffd8;
const MARKER_APP1 = 0xffe1;
const TIFF_ORIENTATION_TAG = 0x0112;

function readU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function writeU16(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
  } else {
    bytes[offset] = (value >> 8) & 0xff;
    bytes[offset + 1] = value & 0xff;
  }
}

function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
    : (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function findExifApp1(bytes: Uint8Array): { start: number; payload: number } | null {
  if (bytes.length < 4 || readU16(bytes, 0, false) !== JPEG_SOI) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = (bytes[offset] << 8) | bytes[offset + 1];
    if (marker === 0xffda || marker === 0xffd9) return null;
    const size = readU16(bytes, offset + 2, false);
    if (size < 2 || offset + 2 + size > bytes.length) return null;
    if (marker === MARKER_APP1) {
      const payload = offset + 4;
      if (
        bytes[payload] === 0x45 &&
        bytes[payload + 1] === 0x78 &&
        bytes[payload + 2] === 0x69 &&
        bytes[payload + 3] === 0x66 &&
        bytes[payload + 4] === 0x00 &&
        bytes[payload + 5] === 0x00
      ) {
        return { start: offset, payload };
      }
    }
    offset += 2 + size;
  }
  return null;
}

function visitOrientationTag(
  bytes: Uint8Array,
  visitor: (offset: number, littleEndian: boolean, current: number) => void,
): boolean {
  const app1 = findExifApp1(bytes);
  if (!app1) return false;
  const tiff = app1.payload + 6;
  if (tiff + 8 > bytes.length) return false;
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const motorola = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!littleEndian && !motorola) return false;
  if (readU16(bytes, tiff + 2, littleEndian) !== 0x002a) return false;
  const ifd0 = tiff + readU32(bytes, tiff + 4, littleEndian);
  if (ifd0 + 2 > bytes.length) return false;
  const count = readU16(bytes, ifd0, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd0 + 2 + index * 12;
    if (entry + 12 > bytes.length) return false;
    if (readU16(bytes, entry, littleEndian) !== TIFF_ORIENTATION_TAG) continue;
    const type = readU16(bytes, entry + 2, littleEndian);
    const values = readU32(bytes, entry + 4, littleEndian);
    if (type !== 3 || values !== 1) return false;
    visitor(entry + 8, littleEndian, readU16(bytes, entry + 8, littleEndian));
    return true;
  }
  return false;
}

export function readJpegExifOrientation(bytes: Uint8Array): number | null {
  let value: number | null = null;
  visitOrientationTag(bytes, (_offset, _endian, current) => {
    value = current;
  });
  return value;
}

/** Rewrite Orientation to 1. Pixels are not rotated. Returns a copy when changed. */
export function setJpegExifOrientation(
  bytes: Uint8Array,
  orientation: number,
): { bytes: Uint8Array; changed: boolean; previous: number | null } {
  const previous = readJpegExifOrientation(bytes);
  if (previous === orientation) {
    return { bytes, changed: false, previous };
  }
  const copy = Uint8Array.from(bytes);
  const updated = visitOrientationTag(copy, (offset, littleEndian) => {
    writeU16(copy, offset, orientation, littleEndian);
  });
  if (!updated) {
    return { bytes, changed: false, previous };
  }
  return { bytes: copy, changed: true, previous };
}
