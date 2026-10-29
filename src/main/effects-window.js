'use strict';

/**
 * 全屏特效覆盖层。
 *
 * 设计（用户要求“特效起码要全屏”）：
 *  - 一个独立的透明窗口铺满所有显示器的联合区域；
 *  - setIgnoreMouseEvents(true)：绝不挡鼠标，用户毫无感知地“穿过”特效；
 *  - focusable: false + showInactive()：绝不抢焦点、不打断输入；
 *  - 特效只画在这个覆盖层里，动画结束自动隐藏，不碰任何其他程序的内容。
 *
 * 与 PRD“夸张但安全”原则的关系：覆盖层仍然是 DeskBuddy 自己的窗口，
 * 不修改壁纸、不伪造系统崩溃、不拦截输入，只是把画布从宠物窗口扩大到全屏。
 */

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const OVERLAY_HTML = path.join(RENDERER_DIR, 'effects-overlay.html');

// 与渲染层 effects.js 保持一致
const { DURATIONS } = require('../renderer/effects.js');

/** @type {BrowserWindow|null} */
let overlay = null;
let hideTimer = null;
let pending = null;
let ready = false;
let current = null;
let onPresent = null;

function relativeFrame(frame, bounds) {
  if (!frame || !frame.anchor) return {};
  const a = frame.anchor;
  return { startedAt: frame.startedAt, anchor: {
    hand: { x: a.hand.x - bounds.x, y: a.hand.y - bounds.y },
    impact: { x: a.impact.x - bounds.x, y: a.impact.y - bounds.y },
    body: { x: a.body.x - bounds.x, y: a.body.y - bounds.y, width: a.body.width, height: a.body.height }
  } };
}

/** 所有显示器的联合包围盒 */
function unionBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const display of displays) {
    const b = display.bounds;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) {
    const primary = screen.getPrimaryDisplay().bounds;
    return primary;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;

  overlay = new BrowserWindow({
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    enableLargerThanScreen: true,
    title: 'DeskBuddy FX',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: false
    }
  });

  overlay.setIgnoreMouseEvents(true, { forward: false });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setBounds(unionBounds());
  overlay.loadFile(OVERLAY_HTML);

  // 第一次触发时页面尚未加载，保留最新一场，加载完成后再计时和展示。
  overlay.webContents.on('did-finish-load', () => {
    ready = true;
    if (pending) deliver(overlay);
  });

  overlay.on('closed', () => {
    overlay = null;
    ready = false;
    pending = null;
  });

  return overlay;
}

/**
 * 播放全屏特效。
 * @param {string} name slash | crack | confetti
 * @param {string} [holder] 持有者标识（与宠物窗口的状态机同步）
 */
function play(name, holder, kind, frame) {
  if (Object.prototype.hasOwnProperty.call(DURATIONS, name) === false) {
    return { ok: false, error: 'bad_name' };
  }

  const win = ensureOverlay();
  // 显示器拓扑可能变化，播放前重新对齐
  try {
    win.setBounds(unionBounds());
  } catch (_) {
    /* 忽略：窗口可能在销毁边缘 */
  }

  const duration = DURATIONS[name];
  pending = Object.assign({
    name,
    holder: holder || '',
    duration,
    kind: kind === 'break' ? 'break' : 'focus_done',
    bounds: unionBounds()
  }, relativeFrame(frame, unionBounds()));
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  if (ready) deliver(win);

  return { ok: true, duration };
}

function deliver(win) {
  if (!pending || win.isDestroyed()) return;
  const payload = pending;
  current = { name: payload.name, holder: payload.holder };
  pending = null;
  if (!win.isVisible()) win.showInactive();
  win.webContents.send('overlay:play', payload);
  if (onPresent) onPresent();

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      overlay.hide();
    }
  }, payload.duration + 300);
}

function hide() {
  pending = null;
  current = null;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    overlay.hide();
  }
}

function destroy() {
  hide();
  if (overlay && !overlay.isDestroyed()) {
    overlay.destroy();
  }
  overlay = null;
}

function isAlive() {
  return Boolean(overlay && !overlay.isDestroyed());
}

/** 供自检读取覆盖层窗口（可能为 null） */
function getWindow() {
  return overlay;
}

function updateAnchor(frame) {
  if (!frame || !current || frame.name !== current.name || frame.holder !== current.holder || !overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('overlay:anchor', Object.assign({ name: frame.name, holder: frame.holder }, relativeFrame(frame, overlay.getBounds())));
}

module.exports = { play, hide, destroy, isAlive, getWindow, DURATIONS, updateAnchor, setOnPresent: (callback) => { onPresent = callback; } };
