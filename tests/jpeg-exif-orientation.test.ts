import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readJpegExifOrientation,
  setJpegExifOrientation,
} from '../lib/jpeg-exif-orientation';

function writeU16(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
  } else {
    bytes[offset] = (value >> 8) & 0xff;
    bytes[offset + 1] = value & 0xff;
  }
}

function writeU32(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
    bytes[offset + 3] = (value >> 24) & 0xff;
  } else {
    bytes[offset] = (value >> 24) & 0xff;
    bytes[offset + 1] = (value >> 16) & 0xff;
    bytes[offset + 2] = (value >> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }
}

function jpegWithExifOrientation(orientation: number): Uint8Array {
  const tiffBytes = 8 + 2 + 12 + 4;
  const app1Size = 2 + 6 + tiffBytes;
  const bytes = new Uint8Array(2 + 2 + app1Size + 2);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe1;
  writeU16(bytes, 4, app1Size, false);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);
  const tiff = 12;
  bytes[tiff] = 0x49;
  bytes[tiff + 1] = 0x49;
  writeU16(bytes, tiff + 2, 0x002a, true);
  writeU32(bytes, tiff + 4, 8, true);
  const ifd0 = tiff + 8;
  writeU16(bytes, ifd0, 1, true);
  writeU16(bytes, ifd0 + 2, 0x0112, true);
  writeU16(bytes, ifd0 + 4, 3, true);
  writeU32(bytes, ifd0 + 6, 1, true);
  writeU16(bytes, ifd0 + 10, orientation, true);
  writeU32(bytes, ifd0 + 14, 0, true);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

test('legge Orientation TIFF 3 dal JPEG', () => {
  assert.equal(readJpegExifOrientation(jpegWithExifOrientation(3)), 3);
});

test('riscrive Orientation a 1 senza toccare i marker JPEG', () => {
  const original = jpegWithExifOrientation(3);
  const before = Uint8Array.from(original);
  const rewritten = setJpegExifOrientation(original, 1);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.previous, 3);
  assert.equal(readJpegExifOrientation(rewritten.bytes), 1);
  assert.deepEqual(original, before);
  assert.equal(rewritten.bytes[0], 0xff);
  assert.equal(rewritten.bytes[1], 0xd8);
});

test('Orientation 1 non viene riscritta', () => {
  const original = jpegWithExifOrientation(1);
  const rewritten = setJpegExifOrientation(original, 1);
  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.bytes, original);
});
