/**
 * Nitidezza per regioni: centro e quattro angoli.
 *
 * Un solo valore globale nasconde i problemi di piano focale: se il telefono è
 * inclinato rispetto al foglio, un lato resta nitido e quello opposto no, ma la
 * media resta accettabile. Misurando cinque riquadri si distingue la sfocatura
 * uniforme (fuoco o tempi di scatto) dalla sfocatura su un lato solo
 * (inclinazione o profondità di campo).
 *
 * Ogni riquadro viene portato alla stessa larghezza prima della misura, così i
 * valori restano confrontabili fra immagini di dimensioni diverse.
 */
import sharp from 'sharp';

const REGION_FRACTION = 0.28;
const NORMALIZED_WIDTH = 600;

function laplacianVariance(data, width, height) {
  const values = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      values.push(
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width]
      );
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
}

async function regionScore(file, area) {
  const { data, info } = await sharp(file)
    .extract(area)
    .resize({ width: NORMALIZED_WIDTH })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Number(laplacianVariance(data, info.width, info.height).toFixed(1));
}

export async function measureRegions(file, bounds) {
  const meta = await sharp(file).metadata();
  const base = bounds ?? { left: 0, top: 0, width: meta.width, height: meta.height };
  const rw = Math.round(base.width * REGION_FRACTION);
  const rh = Math.round(base.height * REGION_FRACTION);
  const inset = 0.06;
  const insetX = Math.round(base.width * inset);
  const insetY = Math.round(base.height * inset);

  const areas = {
    center: {
      left: base.left + Math.round((base.width - rw) / 2),
      top: base.top + Math.round((base.height - rh) / 2),
    },
    upperLeft: { left: base.left + insetX, top: base.top + insetY },
    upperRight: { left: base.left + base.width - rw - insetX, top: base.top + insetY },
    lowerLeft: { left: base.left + insetX, top: base.top + base.height - rh - insetY },
    lowerRight: {
      left: base.left + base.width - rw - insetX,
      top: base.top + base.height - rh - insetY,
    },
  };

  const scores = {};
  for (const [name, origin] of Object.entries(areas)) {
    scores[name] = await regionScore(file, { ...origin, width: rw, height: rh });
  }
  const values = Object.values(scores);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    size: `${meta.width}x${meta.height}`,
    region: `${rw}x${rh}`,
    scores,
    // Rapporto fra la regione peggiore e la migliore: vicino a 1 significa
    // sfocatura uniforme, molto sotto 1 significa piano focale inclinato.
    worstOverBest: Number((min / max).toFixed(2)),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const files = process.argv.slice(2);
  for (const file of files) {
    const result = await measureRegions(file);
    console.log(`${file}\n${JSON.stringify(result)}\n`);
  }
}
