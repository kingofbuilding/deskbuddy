'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..', 'src', 'renderer');

function env() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'effects-overlay.html'), 'utf8'), { runScripts: 'outside-only' });
  let play;
  const timers = new Map();
  let id = 0;
  dom.window.setTimeout = (callback) => { timers.set(++id, callback); return id; };
  dom.window.clearTimeout = (key) => timers.delete(key);
  dom.window.deskbuddyOverlay = { onPlay: (callback) => { play = callback; }, ready() {} };
  for (const script of ['glass-fracture.js', 'effects.js', 'effects-overlay.js']) dom.window.eval(fs.readFileSync(path.join(root, script), 'utf8'));
  return { dom, doc: dom.window.document, play: (payload) => play(payload), timers };
}

test('覆盖层快速切换只保留最新场景，结束后清理所有粒子和场景', () => {
  const e = env();
  try {
    for (const name of ['confetti', 'crack', 'slash', 'reminder']) e.play({ name });
    assert.equal(e.doc.querySelectorAll('.fx-scene.active').length, 1);
    assert.equal(e.doc.body.dataset.fx, 'reminder');
    assert.equal(e.doc.querySelector('#fx-confetti-host').children.length, 0);
    assert.equal(e.timers.size, 1);
    [...e.timers.values()][0]();
    assert.equal(e.doc.querySelectorAll('.fx-particle, .fx-scene.active').length, 0);
    assert.equal(e.doc.body.dataset.fx, '');
  } finally { e.dom.window.close(); }
});

test('关怀由本体演出，覆盖层不再创建角色、文字或背景', () => {
  const e = env();
  try {
    e.play({ name: 'reminder', kind: 'break' });
    assert.equal(e.doc.getElementById('fx-reminder').children.length, 0);
    e.play({ name: 'reminder', kind: 'focus_done' });
    assert.equal(e.doc.querySelectorAll('img[src*="girl-"], .fx-hero, .fx-copy, .fx-aura').length, 0);
    e.play({ name: 'toString' });
    assert.equal(e.doc.body.dataset.fx, 'reminder');
  } finally { e.dom.window.close(); }
});

test('裂纹从本体的出拳位置生成，刀柄按真实手部坐标定位', () => {
  const e=env();
  try {
    const anchor={hand:{x:720,y:410},impact:{x:706,y:394},body:{x:680,y:330,width:176,height:176}};
    e.play({name:'slash',anchor});
    assert.equal(e.doc.documentElement.style.getPropertyValue('--hand-x'),'720px');
    e.play({name:'crack',anchor});
    assert.equal(e.doc.querySelector('.glass-fracture').getAttribute('data-impact-x'),'706');
    assert.equal(e.doc.querySelector('.glass-fracture').getAttribute('data-impact-y'),'394');
  } finally {e.dom.window.close();}
});

test('裂屏只有透明玻璃断口，没有文字、人物或漫画装饰；切换时清空断口', () => {
  const e = env();
  try {
    e.play({ name: 'crack' });
    const scene = e.doc.getElementById('fx-crack');
    assert.equal(scene.textContent.trim(), '');
    assert.equal(scene.querySelectorAll('img, .fx-copy, .fx-word, .fx-speedlines, .fx-aura').length, 0);
    assert.ok(scene.querySelectorAll('.glass-fracture path').length > 300);
    e.play({ name: 'slash' });
    assert.equal(scene.querySelectorAll('.glass-fracture path').length, 0);
    assert.equal(e.doc.querySelectorAll('#fx-slash .fx-copy, #fx-slash .fx-word').length, 0);
  } finally { e.dom.window.close(); }
});

test('玻璃纹路可复现，撞击点密集，细缝与反光层覆盖同一套断口', () => {
  const glass = require('../src/renderer/glass-fracture.js');
  const model = glass.createModel({ seed: 42, width: 1920, height: 1080 });
  assert.deepEqual(glass.createModel({ seed: 42, width: 1920, height: 1080 }), model);
  assert.notDeepEqual(glass.createModel({ seed: 43, width: 1920, height: 1080 }).paths, model.paths);
  assert.equal(model.chips.length, 65);
  assert.ok(model.paths.length > 200);
  assert.ok(model.paths.every((p) => !/NaN|Infinity/.test(p.d) && p.thickness < 2.3));
  assert.ok(model.facets.every((f) => f.alpha < .06));
});
