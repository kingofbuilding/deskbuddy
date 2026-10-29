'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const assets = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const previews = path.join(__dirname, '..', 'docs', 'previews');
fs.mkdirSync(previews, { recursive: true });
function render(data, size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="data:image/png;base64,${data.toString('base64')}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return new Resvg(svg).render().asPng();
}
for (const state of ['idle', 'focus', 'happy', 'angry', 'slash', 'dnd']) {
  const source = fs.readFileSync(path.join(assets, 'girl-' + state + '.png'));
  fs.writeFileSync(path.join(previews, 'pet-' + state + '.png'), render(source, 260));
  if (state === 'idle') {
    fs.writeFileSync(path.join(assets, 'icon.png'), render(source, 256));
    fs.writeFileSync(path.join(previews, 'icon.png'), render(source, 256));
  }
}
// 小尺寸使用清晰的蓝底白鲸，ICO 同时提供 16/20/24/32/48/64 像素，适配 Windows 缩放。
const traySvg = fs.readFileSync(path.join(assets, 'tray.svg'), 'utf8');
const sizes = [16,20,24,32,48,64];
const images = sizes.map(size => new Resvg(traySvg, {fitTo:{mode:'width',value:size}}).render().asPng());
fs.writeFileSync(path.join(assets, 'tray.png'), images[3]);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1,2); header.writeUInt16LE(sizes.length,4);
let offset = header.length;
images.forEach((png,i) => {
 const p = 6 + i * 16; header[p] = header[p+1] = sizes[i];
 header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);
 header.writeUInt32LE(png.length,p+8);header.writeUInt32LE(offset,p+12);offset += png.length;
});
fs.writeFileSync(path.join(assets, 'tray.ico'),Buffer.concat([header,...images]));
console.log('✓ 鲸鱼娘应用图标、托盘与六种预览');
