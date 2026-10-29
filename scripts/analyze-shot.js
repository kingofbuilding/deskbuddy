/**
 * 分析冒烟截图：确认宠物形象真的被绘制出来，而不是空白页面。
 *
 * 用法：node scripts/analyze-shot.js <png 路径>
 */
'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

/** 极简 PNG 解码（只支持 8 位 RGBA 非隔行，Electron 截图正好是这种） */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('不支持的 PNG 格式 bitDepth=' + bitDepth + ' colorType=' + colorType);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pred) & 0xff;
          break;
        }
        default: break;
      }
    }

    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }

  return { width, height, data: out };
}

function analyze(file) {
  const png = decodePng(fs.readFileSync(file));
  const { width, height, data } = png;
  let transparent = 0;
  let opaque = 0;
  let violet = 0;
  let cyan = 0;
  let bright = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a === 0) {
        transparent += 1;
        continue;
      }
      opaque += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 紫色系（宠物主体）
      if (a > 128 && b > 110 && r > 60 && b > r && r > g) violet += 1;
      // 青色系（天线、眼睛高光、进度环）
      if (a > 128 && g > 150 && b > 150 && r < g - 20) cyan += 1;
      if (a > 200 && r + g + b > 560) bright += 1;
    }
  }

  const total = width * height;
  return {
    width,
    height,
    transparentRatio: +(transparent / total).toFixed(4),
    opaquePixels: opaque,
    contentBox: opaque > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    violetRatio: +(violet / total).toFixed(4),
    cyanRatio: +(cyan / total).toFixed(4),
    brightPixels: bright
  };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/analyze-shot.js <png>');
    process.exit(1);
  }
  console.log(JSON.stringify(analyze(file), null, 2));
}

module.exports = { analyze, decodePng };
