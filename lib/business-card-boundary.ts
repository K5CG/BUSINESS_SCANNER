export interface BusinessCardBoundaryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BusinessCardBoundaryDetection {
  rect: BusinessCardBoundaryRect;
  confidence: number;
  edgeScores: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  areaRatio: number;
}

const OUTER_SEARCH_MIN = 0.015;
const OUTER_SEARCH_MAX = 0.32;
const MIN_EDGE_STRENGTH = 8;
const MIN_EDGE_PROMINENCE = 2.15;
const MIN_REFINED_AREA_RATIO = 0.5;
const MAX_REFINED_AREA_RATIO = 0.94;
const MAX_REFINED_CENTER_OFFSET = 0.12;
const PROFILE_SMOOTH_RADIUS = 2;

function mean(values: Float32Array, start: number, end: number): number {
  let total = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    total += values[i];
    count++;
  }
  return count > 0 ? total / count : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function smoothProfile(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - PROFILE_SMOOTH_RADIUS);
    const end = Math.min(values.length, i + PROFILE_SMOOTH_RADIUS + 1);
    out[i] = mean(values, start, end);
  }
  return out;
}

function buildRowEdgeProfile(gray: Uint8Array, width: number, height: number): Float32Array {
  const profile = new Float32Array(Math.max(0, height - 1));
  const trim = Math.max(2, Math.floor(width * 0.06));
  const xStart = trim;
  const xEnd = Math.max(xStart + 1, width - trim);
  for (let y = 0; y < height - 1; y++) {
    let total = 0;
    for (let x = xStart; x < xEnd; x++) {
      const top = gray[y * width + x];
      const bottom = gray[(y + 1) * width + x];
      total += Math.abs(bottom - top);
    }
    profile[y] = total / Math.max(1, xEnd - xStart);
  }
  return profile;
}

function buildColumnEdgeProfile(gray: Uint8Array, width: number, height: number): Float32Array {
  const profile = new Float32Array(Math.max(0, width - 1));
  const trim = Math.max(2, Math.floor(height * 0.06));
  const yStart = trim;
  const yEnd = Math.max(yStart + 1, height - trim);
  for (let x = 0; x < width - 1; x++) {
    let total = 0;
    for (let y = yStart; y < yEnd; y++) {
      const left = gray[y * width + x];
      const right = gray[y * width + x + 1];
      total += Math.abs(right - left);
    }
    profile[x] = total / Math.max(1, yEnd - yStart);
  }
  return profile;
}

interface EdgeCandidate {
  index: number;
  strength: number;
  prominence: number;
}

function strongestCandidate(
  rawProfile: Float32Array,
  startFraction: number,
  endFraction: number,
): EdgeCandidate | null {
  const profile = smoothProfile(rawProfile);
  if (profile.length < 8) return null;
  const start = Math.max(0, Math.floor(profile.length * startFraction));
  const end = Math.min(profile.length, Math.ceil(profile.length * endFraction));
  if (end - start < 3) return null;

  let bestIndex = start;
  let bestStrength = -Infinity;
  const values: number[] = [];
  for (let i = start; i < end; i++) {
    const value = profile[i];
    values.push(value);
    if (value > bestStrength) {
      bestStrength = value;
      bestIndex = i;
    }
  }
  const baseline = median(values);

  // The smoothing window can shift a sharp physical edge by a few pixels
  // (especially on a clean light/dark rectangle). Re-anchor the candidate
  // to the strongest raw transition close to the smoothed peak so crop
  // coordinates follow the actual card edge rather than the filter window.
  const refineStart = Math.max(start, bestIndex - PROFILE_SMOOTH_RADIUS - 1);
  const refineEnd = Math.min(end, bestIndex + PROFILE_SMOOTH_RADIUS + 2);
  let refinedIndex = bestIndex;
  let refinedStrength = -Infinity;
  for (let i = refineStart; i < refineEnd; i++) {
    const value = rawProfile[i];
    if (value > refinedStrength) {
      refinedStrength = value;
      refinedIndex = i;
    }
  }

  return {
    index: refinedIndex,
    strength: refinedStrength,
    prominence: refinedStrength / Math.max(1, baseline),
  };
}

function candidateIsStrong(candidate: EdgeCandidate | null): candidate is EdgeCandidate {
  return !!candidate &&
    candidate.strength >= MIN_EDGE_STRENGTH &&
    candidate.prominence >= MIN_EDGE_PROMINENCE;
}

/**
 * Rileva un grande rettangolo fisico già quasi allineato alla cornice camera.
 * Non usa colore della carta, testo, lingua o rapporti standard dei biglietti.
 * Se i quattro bordi non sono dimostrabili, fallisce chiuso restituendo null.
 */
export function detectBusinessCardBoundaryFromGray(
  gray: Uint8Array,
  width: number,
  height: number,
): BusinessCardBoundaryDetection | null {
  if (width < 80 || height < 50 || gray.length < width * height) return null;

  const rows = buildRowEdgeProfile(gray, width, height);
  const columns = buildColumnEdgeProfile(gray, width, height);

  const top = strongestCandidate(rows, OUTER_SEARCH_MIN, OUTER_SEARCH_MAX);
  const bottom = strongestCandidate(rows, 1 - OUTER_SEARCH_MAX, 1 - OUTER_SEARCH_MIN);
  const left = strongestCandidate(columns, OUTER_SEARCH_MIN, OUTER_SEARCH_MAX);
  const right = strongestCandidate(columns, 1 - OUTER_SEARCH_MAX, 1 - OUTER_SEARCH_MIN);

  if (
    !candidateIsStrong(top) ||
    !candidateIsStrong(bottom) ||
    !candidateIsStrong(left) ||
    !candidateIsStrong(right)
  ) {
    return null;
  }

  // Un piccolo inset fisico evita che il bordo del piano di appoggio resti
  // dentro il crop. 0.7% e ancora molto conservativo rispetto al contenuto.
  const inset = Math.max(1, Math.round(Math.min(width, height) * 0.007));
  const x1 = Math.min(width - 2, left.index + 1 + inset);
  const y1 = Math.min(height - 2, top.index + 1 + inset);
  const x2 = Math.max(x1 + 1, right.index - inset);
  const y2 = Math.max(y1 + 1, bottom.index - inset);
  const rectWidth = x2 - x1;
  const rectHeight = y2 - y1;
  if (rectWidth <= 0 || rectHeight <= 0) return null;

  const areaRatio = (rectWidth * rectHeight) / (width * height);
  if (areaRatio < MIN_REFINED_AREA_RATIO || areaRatio > MAX_REFINED_AREA_RATIO) {
    return null;
  }

  // Il cartoncino viene inquadrato dentro una cornice centrata. Un rettangolo
  // fisico fortemente decentrato e spesso una linea del tappetino/sfondo:
  // in quel caso il refinement deve fallire chiuso e lasciare intatto il crop
  // overlay gia verificato, invece di tagliare il biglietto.
  const centerOffsetX = Math.abs(x1 + rectWidth / 2 - width / 2) / width;
  const centerOffsetY = Math.abs(y1 + rectHeight / 2 - height / 2) / height;
  if (centerOffsetX > MAX_REFINED_CENTER_OFFSET || centerOffsetY > MAX_REFINED_CENTER_OFFSET) {
    return null;
  }

  const normalizedProminence = Math.min(
    top.prominence,
    right.prominence,
    bottom.prominence,
    left.prominence,
  );
  const normalizedStrength = Math.min(
    top.strength,
    right.strength,
    bottom.strength,
    left.strength,
  );
  const confidence = Math.min(
    1,
    0.5 * Math.min(1, normalizedProminence / 4) +
      0.5 * Math.min(1, normalizedStrength / 24),
  );

  return {
    rect: { x: x1, y: y1, width: rectWidth, height: rectHeight },
    confidence,
    edgeScores: {
      top: top.strength,
      right: right.strength,
      bottom: bottom.strength,
      left: left.strength,
    },
    areaRatio,
  };
}


export interface BusinessCardForegroundDetection {
  rect: BusinessCardBoundaryRect;
  confidence: number;
  areaRatio: number;
  foregroundRatio: number;
  density: number;
  /** Block mask of the dominant physical support, used only for irregular-card OCR masking. */
  /** Bounding-box stretto prima del padding di sicurezza. */
  tightRect?: BusinessCardBoundaryRect;
  mask?: {
    cells: Uint8Array;
    gridWidth: number;
    gridHeight: number;
    blockSize: number;
  };
}

const FOREGROUND_BLOCK = 6;
const FOREGROUND_CORNER_FRACTION = 0.12;
const FOREGROUND_CORNER_CLUSTER_DISTANCE = 70;
const FOREGROUND_MIN_DISTANCE = 28;
const FOREGROUND_MAX_DISTANCE = 115;
const FOREGROUND_MIN_BBOX_AREA_RATIO = 0.25;
const FOREGROUND_MAX_BBOX_AREA_RATIO = 0.96;
const FOREGROUND_MIN_COMPONENT_RATIO = 0.12;
const FOREGROUND_MIN_DENSITY = 0.45;
const FOREGROUND_MIN_SPAN_RATIO = 0.35;
const FOREGROUND_MAX_CENTER_OFFSET = 0.2;

interface RgbPoint {
  r: number;
  g: number;
  b: number;
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function rgbDistance(a: RgbPoint, b: RgbPoint): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function nearestColorDistance(point: RgbPoint, references: RgbPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const reference of references) {
    best = Math.min(best, rgbDistance(point, reference));
  }
  return best;
}

function erodeForegroundMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!mask[(y + dy) * width + (x + dx)]) { keep = 0; break; }
        }
      }
      if (keep) out[y * width + x] = 1;
    }
  }
  return out;
}

function dilateForegroundMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            out[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

function openForegroundMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  return dilateForegroundMask(erodeForegroundMask(mask, width, height), width, height);
}

/**
 * Fallback open-set per supporti non rettangolari o con rapporto non standard.
 * Stima il colore dello sfondo dai quattro angoli del crop gia verificato,
 * lavora su blocchi medi per non inseguire la texture del piano di appoggio e
 * restituisce solo il bounding-box del foreground dominante. Se l'evidenza
 * non e forte ritorna null: il chiamante conserva il crop overlay esistente.
 */
export function detectBusinessCardForegroundBoundsFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): BusinessCardForegroundDetection | null {
  if (width < 80 || height < 50 || rgba.length < width * height * 4) return null;

  const block = FOREGROUND_BLOCK;
  const gridWidth = Math.ceil(width / block);
  const gridHeight = Math.ceil(height / block);
  const grid: RgbPoint[] = new Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy++) {
    const y0 = gy * block;
    const y1 = Math.min(height, y0 + block);
    for (let gx = 0; gx < gridWidth; gx++) {
      const x0 = gx * block;
      const x1 = Math.min(width, x0 + block);
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        let offset = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++) {
          r += rgba[offset];
          g += rgba[offset + 1];
          b += rgba[offset + 2];
          count++;
          offset += 4;
        }
      }
      grid[gy * gridWidth + gx] = {
        r: r / Math.max(1, count),
        g: g / Math.max(1, count),
        b: b / Math.max(1, count),
      };
    }
  }

  const cornerWidth = Math.max(2, Math.ceil(gridWidth * FOREGROUND_CORNER_FRACTION));
  const cornerHeight = Math.max(2, Math.ceil(gridHeight * FOREGROUND_CORNER_FRACTION));
  const cornerRanges = [
    { x0: 0, x1: cornerWidth, y0: 0, y1: cornerHeight },
    { x0: gridWidth - cornerWidth, x1: gridWidth, y0: 0, y1: cornerHeight },
    { x0: 0, x1: cornerWidth, y0: gridHeight - cornerHeight, y1: gridHeight },
    { x0: gridWidth - cornerWidth, x1: gridWidth, y0: gridHeight - cornerHeight, y1: gridHeight },
  ];

  const cornerMedians: RgbPoint[] = cornerRanges.map((range) => {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let gy = range.y0; gy < range.y1; gy++) {
      for (let gx = range.x0; gx < range.x1; gx++) {
        const point = grid[gy * gridWidth + gx];
        rs.push(point.r);
        gs.push(point.g);
        bs.push(point.b);
      }
    }
    return { r: medianNumber(rs), g: medianNumber(gs), b: medianNumber(bs) };
  });

  let medoid = 0;
  let bestDistanceSum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cornerMedians.length; i++) {
    let sum = 0;
    for (let j = 0; j < cornerMedians.length; j++) {
      sum += rgbDistance(cornerMedians[i], cornerMedians[j]);
    }
    if (sum < bestDistanceSum) {
      bestDistanceSum = sum;
      medoid = i;
    }
  }

  const backgroundReferences = cornerMedians.filter(
    (candidate) => rgbDistance(candidate, cornerMedians[medoid]) <= FOREGROUND_CORNER_CLUSTER_DISTANCE,
  );
  if (backgroundReferences.length < 2) return null;

  const borderDistances: number[] = [];
  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      if (gy >= 2 && gy < gridHeight - 2 && gx >= 2 && gx < gridWidth - 2) continue;
      borderDistances.push(nearestColorDistance(grid[gy * gridWidth + gx], backgroundReferences));
    }
  }
  if (borderDistances.length === 0) return null;

  const borderMedian = medianNumber(borderDistances);
  const borderMad = medianNumber(borderDistances.map((value) => Math.abs(value - borderMedian)));
  const p95 = percentile(borderDistances, 0.95);
  const threshold = Math.max(
    FOREGROUND_MIN_DISTANCE,
    Math.min(
      FOREGROUND_MAX_DISTANCE,
      p95 + 8,
      borderMedian + 6 * borderMad + 12,
    ),
  );

  const foreground = new Uint8Array(gridWidth * gridHeight);
  for (let index = 0; index < grid.length; index++) {
    if (nearestColorDistance(grid[index], backgroundReferences) > threshold) {
      foreground[index] = 1;
    }
  }

  // Remove one/two-cell bridges caused by table grids, seams or printed
  // background lines. A broad physical support survives the opening; thin
  // tendrils that would drag the bounding box to the frame edge do not.
  const openedForeground = openForegroundMask(foreground, gridWidth, gridHeight);
  const openedCount = openedForeground.reduce((sum, value) => sum + value, 0);
  const foregroundCount = foreground.reduce((sum, value) => sum + value, 0);
  const componentSource =
    openedCount >= Math.max(12, Math.floor(foregroundCount * 0.55))
      ? openedForeground
      : foreground;

  const visited = new Uint8Array(componentSource.length);
  let bestComponent: number[] = [];
  const queue: number[] = [];
  for (let start = 0; start < foreground.length; start++) {
    if (!componentSource[start] || visited[start]) continue;
    const component: number[] = [];
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    for (let q = 0; q < queue.length; q++) {
      const index = queue[q];
      component.push(index);
      const x = index % gridWidth;
      const y = Math.floor(index / gridWidth);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;
          const next = ny * gridWidth + nx;
          if (!componentSource[next] || visited[next]) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    if (component.length > bestComponent.length) bestComponent = component;
  }
  if (bestComponent.length === 0) return null;

  let minX = gridWidth;
  let maxX = -1;
  let minY = gridHeight;
  let maxY = -1;
  for (const index of bestComponent) {
    const x = index % gridWidth;
    const y = Math.floor(index / gridWidth);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const cellsWide = maxX - minX + 1;
  const cellsHigh = maxY - minY + 1;
  const foregroundRatio = bestComponent.length / Math.max(1, gridWidth * gridHeight);
  const density = bestComponent.length / Math.max(1, cellsWide * cellsHigh);
  if (foregroundRatio < FOREGROUND_MIN_COMPONENT_RATIO || density < FOREGROUND_MIN_DENSITY) {
    return null;
  }

  let x1 = minX * block;
  let y1 = minY * block;
  let x2 = Math.min(width, (maxX + 1) * block);
  let y2 = Math.min(height, (maxY + 1) * block);
  let rectWidth = x2 - x1;
  let rectHeight = y2 - y1;
  const tightRect: BusinessCardBoundaryRect = {
    x: x1,
    y: y1,
    width: rectWidth,
    height: rectHeight,
  };
  const widthSpan = rectWidth / width;
  const heightSpan = rectHeight / height;
  if (widthSpan < FOREGROUND_MIN_SPAN_RATIO || heightSpan < FOREGROUND_MIN_SPAN_RATIO) return null;

  const centerOffsetX = Math.abs((x1 + x2) / 2 - width / 2) / width;
  const centerOffsetY = Math.abs((y1 + y2) / 2 - height / 2) / height;
  if (centerOffsetX > FOREGROUND_MAX_CENTER_OFFSET || centerOffsetY > FOREGROUND_MAX_CENTER_OFFSET) {
    return null;
  }

  const safeMargins = [
    x1 >= block,
    y1 >= block,
    width - x2 >= block,
    height - y2 >= block,
  ].filter(Boolean).length;
  if (safeMargins < 3) return null;

  const padding = Math.max(block, Math.round(Math.max(rectWidth, rectHeight) * 0.02));
  x1 = Math.max(0, x1 - padding);
  y1 = Math.max(0, y1 - padding);
  x2 = Math.min(width, x2 + padding);
  y2 = Math.min(height, y2 + padding);
  rectWidth = x2 - x1;
  rectHeight = y2 - y1;

  const areaRatio = (rectWidth * rectHeight) / (width * height);
  if (areaRatio < FOREGROUND_MIN_BBOX_AREA_RATIO || areaRatio > FOREGROUND_MAX_BBOX_AREA_RATIO) {
    return null;
  }

  const confidence = Math.min(
    0.95,
    0.45 + 0.3 * Math.min(1, density) + 0.2 * Math.min(1, foregroundRatio / 0.5),
  );

  const componentMask = new Uint8Array(componentSource.length);
  for (const index of bestComponent) componentMask[index] = 1;
  // Non dilatare di un'intera cella: la dilatazione trascinava dentro il
  // tappetino e produceva il bordino nero/dentellato osservato sul telefono.
  // L'opening ha gia eliminato ponti sottili senza erodere il supporto dominante.
  const safeMask = componentMask;

  return {
    rect: { x: x1, y: y1, width: rectWidth, height: rectHeight },
    confidence,
    areaRatio,
    foregroundRatio,
    density,
    tightRect,
    mask: {
      cells: safeMask,
      gridWidth,
      gridHeight,
      blockSize: block,
    },
  };
}
