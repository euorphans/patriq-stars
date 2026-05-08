#!/usr/bin/env node
/**
 * Конвертирует PNG из images/new/ в WebP и записывает в images/.
 * Соответствие файлов (правь MAP при смене ассетов):
 */
const MAP = {
  'main.png': 'main_menu.webp',
  'main2.png': 'referral.webp',
  'starsTo.png': 'where_delivery_stars.webp',
  'starsIn5min.png': 'stars_success.webp',
  'premTo.png': 'where_delivery_premium.webp',
  'premIn5min.png': 'premium_success.webp',
};

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const newDir = path.join(root, 'images', 'new');
const outDir = path.join(root, 'images');

async function main() {
  if (!fs.existsSync(newDir)) {
    console.error(`Нет каталога ${newDir}`);
    process.exit(1);
  }

  for (const [srcName, destName] of Object.entries(MAP)) {
    const src = path.join(newDir, srcName);
    const dest = path.join(outDir, destName);
    if (!fs.existsSync(src)) {
      console.warn(`Пропуск (нет файла): ${srcName}`);
      continue;
    }
    await sharp(src)
      .webp({ quality: 86, effort: 6, smartSubsample: true })
      .toFile(dest);
    const st = fs.statSync(dest);
    console.log(`${srcName} → ${destName} (${(st.size / 1024).toFixed(1)} KiB)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
