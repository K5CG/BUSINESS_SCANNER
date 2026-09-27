const path = require('path');
const sharp = require('sharp');

const src = path.join(__dirname, '../assets/logo-wordmark-source.png');
const dest = path.join(__dirname, '../assets/logo-wordmark.png');

async function main() {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < 28 && g < 28 && b < 28) {
      data[i + 3] = 0;
    }
  }

  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .trim({ threshold: 10 })
    .png()
    .toFile(dest);

  const meta = await sharp(dest).metadata();
  console.log('Wrote', dest, meta.width, 'x', meta.height);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
