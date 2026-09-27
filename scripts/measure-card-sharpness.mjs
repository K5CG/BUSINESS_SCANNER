/**
 * Confronto di nitidezza fra lo scatto integrale e il ritaglio finale.
 *
 * Misura la varianza del laplaciano sulla stessa regione fisica: sul RAW viene
 * ritagliato il rettangolo effettivamente usato, così il confronto riguarda gli
 * stessi pixel di scena e non due inquadrature diverse. Per neutralizzare la
 * differenza di scala entrambe le immagini vengono portate alla stessa
 * larghezza prima della misura.
 */
import sharp from 'sharp';

const [rawPath, finalPath, cropSpec] = process.argv.slice(2);
if (!rawPath || !finalPath || !cropSpec) {
  console.error('uso: node scripts/measure-card-sharpness.mjs <raw> <final> <x,y,w,h>');
  process.exit(1);
}
const [cropX, cropY, cropW, cropH] = cropSpec.split(',').map(Number);

/** Varianza del laplaciano su un buffer in scala di grigi. */
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

async function measure(pipeline, targetWidth) {
  const { data, info } = await pipeline
    .resize({ width: targetWidth })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return laplacianVariance(data, info.width, info.height);
}

const finalMeta = await sharp(finalPath).metadata();
const target = Math.min(finalMeta.width, cropW);

const rawScore = await measure(
  sharp(rawPath).extract({ left: cropX, top: cropY, width: cropW, height: cropH }),
  target
);
const finalScore = await measure(sharp(finalPath), target);

console.log(
  JSON.stringify(
    {
      rawCropRegion: `${cropW}x${cropH}`,
      finalSize: `${finalMeta.width}x${finalMeta.height}`,
      comparisonWidth: target,
      rawSharpness: Number(rawScore.toFixed(1)),
      finalSharpness: Number(finalScore.toFixed(1)),
      finalVsRaw: Number((finalScore / rawScore).toFixed(3)),
    },
    null,
    2
  )
);
