// Renders the PNG app icons from public/icons/icon.svg using Playwright's Chromium.
// Usage: npm run icons   (needs Playwright available; the generated PNGs are committed)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

const dir = path.join(__dirname, '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
// Maskable: full-bleed background, artwork shrunk into the 80% safe zone.
const maskable = svg.replace('rx="112"', 'rx="0"').replace('translate(256 262)', 'translate(256 262) scale(.78)');
// Apple touch icon: iOS rounds corners itself, so fill the square.
const apple = svg.replace('rx="112"', 'rx="0"').replace('translate(256 262)', 'translate(256 262) scale(.9)');

const jobs = [
  ['icon-192.png', svg, 192], ['icon-512.png', svg, 512],
  ['icon-maskable-512.png', maskable, 512], ['apple-touch-icon.png', apple, 180]
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, src, size] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<html><body style="margin:0;background:transparent">' + src.replace('<svg ', '<svg width="' + size + '" height="' + size + '" ') + '</body></html>');
    await page.screenshot({ path: path.join(dir, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', name);
  }
  await browser.close();
})();
