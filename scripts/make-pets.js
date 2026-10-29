'use strict';
// 新形象是插画源素材，不再用旧的几何 SVG 覆盖它。
const fs = require('node:fs');
const path = require('node:path');
for (const state of ['idle', 'focus', 'happy', 'angry', 'slash', 'dnd', 'blink', 'wave', 'walk_left', 'walk_right']) {
  const file = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'girl-' + state + '.png');
  if (!fs.existsSync(file)) throw new Error('缺少鲸鱼娘源素材：' + file + '；参见 docs/character-art.md');
}
console.log('✓ 十张鲸鱼娘状态与动作 PNG 源素材齐全');
