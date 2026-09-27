export const IMAGE_MIME_TYPES = [
  'image/jpeg',
] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
type RecognizedImageMimeType =
  | ImageMimeType
  | 'image/png'
  | 'image/webp';

const MIB = 1024 * 1024;

export const MAX_IMAGE_BYTES = 6 * MIB;
export const MAX_PDF_BYTES = 10 * MIB;
export const MAX_PDF_PAGES = 10;
export const MAX_CARD_OCR_CHARS = 4_000;
export const MAX_DOCUMENT_RAW_TEXT_CHARS = 256 * 1024;
export const MAX_DOCUMENT_ITEMS = 250;
export const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
export const MAX_IMAGE_SIDE = 2_600;
export const MAX_IMAGE_PIXELS = 8_000_000;
export const REQUEST_BODY_TIMEOUT_MS = 15_000;

const JSON_OVERHEAD_BYTES = 16 * 1024;

export const MAX_IMAGE_REQUEST_BYTES =
  Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + JSON_OVERHEAD_BYTES;
export const MAX_PDF_REQUEST_BYTES =
  Math.ceil(MAX_PDF_BYTES / 3) * 4 + JSON_OVERHEAD_BYTES;
export const MAX_CARD_REQUEST_BYTES = 16 * 1024;

export type RequestGuardErrorCode =
  | 'CONTENT_TYPE_REQUIRED'
  | 'CONTENT_ENCODING_UNSUPPORTED'
  | 'EMPTY_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'REQUEST_BODY_TIMEOUT'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'INVALID_BASE64'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MIME_TYPE'
  | 'MEDIA_SIGNATURE_MISMATCH'
  | 'PDF_INVALID'
  | 'PDF_PAGE_LIMIT_EXCEEDED';

export interface RequestGuardFailure {
  ok: false;
  status: number;
  errorCode: RequestGuardErrorCode;
}

export interface RequestGuardSuccess<T> {
  ok: true;
  value: T;
  payloadBytes?: number;
}

export type RequestGuardOutcome<T> =
  | RequestGuardSuccess<T>
  | RequestGuardFailure;

function failure(
  status: number,
  errorCode: RequestGuardErrorCode
): RequestGuardFailure {
  return { ok: false, status, errorCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateJsonRequestHeaders(
  request: Request
): RequestGuardFailure | null {
  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return failure(415, 'CONTENT_TYPE_REQUIRED');
  }

  const contentEncoding = request.headers
    .get('content-encoding')
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    return failure(415, 'CONTENT_ENCODING_UNSUPPORTED');
  }

  return null;
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number
): Promise<
  | { kind: 'read'; result: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'timeout' }
> {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return { kind: 'timeout' };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
  });
  const read = reader
    .read()
    .then((result) => ({ kind: 'read' as const, result }));
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readBoundedJsonObject(
  request: Request,
  maxBytes: number,
  timeoutMs = REQUEST_BODY_TIMEOUT_MS
): Promise<RequestGuardOutcome<Record<string, unknown>>> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) {
      return failure(400, 'INVALID_REQUEST');
    }
    if (Number(contentLength) > maxBytes) {
      return failure(413, 'PAYLOAD_TOO_LARGE');
    }
  }

  if (!request.body) return failure(400, 'EMPTY_PAYLOAD');

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let payloadBytes = 0;

  try {
    while (true) {
      const next = await readWithDeadline(reader, deadline);
      if (next.kind === 'timeout') {
        await reader.cancel().catch(() => undefined);
        return failure(408, 'REQUEST_BODY_TIMEOUT');
      }
      if (next.result.done) break;

      const chunk = next.result.value;
      payloadBytes += chunk.byteLength;
      if (payloadBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return failure(413, 'PAYLOAD_TOO_LARGE');
      }
      pieces.push(decoder.decode(chunk, { stream: true }));
    }
    pieces.push(decoder.decode());
  } catch {
    await reader.cancel().catch(() => undefined);
    return failure(400, 'INVALID_JSON');
  }

  if (payloadBytes === 0) return failure(400, 'EMPTY_PAYLOAD');

  let parsed: unknown;
  try {
    parsed = JSON.parse(pieces.join(''));
  } catch {
    return failure(400, 'INVALID_JSON');
  }
  if (!isRecord(parsed)) return failure(400, 'INVALID_REQUEST');

  return { ok: true, value: parsed, payloadBytes };
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isBase64AlphabetCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

function hasCanonicalBase64Shape(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64AlphabetCode(value.charCodeAt(index))) return false;
  }
  for (let index = dataEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

export function decodeStrictBase64(
  value: unknown,
  maxBytes: number
): RequestGuardOutcome<Uint8Array> {
  if (
    typeof value !== 'string' ||
    !hasCanonicalBase64Shape(value)
  ) {
    return failure(400, 'INVALID_BASE64');
  }

  const byteLength = decodedBase64Length(value);
  if (byteLength > maxBytes) return failure(413, 'FILE_TOO_LARGE');

  try {
    const binary = atob(value);
    if (
      binary.length !== byteLength ||
      btoa(binary) !== value
    ) {
      return failure(400, 'INVALID_BASE64');
    }
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { ok: true, value: bytes };
  } catch {
    return failure(400, 'INVALID_BASE64');
  }
}

function hasBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[]
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function isImageMimeType(value: unknown): value is ImageMimeType {
  return (
    typeof value === 'string' &&
    (IMAGE_MIME_TYPES as readonly string[]).includes(value)
  );
}

export function matchesImageSignature(
  bytes: Uint8Array,
  mimeType: RecognizedImageMimeType
): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return bytes.length >= 3 && hasBytes(bytes, 0, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return (
        bytes.length >= 8 &&
        hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
        hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
      );
  }
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

function hasChunkType(
  bytes: Uint8Array,
  offset: number,
  type: string
): boolean {
  return (
    type.length === 4 &&
    [...type].every(
      (character, index) =>
        bytes[offset + index] === character.charCodeAt(0)
    )
  );
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunkCrcIsValid(
  bytes: Uint8Array,
  offset: number,
  chunkLength: number
): boolean {
  const crcOffset = offset + 8 + chunkLength;
  return (
    crc32(bytes, offset + 4, crcOffset) ===
    readUint32BigEndian(bytes, crcOffset)
  );
}

function validPngHeader(bytes: Uint8Array, dataOffset: number): boolean {
  const width = readUint32BigEndian(bytes, dataOffset);
  const height = readUint32BigEndian(bytes, dataOffset + 4);
  const bitDepth = bytes[dataOffset + 8];
  const colorType = bytes[dataOffset + 9];
  const validBitDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return (
    width >= 1 &&
    height >= 1 &&
    width <= MAX_IMAGE_SIDE &&
    height <= MAX_IMAGE_SIDE &&
    width * height <= MAX_IMAGE_PIXELS &&
    !!validBitDepths[colorType]?.includes(bitDepth) &&
    bytes[dataOffset + 10] === 0 &&
    bytes[dataOffset + 11] === 0 &&
    (bytes[dataOffset + 12] === 0 || bytes[dataOffset + 12] === 1)
  );
}

function isStructurallyValidPng(bytes: Uint8Array): boolean {
  if (bytes.length < 45 || !matchesImageSignature(bytes, 'image/png')) {
    return false;
  }

  let offset = 8;
  let sawHeader = false;
  let sawPalette = false;
  let imageDataBytes = 0;
  let paletteRequired = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32BigEndian(bytes, offset);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkLength + 4;
    if (
      !Number.isSafeInteger(chunkLength) ||
      nextOffset > bytes.length
    ) {
      return false;
    }
    if (!pngChunkCrcIsValid(bytes, offset, chunkLength)) return false;

    if (!sawHeader) {
      if (
        !hasChunkType(bytes, offset + 4, 'IHDR') ||
        chunkLength !== 13 ||
        !validPngHeader(bytes, dataOffset)
      ) {
        return false;
      }
      paletteRequired = bytes[dataOffset + 9] === 3;
      sawHeader = true;
    } else if (hasChunkType(bytes, offset + 4, 'IHDR')) {
      return false;
    } else if (hasChunkType(bytes, offset + 4, 'PLTE')) {
      if (
        sawPalette ||
        imageDataBytes > 0 ||
        chunkLength === 0 ||
        chunkLength > 768 ||
        chunkLength % 3 !== 0
      ) {
        return false;
      }
      sawPalette = true;
    } else if (hasChunkType(bytes, offset + 4, 'IDAT')) {
      imageDataBytes += chunkLength;
    } else if (hasChunkType(bytes, offset + 4, 'IEND')) {
      return (
        chunkLength === 0 &&
        imageDataBytes > 0 &&
        (!paletteRequired || sawPalette) &&
        nextOffset === bytes.length
      );
    }

    offset = nextOffset;
  }
  return false;
}

interface JpegFrameComponent {
  quantizationTable: number;
}

interface JpegFrame {
  progressive: boolean;
  components: Map<number, JpegFrameComponent>;
}

function validateJpegQuantizationTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  tables: Set<number>
): boolean {
  let cursor = start;
  while (cursor < end) {
    const descriptor = bytes[cursor];
    const precision = descriptor >>> 4;
    const tableId = descriptor & 0x0f;
    if (precision > 1 || tableId > 3) return false;
    cursor += 1 + 64 * (precision + 1);
    if (cursor > end) return false;
    tables.add(tableId);
  }
  return cursor === end;
}

function validateJpegHuffmanTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  dcTables: Set<number>,
  acTables: Set<number>
): boolean {
  let cursor = start;
  while (cursor < end) {
    if (cursor + 17 > end) return false;
    const descriptor = bytes[cursor];
    const tableClass = descriptor >>> 4;
    const tableId = descriptor & 0x0f;
    if (tableClass > 1 || tableId > 3) return false;

    let symbolCount = 0;
    let availableCodes = 1;
    for (let index = 1; index <= 16; index += 1) {
      availableCodes = availableCodes * 2 - bytes[cursor + index];
      if (availableCodes < 0) return false;
      symbolCount += bytes[cursor + index];
    }
    if (
      symbolCount < 1 ||
      symbolCount > 256 ||
      cursor + 17 + symbolCount > end
    ) {
      return false;
    }

    const symbolsStart = cursor + 17;
    for (let index = 0; index < symbolCount; index += 1) {
      const symbol = bytes[symbolsStart + index];
      if (tableClass === 0) {
        if (symbol > 11) return false;
      } else {
        const coefficientBits = symbol & 0x0f;
        if (coefficientBits > 10) return false;
      }
    }

    (tableClass === 0 ? dcTables : acTables).add(tableId);
    cursor += 17 + symbolCount;
  }
  return cursor === end;
}

function parseJpegFrame(
  bytes: Uint8Array,
  marker: number,
  segmentOffset: number,
  segmentLength: number
): JpegFrame | null {
  if (marker !== 0xc0 && marker !== 0xc2) return null;
  const componentCount = bytes[segmentOffset + 7];
  const height =
    bytes[segmentOffset + 3] * 0x100 + bytes[segmentOffset + 4];
  const width =
    bytes[segmentOffset + 5] * 0x100 + bytes[segmentOffset + 6];
  if (
    bytes[segmentOffset + 2] !== 8 ||
    componentCount < 1 ||
    componentCount > 4 ||
    segmentLength !== 8 + componentCount * 3 ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    return null;
  }

  const components = new Map<number, JpegFrameComponent>();
  let samplingBlocks = 0;
  for (let index = 0; index < componentCount; index += 1) {
    const componentOffset = segmentOffset + 8 + index * 3;
    const componentId = bytes[componentOffset];
    const sampling = bytes[componentOffset + 1];
    const horizontalSampling = sampling >>> 4;
    const verticalSampling = sampling & 0x0f;
    const quantizationTable = bytes[componentOffset + 2];
    if (
      components.has(componentId) ||
      horizontalSampling < 1 ||
      horizontalSampling > 4 ||
      verticalSampling < 1 ||
      verticalSampling > 4 ||
      quantizationTable > 3
    ) {
      return null;
    }
    samplingBlocks += horizontalSampling * verticalSampling;
    components.set(componentId, { quantizationTable });
  }
  if (samplingBlocks > 10) return null;
  return { progressive: marker === 0xc2, components };
}

function validateJpegScanHeader(
  bytes: Uint8Array,
  segmentOffset: number,
  segmentLength: number,
  frame: JpegFrame,
  quantizationTables: Set<number>,
  dcTables: Set<number>,
  acTables: Set<number>,
  scannedComponents: Set<number>
): boolean {
  const scanComponentCount = bytes[segmentOffset + 2];
  if (
    scanComponentCount < 1 ||
    scanComponentCount > frame.components.size ||
    segmentLength !== 6 + scanComponentCount * 2
  ) {
    return false;
  }

  const spectralOffset =
    segmentOffset + 3 + scanComponentCount * 2;
  const spectralStart = bytes[spectralOffset];
  const spectralEnd = bytes[spectralOffset + 1];
  const approximation = bytes[spectralOffset + 2];
  const successiveHigh = approximation >>> 4;
  const successiveLow = approximation & 0x0f;
  if (
    frame.progressive &&
    !(
      spectralStart <= spectralEnd &&
      spectralEnd <= 63 &&
      (spectralStart !== 0 || spectralEnd === 0) &&
      (spectralStart === 0 || scanComponentCount === 1) &&
      successiveHigh <= 13 &&
      successiveLow <= 13 &&
      (successiveHigh === 0 || successiveHigh === successiveLow + 1)
    )
  ) {
    return false;
  }

  const needsDcTable = !frame.progressive || spectralStart === 0;
  const needsAcTable = !frame.progressive || spectralStart > 0;
  const currentComponents = new Set<number>();
  for (let index = 0; index < scanComponentCount; index += 1) {
    const componentOffset = segmentOffset + 3 + index * 2;
    const componentId = bytes[componentOffset];
    const tables = bytes[componentOffset + 1];
    const dcTable = tables >>> 4;
    const acTable = tables & 0x0f;
    const component = frame.components.get(componentId);
    if (
      !component ||
      currentComponents.has(componentId) ||
      !quantizationTables.has(component.quantizationTable) ||
      dcTable > 3 ||
      acTable > 3 ||
      (needsDcTable && !dcTables.has(dcTable)) ||
      (needsAcTable && !acTables.has(acTable))
    ) {
      return false;
    }
    currentComponents.add(componentId);
    scannedComponents.add(componentId);
  }

  if (!frame.progressive) {
    return (
      scanComponentCount === frame.components.size &&
      spectralStart === 0 &&
      spectralEnd === 63 &&
      approximation === 0
    );
  }

  return true;
}

function scanJpegEntropy(
  bytes: Uint8Array,
  start: number,
  restartInterval: number
): { nextMarkerOffset: number; sawEntropyByte: boolean } | null {
  let cursor = start;
  let sawEntropyByte = false;
  let expectedRestartMarker = 0xd0;
  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0xff) {
      sawEntropyByte = true;
      cursor += 1;
      continue;
    }

    const markerOffset = cursor;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) return null;
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 0x00) {
      sawEntropyByte = true;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (
        restartInterval === 0 ||
        marker !== expectedRestartMarker
      ) {
        return null;
      }
      expectedRestartMarker =
        marker === 0xd7 ? 0xd0 : marker + 1;
      continue;
    }
    return { nextMarkerOffset: markerOffset, sawEntropyByte };
  }
  return null;
}

function isStructurallyValidJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !matchesImageSignature(bytes, 'image/jpeg')) {
    return false;
  }

  const quantizationTables = new Set<number>();
  const dcTables = new Set<number>();
  const acTables = new Set<number>();
  const scannedComponents = new Set<number>();
  let frame: JpegFrame | null = null;
  let restartInterval = 0;
  let sawScan = false;
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9) {
      return (
        !!frame &&
        sawScan &&
        scannedComponents.size === frame.components.size &&
        offset === bytes.length
      );
    }
    if (
      marker === 0xd8 ||
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      return false;
    }
    if (offset + 2 > bytes.length) return false;

    const segmentLength = bytes[offset] * 0x100 + bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return false;
    }
    const dataStart = offset + 2;
    const segmentEnd = offset + segmentLength;

    if (marker === 0xdb) {
      if (
        !validateJpegQuantizationTables(
          bytes,
          dataStart,
          segmentEnd,
          quantizationTables
        )
      ) {
        return false;
      }
    } else if (marker === 0xc4) {
      if (
        !validateJpegHuffmanTables(
          bytes,
          dataStart,
          segmentEnd,
          dcTables,
          acTables
        )
      ) {
        return false;
      }
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (frame) return false;
      frame = parseJpegFrame(bytes, marker, offset, segmentLength);
      if (!frame) return false;
    } else if (marker === 0xdd) {
      if (segmentLength !== 4) return false;
      restartInterval = bytes[dataStart] * 0x100 + bytes[dataStart + 1];
    } else if (marker === 0xda) {
      if (
        !frame ||
        !validateJpegScanHeader(
          bytes,
          offset,
          segmentLength,
          frame,
          quantizationTables,
          dcTables,
          acTables,
          scannedComponents
        )
      ) {
        return false;
      }

      const entropy = scanJpegEntropy(
        bytes,
        segmentEnd,
        restartInterval
      );
      if (!entropy?.sawEntropyByte) return false;
      sawScan = true;
      offset = entropy.nextMarkerOffset;
      continue;
    }

    offset = segmentEnd;
  }
  return false;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000;
}

function validWebpVp8(
  bytes: Uint8Array,
  dataOffset: number,
  chunkLength: number
): boolean {
  if (
    chunkLength < 10 ||
    (bytes[dataOffset] & 1) !== 0 ||
    !hasBytes(bytes, dataOffset + 3, [0x9d, 0x01, 0x2a])
  ) {
    return false;
  }
  const width =
    (bytes[dataOffset + 6] + bytes[dataOffset + 7] * 0x100) & 0x3fff;
  const height =
    (bytes[dataOffset + 8] + bytes[dataOffset + 9] * 0x100) & 0x3fff;
  return (
    width >= 1 &&
    height >= 1 &&
    width <= MAX_IMAGE_SIDE &&
    height <= MAX_IMAGE_SIDE &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function validWebpVp8l(
  bytes: Uint8Array,
  dataOffset: number,
  chunkLength: number
): boolean {
  if (
    chunkLength < 5 ||
    bytes[dataOffset] !== 0x2f ||
    (bytes[dataOffset + 4] & 0xe0) !== 0
  ) {
    return false;
  }
  const packed = readUint32LittleEndian(bytes, dataOffset + 1);
  const width = (packed & 0x3fff) + 1;
  const height = ((packed >>> 14) & 0x3fff) + 1;
  return (
    width <= MAX_IMAGE_SIDE &&
    height <= MAX_IMAGE_SIDE &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function validWebpVp8x(
  bytes: Uint8Array,
  dataOffset: number,
  chunkLength: number
): boolean {
  if (
    chunkLength !== 10 ||
    (bytes[dataOffset] & 0xc1) !== 0 ||
    !hasBytes(bytes, dataOffset + 1, [0, 0, 0])
  ) {
    return false;
  }
  const width = readUint24LittleEndian(bytes, dataOffset + 4) + 1;
  const height = readUint24LittleEndian(bytes, dataOffset + 7) + 1;
  return (
    width <= MAX_IMAGE_SIDE &&
    height <= MAX_IMAGE_SIDE &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function validWebpImageChunk(
  bytes: Uint8Array,
  offset: number,
  availableBytes: number
): boolean {
  if (availableBytes < 8) return false;
  const chunkLength = readUint32LittleEndian(bytes, offset + 4);
  if (chunkLength + 8 > availableBytes) return false;
  if (hasChunkType(bytes, offset, 'VP8 ')) {
    return validWebpVp8(bytes, offset + 8, chunkLength);
  }
  if (hasChunkType(bytes, offset, 'VP8L')) {
    return validWebpVp8l(bytes, offset + 8, chunkLength);
  }
  return false;
}

function isStructurallyValidWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || !matchesImageSignature(bytes, 'image/webp')) {
    return false;
  }
  if (readUint32LittleEndian(bytes, 4) + 8 !== bytes.length) return false;

  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const chunkLength = readUint32LittleEndian(bytes, offset + 4);
    const paddedLength = chunkLength + (chunkLength % 2);
    const nextOffset = offset + 8 + paddedLength;
    if (
      !Number.isSafeInteger(chunkLength) ||
      nextOffset > bytes.length
    ) {
      return false;
    }
    const dataOffset = offset + 8;
    if (hasChunkType(bytes, offset, 'VP8 ')) {
      if (!validWebpVp8(bytes, dataOffset, chunkLength)) return false;
      sawImageChunk = true;
    } else if (hasChunkType(bytes, offset, 'VP8L')) {
      if (!validWebpVp8l(bytes, dataOffset, chunkLength)) return false;
      sawImageChunk = true;
    } else if (hasChunkType(bytes, offset, 'VP8X')) {
      if (!validWebpVp8x(bytes, dataOffset, chunkLength)) return false;
    } else if (hasChunkType(bytes, offset, 'ANMF')) {
      if (
        chunkLength < 24 ||
        !validWebpImageChunk(
          bytes,
          dataOffset + 16,
          chunkLength - 16
        )
      ) {
        return false;
      }
      sawImageChunk = true;
    }
    offset = nextOffset;
  }
  return sawImageChunk && offset === bytes.length;
}

export function isStructurallyValidImage(
  bytes: Uint8Array,
  mimeType: RecognizedImageMimeType
): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return isStructurallyValidJpeg(bytes);
    case 'image/png':
      return isStructurallyValidPng(bytes);
    case 'image/webp':
      return isStructurallyValidWebp(bytes);
  }
}

export function matchesPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    hasBytes(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])
  );
}

export interface PdfPageCounter {
  (bytes: Uint8Array): Promise<number>;
}

export async function validatePdfPageCount(
  bytes: Uint8Array,
  countPages: PdfPageCounter,
  maxPages = MAX_PDF_PAGES
): Promise<RequestGuardOutcome<number>> {
  if (!matchesPdfSignature(bytes)) {
    return failure(400, 'MEDIA_SIGNATURE_MISMATCH');
  }

  let pageCount: number;
  try {
    pageCount = await countPages(bytes);
  } catch {
    return failure(400, 'PDF_INVALID');
  }

  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return failure(400, 'PDF_INVALID');
  }
  if (pageCount > maxPages) {
    return failure(413, 'PDF_PAGE_LIMIT_EXCEEDED');
  }
  return { ok: true, value: pageCount };
}

export interface EdgeTrafficConfig {
  rateLimit: number;
  rateWindowMs: number;
  maxConcurrent: number;
  maxBuckets: number;
  leaseTtlSeconds: number;
}

export const DEFAULT_EDGE_TRAFFIC_CONFIG: EdgeTrafficConfig = {
  rateLimit: 10,
  rateWindowMs: 60_000,
  maxConcurrent: 3,
  maxBuckets: 2_048,
  leaseTtlSeconds: 55,
};

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export type EdgeEnvGetter = (name: string) => string | undefined;

export function edgeTrafficConfigFromEnv(
  getEnv: EdgeEnvGetter
): EdgeTrafficConfig {
  return {
    rateLimit: boundedInteger(
      getEnv('EDGE_RATE_LIMIT_MAX_REQUESTS'),
      DEFAULT_EDGE_TRAFFIC_CONFIG.rateLimit,
      1,
      1_000
    ),
    rateWindowMs: boundedInteger(
      getEnv('EDGE_RATE_LIMIT_WINDOW_MS'),
      DEFAULT_EDGE_TRAFFIC_CONFIG.rateWindowMs,
      1_000,
      5 * 60_000
    ),
    maxConcurrent: boundedInteger(
      getEnv('EDGE_MAX_CONCURRENT_REQUESTS'),
      DEFAULT_EDGE_TRAFFIC_CONFIG.maxConcurrent,
      1,
      50
    ),
    maxBuckets: DEFAULT_EDGE_TRAFFIC_CONFIG.maxBuckets,
    leaseTtlSeconds: boundedInteger(
      getEnv('EDGE_LEASE_TTL_SECONDS'),
      DEFAULT_EDGE_TRAFFIC_CONFIG.leaseTtlSeconds,
      30,
      90
    ),
  };
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

function ephemeralSalt(): string {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16)).join('');
}

function hashTechnicalKey(value: string, salt: string): string {
  let hash = 0x811c9dc5;
  const source = `${salt}:${value}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function technicalRequestSource(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const forwardedValues = forwarded
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const source =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    forwardedValues?.[forwardedValues.length - 1] ??
    'unattributed';
  return source.slice(0, 128);
}

export type EdgeTrafficAdmission =
  | {
      allowed: true;
      release: () => Promise<void>;
    }
  | {
      allowed: false;
      reason:
        | 'rate_limited'
        | 'concurrency_limited'
        | 'security_unavailable';
      retryAfterSeconds: number;
    };

export interface EdgeTrafficControl {
  enter(request: Request): Promise<EdgeTrafficAdmission>;
}

export interface InMemoryEdgeTrafficControl extends EdgeTrafficControl {
  consume(
    request: Request,
    now?: number
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number };
  tryAcquire(): (() => void) | null;
  activeCount(): number;
  bucketCount(): number;
}

export function createEdgeTrafficControl(
  config: EdgeTrafficConfig,
  options: { salt?: string } = {}
): InMemoryEdgeTrafficControl {
  const buckets = new Map<string, RateBucket>();
  const salt = options.salt ?? ephemeralSalt();
  let active = 0;

  const pruneExpired = (now: number) => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStartedAt >= config.rateWindowMs) {
        buckets.delete(key);
      }
    }
  };

  return {
    async enter(request) {
      const rate = this.consume(request);
      if (!rate.allowed) {
        return {
          allowed: false,
          reason: 'rate_limited',
          retryAfterSeconds: rate.retryAfterSeconds,
        };
      }
      const release = this.tryAcquire();
      if (!release) {
        return {
          allowed: false,
          reason: 'concurrency_limited',
          retryAfterSeconds: 1,
        };
      }
      return {
        allowed: true,
        release: async () => release(),
      };
    },

    consume(request, now = Date.now()) {
      if (buckets.size >= config.maxBuckets) pruneExpired(now);

      let key = hashTechnicalKey(technicalRequestSource(request), salt);
      if (!buckets.has(key) && buckets.size >= config.maxBuckets) {
        key = 'overflow';
      }

      const current = buckets.get(key);
      if (
        !current ||
        now - current.windowStartedAt >= config.rateWindowMs
      ) {
        buckets.set(key, { windowStartedAt: now, count: 1 });
        return { allowed: true };
      }

      if (current.count >= config.rateLimit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (config.rateWindowMs - (now - current.windowStartedAt)) / 1_000
            )
          ),
        };
      }

      current.count += 1;
      return { allowed: true };
    },

    tryAcquire() {
      if (active >= config.maxConcurrent) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },

    activeCount: () => active,
    bucketCount: () => buckets.size,
  };
}

export interface DatabaseTrafficAcquireParams {
  scope: string;
  fingerprint: string;
  rateLimit: number;
  windowSeconds: number;
  maxConcurrent: number;
  leaseSeconds: number;
}

export interface DatabaseEdgeTrafficOptions {
  fingerprintSalt: string | undefined;
  acquire(
    params: DatabaseTrafficAcquireParams
  ): Promise<unknown>;
  release(leaseId: string): Promise<void>;
  onError?(stage: 'acquire' | 'release'): void;
  scope?: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

async function hmacTechnicalSource(
  request: Request,
  salt: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(technicalRequestSource(request))
  );
  return bytesToHex(digest);
}

function singleRpcRow(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

/**
 * Gate di produzione distribuito. L'atomicità effettiva è fornita dalle RPC
 * PostgreSQL della migrazione 005; questo adapter non usa stato per-isolate.
 */
export function createDatabaseEdgeTrafficControl(
  config: EdgeTrafficConfig,
  options: DatabaseEdgeTrafficOptions
): EdgeTrafficControl {
  const salt = options.fingerprintSalt?.trim();
  const scope = options.scope ?? 'gemini';

  return {
    async enter(request) {
      if (!salt || salt.length < 32) {
        options.onError?.('acquire');
        return {
          allowed: false,
          reason: 'security_unavailable',
          retryAfterSeconds: 1,
        };
      }

      let row: Record<string, unknown> | null;
      try {
        const fingerprint = await hmacTechnicalSource(request, salt);
        row = singleRpcRow(
          await options.acquire({
            scope,
            fingerprint,
            rateLimit: config.rateLimit,
            windowSeconds: Math.ceil(config.rateWindowMs / 1_000),
            maxConcurrent: config.maxConcurrent,
            leaseSeconds: config.leaseTtlSeconds,
          })
        );
      } catch {
        options.onError?.('acquire');
        return {
          allowed: false,
          reason: 'security_unavailable',
          retryAfterSeconds: 1,
        };
      }

      if (!row || typeof row.allowed !== 'boolean') {
        options.onError?.('acquire');
        return {
          allowed: false,
          reason: 'security_unavailable',
          retryAfterSeconds: 1,
        };
      }

      const retryAfterSeconds =
        typeof row.retry_after_seconds === 'number' &&
        Number.isInteger(row.retry_after_seconds) &&
        row.retry_after_seconds >= 1 &&
        row.retry_after_seconds <= 300
          ? row.retry_after_seconds
          : 1;

      if (!row.allowed) {
        return {
          allowed: false,
          reason:
            row.reason === 'rate_limited'
              ? 'rate_limited'
              : row.reason === 'concurrency_limited'
                ? 'concurrency_limited'
                : 'security_unavailable',
          retryAfterSeconds,
        };
      }

      if (
        typeof row.lease_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.lease_id
        )
      ) {
        options.onError?.('acquire');
        return {
          allowed: false,
          reason: 'security_unavailable',
          retryAfterSeconds: 1,
        };
      }

      const leaseId = row.lease_id;
      let released = false;
      return {
        allowed: true,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await options.release(leaseId);
          } catch {
            options.onError?.('release');
          }
        },
      };
    },
  };
}
