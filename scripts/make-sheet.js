'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const assets = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const states = ['idle', 'focus', 'happy', 'angry', 'slash', 'dnd'];
const labels = ['待机 · 偷偷得意', '专注 · 认真看书', '庆祝 · 开心耶', '提醒 · 气鼓鼓', '挥刀 · 小小的我', '免打扰 · 抱枕小憩'];
const cells = states.map((state, i) => {
  const image = fs.readFileSync(path.join(assets, 'girl-' + state + '.png')).toString('base64');
  return `<g transform="translate(${i * 220},0)"><rect x="6" y="8" width="208" height="304" rx="18" fill="white"/><image href="data:image/png;base64,${image}" x="14" y="14" width="192" height="260" preserveAspectRatio="xMidYMid meet"/><text x="110" y="294" text-anchor="middle" fill="#274568" font-size="15" font-family="Microsoft YaHei, sans-serif">${labels[i]}</text></g>`;
}).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="320"><rect width="1320" height="320" fill="#e7eef8"/>${cells}</svg>`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'previews', 'sheet.png'), new Resvg(svg).render().asPng());
console.log('✓ docs/previews/sheet.png');
