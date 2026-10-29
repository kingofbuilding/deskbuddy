'use strict';

/**
 * 窗口管理（主进程）。
 *
 * 对应需求 4.3 / 12.1：
 *  - 无边框、透明、置顶、可拖动、不显示系统标题栏。
 *  - 子面板（任务 / 设置 / 陪伴）是独立的小窗口，聚焦时显示，失焦自动隐藏。
 *  - 位置与尺寸永远夹取到当前显示器的工作区内，换显示器不会跑到屏幕外。
 *  - 所有窗口销毁后不会残留计时器或动画。
 */

const { BrowserWindow, screen, nativeImage } = require('electron');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

// 宠物本体可以缩放，所以窗口留足空间给气泡和特效
const PET_WINDOW = { width: 320, height: 380 };
const PANEL_SIZE = {
  tasks: { width: 380, height: 520 },
  settings: { width: 380, height: 560 },
  companion: { width: 360, height: 460 }
};

function clampToWorkArea(x, y, width, height, display) {
  const area = (display || screen.getPrimaryDisplay()).workArea;
  const minX = area.x;
  const maxX = area.x + area.width - width;
  const minY = area.y;
  const maxY = area.y + area.height - height;
  return {
    x: Math.min(Math.max(Math.round(x), minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(Math.round(y), minY), Math.max(minY, maxY))
  };
}

function defaultPetPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return clampToWorkArea(area.x + area.width - width - 24, area.y + area.height - height - 24, width, height);
}

let silhouette = null;
function petShape(width, height) {
  if (!silhouette) {
    const image = nativeImage.createFromPath(path.join(RENDERER_DIR, 'assets', 'girl-idle.png'));
    const size = image.getSize(), pixels = image.toBitmap();
    let left=size.width,top=size.height,right=0,bottom=0;
    for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++)if(pixels[(y*size.width+x)*4+3]>20){
      left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
    }
    silhouette={left:left/size.width,top:top/size.height,right:right/size.width,bottom:bottom/size.height,ratio:size.width/size.height};
  }
  const actor=176*width/PET_WINDOW.width,fitW=Math.min(actor,actor*silhouette.ratio),fitH=Math.min(actor,actor/silhouette.ratio);
  const x=(width-fitW)/2,y=height-6-actor+(actor-fitH)/2;
  return {left:x+fitW*silhouette.left,top:y+fitH*silhouette.top,right:x+fitW*silhouette.right,bottom:y+fitH*silhouette.bottom};
}

function clampPetToWorkArea(x,y,width,height,display) {
  const area=(display||screen.getPrimaryDisplay()).workArea,shape=petShape(width,height);
  return {x:Math.round(Math.min(Math.max(x,area.x-shape.left),area.x+area.width-shape.right)),
    y:Math.round(Math.min(Math.max(y,area.y-shape.top),area.y+area.height-shape.bottom))};
}

/** 确保保存的位置仍落在某块屏幕上（显示器拔插后） */
function ensureOnScreen(saved, width, height) {
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') {
    return defaultPetPosition(width, height);
  }
  const displays = screen.getAllDisplays();
  const inside = displays.some((display) => {
    const a = display.workArea;
    return saved.x + width > a.x + 40 && saved.x < a.x + a.width - 40 && saved.y + height > a.y + 40 && saved.y < a.y + a.height - 40;
  });
  if (!inside) return defaultPetPosition(width, height);
  return clampPetToWorkArea(saved.x, saved.y, width, height, screen.getDisplayMatching({x:saved.x,y:saved.y,width,height}));
}

function baseWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false,
    devTools: process.argv.includes('--dev'),
    backgroundThrottling: false
  };
}

function createPetWindow(options) {
  const opts = options || {};
  const initial = ensureOnScreen(opts.position, PET_WINDOW.width, PET_WINDOW.height);

  const win = new BrowserWindow({
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: initial.x,
    y: initial.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: opts.alwaysOnTop !== false,
    focusable: true,
    show: false,
    title: 'DeskBuddy',
    icon: path.join(RENDERER_DIR, 'assets', 'tray.ico'),
    webPreferences: baseWebPreferences()
  });

  // 需要“浮在其他应用之上”，但不要 aggressively 抢焦点
  win.setAlwaysOnTop(opts.alwaysOnTop !== false, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(RENDERER_DIR, 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
  });

  return win;
}

function createPanelWindow(kind, options) {
  const opts = options || {};
  const size = PANEL_SIZE[kind] || PANEL_SIZE.tasks;
  const anchor = opts.anchor || defaultPetPosition(PET_WINDOW.width, PET_WINDOW.height);

  // 面板贴着宠物左侧展开，并保证在屏幕内
  const preferredX = anchor.x - size.width - 8;
  const preferredY = anchor.y + PET_WINDOW.height - size.height;
  const pos = clampToWorkArea(preferredX, preferredY, size.width, size.height, opts.display);

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: opts.alwaysOnTop !== false,
    show: false,
    title: 'DeskBuddy - ' + kind,
    webPreferences: baseWebPreferences()
  });

  win.setAlwaysOnTop(opts.alwaysOnTop !== false, 'screen-saver');
  win.loadFile(path.join(RENDERER_DIR, 'index.html'), { query: { panel: kind } });

  return win;
}

/** 根据宠物窗口位置重新摆放面板窗口 */
function positionPanelNear(panelWin, petWin) {
  if (!panelWin || panelWin.isDestroyed() || !petWin || petWin.isDestroyed()) return;
  const petBounds = petWin.getBounds();
  const [width, height] = panelWin.getSize();
  const display = screen.getDisplayMatching(petBounds);
  const preferredX = petBounds.x - width - 8;
  const preferredY = petBounds.y + petBounds.height - height;
  const pos = clampToWorkArea(preferredX, preferredY, width, height, display);
  panelWin.setPosition(pos.x, pos.y, false);
}

function createTaskbarWindow() {
  const win=new BrowserWindow({width:350,height:280,useContentSize:true,show:false,frame:true,transparent:false,
    backgroundColor:'#fbfdff',resizable:false,maximizable:false,minimizable:true,skipTaskbar:false,
    title:'鱼鱼桌宠',icon:path.join(RENDERER_DIR,'assets','tray.ico'),webPreferences:baseWebPreferences()});
  win.loadFile(path.join(RENDERER_DIR,'taskbar.html'));
  return win;
}

module.exports = {
  PET_WINDOW,
  PANEL_SIZE,
  RENDERER_DIR,
  clampToWorkArea,
  clampPetToWorkArea,
  petShape,
  defaultPetPosition,
  ensureOnScreen,
  createPetWindow,
  createPanelWindow,
  createTaskbarWindow,
  positionPanelNear
};
