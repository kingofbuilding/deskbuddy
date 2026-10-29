'use strict';

/**
 * Electron 主进程入口。
 *
 * 职责（需求 4.2）：
 *  - 应用生命周期、窗口创建、托盘、开机自启。
 *  - 所有磁盘读写（渲染进程不碰文件系统）。
 *  - 校验来自渲染进程的每一个 IPC 调用。
 *  - 单实例锁：避免用户重复启动出现多只宠物、多个计时器。
 */

const path = require('node:path');
const fs = require('node:fs');

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  shell,
  screen,
  dialog,
  powerMonitor,
  globalShortcut
} = require('electron');

const { createStore } = require('./storage.js');
const windows = require('./pet-window.js');
const selftest = require('./selftest.js');
const fxOverlay = require('./effects-window.js');
const settingsCore = require('../renderer/core/settings.js');
const tasksCore = require('../renderer/core/tasks.js');
const initiativeCore = require('../renderer/core/initiative.js');
const { createWindowsActivity } = require('./windows-activity.js');
const { createPetVisits } = require('./pet-visits.js');
const activityMonitor = createWindowsActivity({ getTempDir: () => path.join(userDataDir(), 'native-cache') });
const visits = createPetVisits({ screen, getWindow: () => petWindow, getShape:windows.petShape,onMotion: (motion) => {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('main:message', { channel: 'pet:state', payload: { motion } });
} });
let activityInterval = null;
let pollingActivity = false;
let entertainmentTarget = null;
let initialActivitySettings = settingsCore.DEFAULT_SETTINGS;
let visitEscapeTimer = null;
let ownsVisitEscape = false;
let recallShortcut = false;
let pendingRecovery = false;
let desktopLocked=false,desktopSuspended=false;
const desktopActive=()=>!desktopLocked&&!desktopSuspended;
function mayWander(snapshot,idleSeconds,matchedApp){
  const s=snapshot||lastSnapshot||{},settings=s.settings||initialActivitySettings;
  return settings.wanderEnabled&&settings.lifeEnabled&&settings.effectsEnabled&&!settings.doNotDisturb&&!s.ui?.bubble&&
    initiativeCore.canRoam({desktopActive:desktopActive(),focusRunning:s.timers?.focus?.status==='running',pendingCount:(s.tasks||[]).filter(t=>!t.completed).length,
      idleSeconds:idleSeconds??s.initiative?.idleSeconds??0,matchedApp:matchedApp??s.initiative?.matchedApp??''});
}
function clearVisitEscape() {
  if (visitEscapeTimer) clearTimeout(visitEscapeTimer);
  visitEscapeTimer = null;
  if (ownsVisitEscape) globalShortcut.unregister('Escape');
  ownsVisitEscape = false;
}
function armVisitEscape() {
  clearVisitEscape();
  ownsVisitEscape = globalShortcut.register('Escape', () => {
    clearVisitEscape(); visits.cancel(true); forwardToPet({ type: 'bubble/dismiss' });
  });
  visitEscapeTimer = setTimeout(clearVisitEscape, 14000);
}

function activitySettings() { return settingsCore.normalizeSettings((lastSnapshot && lastSnapshot.settings) || initialActivitySettings); }
function guardedApps(settings) {
  return String(settings.entertainmentApps || '').toLowerCase().split('\n').filter((name) => name && !['electron.exe', 'powershell.exe', 'explorer.exe', 'codex.exe', 'cmd.exe'].includes(name));
}
async function pollActivity() {
  if (pollingActivity || !petWindow || petWindow.isDestroyed()) return;
  pollingActivity = true;
  try {
    const settings = activitySettings();
    let matchedApp = '';
    if (desktopActive() && settings.gameGuardEnabled && !settings.doNotDisturb) {
      const foreground = await activityMonitor.sample();
      if (foreground.ok && guardedApps(settings).includes(foreground.process)) {
        matchedApp = foreground.process;
        entertainmentTarget = { handle: foreground.handle, processId: foreground.processId, expected: foreground.process, sampledAt: Date.now() };
      }
    } else { activityMonitor.stop(); entertainmentTarget = null; }
    const idleSeconds=powerMonitor.getSystemIdleTime();
    if(visits.kind()==='wander'&&!mayWander(lastSnapshot,idleSeconds,matchedApp))visits.cancel(true);
    if (!isQuitting) forwardToPet({ type: 'activity/sample', now: Date.now(), idleSeconds, matchedApp,desktopActive:desktopActive() });
  } catch (_) {
    // 当前桌面不可读（锁屏/系统切换）时跳过，不把未知状态当作娱乐或活跃工作。
  } finally { pollingActivity = false; }
}
function validEntertainmentTarget() {
  const settings = activitySettings();
  const bubble = lastSnapshot && lastSnapshot.ui && lastSnapshot.ui.bubble;
  return settings.gameGuardEnabled && !settings.doNotDisturb && bubble && bubble.kind === 'task_nudge' &&
    entertainmentTarget && Date.now() - entertainmentTarget.sampledAt < 2 * 60000 && guardedApps(settings).includes(entertainmentTarget.expected) &&
    Array.isArray(lastSnapshot.tasks) && lastSnapshot.tasks.some((task) => !task.completed);
}
async function operateEntertainment(command) {
  if (!validEntertainmentTarget()) return { ok: false, error: '没有可操作的娱乐窗口；请先回到列表中的应用再触发提醒。' };
  const target = Object.assign({}, entertainmentTarget);
  if (command === 'close') {
    const answer = await dialog.showMessageBox(petWindow, {
      type: 'question', title: '让鱼鱼关闭娱乐窗口？',
      message: '关闭 ' + target.expected + ' 的当前窗口？',
      detail: '请先保存游戏或网页里的进度。鱼鱼会发送正常的关闭请求，应用自己的保存提示仍会显示。',
      buttons: ['关闭这个窗口', '继续保留'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (answer.response !== 0) return { ok: false, cancelled: true };
    if (!validEntertainmentTarget() || entertainmentTarget.handle !== target.handle) return { ok: false, error: '窗口已变化，请重新选择。' };
  }
  return activityMonitor.operate(command, target);
}

const ARGV = new Set(process.argv.slice(1));
const IS_DEV = ARGV.has('--dev');
const SMOKE = ARGV.has('--smoke');

/** 重启恢复测试：以不同阶段启动，验证数据持久化 */
function restartPhase() {
  for (const arg of ARGV) {
    if (arg.startsWith('--restart-test=')) return arg.split('=')[1];
  }
  return null;
}

const RESTART_PHASE = restartPhase();

/** 提醒闭环测试 */
const REMINDER_TEST = ARGV.has('--reminder-test');

/** 休息提醒测试 */
const BREAK_TEST = ARGV.has('--break-test');
const IS_AUTOMATED = [...ARGV].some(arg=>arg==='--smoke'||/-test(?:=|$)/.test(arg));

/** @type {ReturnType<typeof createStore>|null} */
let store = null;
/** @type {BrowserWindow|null} */
let petWindow = null;
let taskbarWindow = null;
let popupHome = null;
/** @type {Map<string, BrowserWindow>} */
const panels = new Map();
let tray = null;
let dragOrigin = null;
/** 用户点了「退出」或在托盘选择退出时为 true；此时关窗才真正退出 */
let isQuitting = false;

/**
 * 宠物窗口最近一次广播的状态快照。
 * 新打开的面板窗口先拿它渲染，避免白屏等待。
 */
let lastSnapshot = null;

/* ------------------------------------------------------------------ *
 * 安全加固
 * ------------------------------------------------------------------ */

// 禁止任何窗口跳转到外部地址；外链一律交给系统浏览器
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file://') || url.startsWith('devtools://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

/* ------------------------------------------------------------------ *
 * 数据
 * ------------------------------------------------------------------ */

function userDataDir() {
  return app.getPath('userData');
}

function initStore() {
  store = createStore({ dir: userDataDir() });
  return store;
}

function sanitizeTasks(input) {
  const issues = [];
  const tasks = tasksCore.normalizeTasks(input, issues);
  return { tasks, issues };
}

function sanitizeSettings(input) {
  const issues = [];
  const settings = settingsCore.normalizeSettings(input, issues);
  return { settings, issues };
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function broadcast(channel, payload) {
  const message = { channel, payload };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('main:message', message);
    }
  }
}

function currentPetPosition() {
  if (!petWindow || petWindow.isDestroyed()) return null;
  if (visits.homePosition()) return visits.homePosition();
  if (popupHome) return popupHome;
  const [x, y] = petWindow.getPosition();
  return { x, y };
}

function fitPetPopup(visible) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!visible) {
    if (popupHome) { const home=popupHome;popupHome=null;petWindow.setPosition(home.x,home.y,false); }
    return;
  }
  if (popupHome || visits.homePosition()) return;
  const b=petWindow.getBounds(),display=screen.getDisplayMatching(b);
  const target=windows.clampToWorkArea(b.x,b.y,b.width,b.height,display);
  if(target.x!==b.x||target.y!==b.y){popupHome={x:b.x,y:b.y};petWindow.setPosition(target.x,target.y,false);}
}

function createTaskbarEntry() {
  if(taskbarWindow&&!taskbarWindow.isDestroyed())return;
  taskbarWindow=windows.createTaskbarWindow();
  const win=taskbarWindow;
  win.once('ready-to-show',()=>{win.showInactive();win.minimize();});
  win.on('restore',()=>showPet());
  win.on('close',event=>{if(!isQuitting){event.preventDefault();win.minimize();}});
  win.on('closed',()=>{taskbarWindow=null;});
}

function createMainWindow(initialSettings) {
  petWindow = windows.createPetWindow({
    position: initialSettings && initialSettings.petPosition,
    alwaysOnTop: !initialSettings || initialSettings.alwaysOnTop !== false
  });
  fxOverlay.setOnPresent(() => { if (petWindow && !petWindow.isDestroyed() && !petWindow.isMinimized()) petWindow.moveTop(); });

  // Windows 的鼠标转发可能中断；用原生光标位置刷新命中，避免整只宠物一直穿透。
  const pointerWindow = petWindow;
  let wasInside = false;
  const pointerTimer = setInterval(() => {
    if (pointerWindow.isDestroyed() || !pointerWindow.isVisible() || pointerWindow.isMinimized()) return;
    const point = screen.getCursorScreenPoint(), b = pointerWindow.getBounds();
    const inside = point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
    if (inside || wasInside) pointerWindow.webContents.send('main:message', { channel: 'pet:pointer', payload: { x: point.x - b.x, y: point.y - b.y } });
    wasInside = inside;
  }, 80);
  pointerTimer.unref();
  pointerWindow.once('closed', () => clearInterval(pointerTimer));

  petWindow.on('closed', () => {
    petWindow = null;
  });

  // 收起时仍保留任务栏入口，用户随时能点图标找回。
  petWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hidePet();
      if (tray && !tray.isDestroyed()) {
        tray.displayBalloon?.({
          iconType: 'info',
          title: 'DeskBuddy 还在运行',
          content: '宠物已收起到任务栏。点击任务栏图标，或按 Ctrl+Alt+P 找回。'
        });
      }
    }
  });

  const hidePanels = () => {
    for (const [kind, win] of panels) {
      if (!win.isDestroyed()) win.hide();
    }
  };
  petWindow.on('hide', hidePanels);
  petWindow.on('minimize', () => { hidePanels(); fxOverlay.hide(); clearVisitEscape(); refreshTrayMenu(); });
  petWindow.on('restore', () => { refreshTrayMenu(); });
  petWindow.on('blur', () => { if(!petWindow.isDestroyed())petWindow.webContents.send('main:message',{channel:'pet:state',payload:{closeMenu:true}}); });

  petWindow.on('moved', () => {
    for (const win of panels.values()) {
      if (!win.isDestroyed() && win.isVisible()) windows.positionPanelNear(win, petWindow);
    }
  });

  return petWindow;
}

function openPanel(kind) {
  if (!Object.prototype.hasOwnProperty.call(windows.PANEL_SIZE, kind)) {
    return { ok: false, error: 'bad_kind' };
  }
  const existing = panels.get(kind);
  if (existing && !existing.isDestroyed()) {
    windows.positionPanelNear(existing, petWindow);
    existing.show();
    existing.focus();
    return { ok: true, reused: true };
  }

  const win = windows.createPanelWindow(kind, {
    anchor: currentPetPosition() || undefined,
    alwaysOnTop: true
  });
  panels.set(kind, win);

  win.on('blur', () => {
    if (!win.isDestroyed() && !IS_DEV) win.hide();
  });
  win.on('closed', () => {
    panels.delete(kind);
    broadcast('pet:state', { panelClosed: kind });
  });

  win.webContents.once('did-finish-load', () => {
    // 面板打开时立刻下发一次当前快照，避免空白等待
    if (lastSnapshot) {
      win.webContents.send('main:message', { channel: 'app:snapshot', payload: lastSnapshot });
    }
    win.show();
    win.focus();
  });

  return { ok: true };
}

function closePanel(kind) {
  const win = panels.get(kind);
  if (!win) return { ok: false };
  if (!win.isDestroyed()) {
    win.hide();
  }
  return { ok: true };
}

function hidePet() {
  clearVisitEscape();
  visits.cancel(true);
  if (!petWindow || petWindow.isDestroyed()) return { ok: false };
  fxOverlay.hide();
  petWindow.minimize();
  if(taskbarWindow&&!taskbarWindow.isDestroyed())taskbarWindow.minimize();
  return { ok: true };
}

function showPet() {
  if (!petWindow || petWindow.isDestroyed()) {
    createMainWindow(store ? store.loadAll().settings : null);
    return { ok: true, recreated: true };
  }
  if (petWindow.isMinimized()) petWindow.restore();
  petWindow.showInactive();
  return { ok: true };
}

function recoverPet() {
  if (!petWindow || petWindow.isDestroyed()) createMainWindow(store ? store.loadAll().settings : null);
  visits.cancel(false); fxOverlay.hide(); clearVisitEscape();popupHome=null;
  const position = windows.defaultPetPosition(windows.PET_WINDOW.width, windows.PET_WINDOW.height);
  if (petWindow.isMinimized()) petWindow.restore();
  petWindow.setBounds(Object.assign({}, position, windows.PET_WINDOW), false);
  petWindow.showInactive(); petWindow.moveTop();
  forwardToPet({ type: 'settings/update', patch: { petScale: 1, petPosition: position } });
  petWindow.webContents.send('main:message', { channel: 'pet:state', payload: { recoveredPet: true } });
  forwardToPet({ type: 'pet/wave' }); refreshTrayMenu();
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function iconPath() {
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'assets', 'tray.ico'),
    path.join(__dirname, '..', 'renderer', 'assets', 'tray.png'),
    path.join(__dirname, '..', 'renderer', 'assets', 'icon.png')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildTrayMenu() {
  const visible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible() && !petWindow.isMinimized());
  return Menu.buildFromTemplate([
    { label: visible ? '收起到任务栏' : '显示宠物', click: () => togglePetVisibility() },
    { label: '找回宠物（大小与位置复原）  Ctrl+Alt+P', click: recoverPet },
    { type: 'separator' },
    { label: '今日任务', click: () => openPanel('tasks') },
    { label: '专注与休息', click: () => openPanel('settings') },
    { label: '陪伴模式', click: () => openPanel('companion') },
    { label: '演示全屏特效', submenu: [
      { label: '鱼鱼提醒（喝水）', click: () => { showPet(); forwardToPet({ type: 'initiative/demo', kind: 'water' }); } },
      { label: '鱼鱼提醒（起来休息）', click: () => { showPet(); forwardToPet({ type: 'initiative/demo', kind: 'break' }); } },
      { label: '四十米砍刀', click: () => demoPetEffect('slash') },
      { label: '真实裂屏', click: () => demoPetEffect('crack') },
      { label: '撒花', click: () => demoPetEffect('confetti') }
    ] },
    { type: 'separator' },
    {
      label: '重置窗口位置',
      click: () => {
        if (!petWindow || petWindow.isDestroyed()) return;
        const pos = windows.defaultPetPosition(windows.PET_WINDOW.width, windows.PET_WINDOW.height);
        petWindow.setPosition(pos.x, pos.y, false);
        petWindow.show();
      }
    },
    { type: 'separator' },
    { label: '打开数据文件夹', click: () => openDataFolder() },
    { label: '退出 DeskBuddy', click: () => quitApp() }
  ]);
}

function createTray() {
  const file = iconPath();
  if (!file) return null;
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  // 开发版和多个 Electron 应用并存时，为当前安装与数据目录提供独立稳定标识。
  const id = require('node:crypto').createHash('sha256').update(process.execPath + '\n' + userDataDir()).digest('hex');
  const guid = `${id.slice(0,8)}-${id.slice(8,12)}-5${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`;
  tray = new Tray(file, guid);
  tray.setToolTip('鱼鱼 DeskBuddy · 单击找回桌宠，右键打开菜单');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', recoverPet);
  tray.on('double-click', recoverPet);
  return tray;
}

function recoveryLaunchArguments() {
  const compatibility = ['--no-sandbox', '--disable-gpu'].filter(flag => process.argv.includes(flag)).join(' ');
  const application=app.isPackaged?'':'"'+path.join(__dirname,'..','..')+'" ';
  return application + '--recover-pet --user-data-dir="' + userDataDir() + '" ' + compatibility;
}

function createRecoveryShortcut() {
  if (process.platform !== 'win32' || IS_AUTOMATED) return;
  const shortcut = path.join(app.getPath('desktop'), '找回鱼鱼桌宠.lnk');
  // 只新增一次，不覆盖用户编辑过的快捷方式。
  if (!fs.existsSync(shortcut)) {
    const created = shell.writeShortcutLink(shortcut, 'create', {
    target: process.execPath, cwd: path.join(__dirname, '..', '..'),
    args: recoveryLaunchArguments(),
    description: '找回鱼鱼，恢复正常大小和位置', icon: iconPath(), iconIndex: 0,
    appUserModelId: 'com.deskbuddy.pet'
    });
    if (!created) process.stderr.write('[DeskBuddy] 无法创建找回快捷方式: ' + shortcut + '\n');
  }
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function togglePetVisibility() {
  if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible() && !petWindow.isMinimized()) {
    hidePet();
  } else {
    showPet();
  }
  refreshTrayMenu();
}

function openDataFolder() {
  const dir = userDataDir();
  shell.openPath(dir).then((error) => {
    if (error) dialog.showErrorBox('无法打开数据目录', error);
  });
}

/**
 * 播放特效：宠物窗口内的小动画 + 全屏覆盖层一起上。
 * 覆盖层失败不影响宠物窗口内的特效（优雅降级）。
 */
function demoPetEffect(name) {
  showPet(); return forwardToPet({ type: 'effect/play', name, manual: true });
}

function screenActorFrame(frame) {
  if (!frame || !frame.anchor || !petWindow || petWindow.isDestroyed()) return undefined;
  const a = frame.anchor;
  for (const point of [a.hand, a.impact, a.body]) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10000 || Math.abs(point.y) > 10000) return undefined;
  }
  if (!Number.isFinite(a.body.width) || !Number.isFinite(a.body.height) || a.body.width <= 0 || a.body.height <= 0 || a.body.width > 2000 || a.body.height > 2000) return undefined;
  const b = petWindow.getBounds();
  return { name: frame.name, holder: typeof frame.holder === 'string' ? frame.holder : '', startedAt: frame.startedAt,
    anchor: { hand: { x: b.x + a.hand.x, y: b.y + a.hand.y }, impact: { x: b.x + a.impact.x, y: b.y + a.impact.y },
      body: { x: b.x + a.body.x, y: b.y + a.body.y, width: a.body.width, height: a.body.height } } };
}

function playFullscreenEffect(name, holder, kind, frame) {
  try {
    if (!petWindow || petWindow.isDestroyed() || petWindow.isMinimized()) return { ok: false, error: 'pet_minimized' };
    const result = fxOverlay.play(name, holder, kind, screenActorFrame(frame));
    petWindow.moveTop();
    return result;
  } catch (error) {
    // 全屏特效属于增强能力，失败不拖累主流程
    process.stderr.write('[DeskBuddy] 全屏特效播放失败: ' + ((error && error.message) || error) + '\n');
  }
}

/* ------------------------------------------------------------------ *
 * 状态快照桥接
 *
 * 宠物窗口是唯一的状态持有者；面板窗口只是“远程视图”。
 * 面板上的操作经由主进程转发给宠物窗口执行，宠物窗口再广播新快照。
 * 这样任何时刻只有一处状态在变化，不会出现两个窗口各算一套计时。
 * ------------------------------------------------------------------ */

function broadcastToPanels(snapshot) {
  lastSnapshot = snapshot;
  if(visits.kind()==='wander'&&!mayWander(snapshot))visits.cancel(true);
  if (pendingRecovery) { pendingRecovery = false; setImmediate(recoverPet); }
  for (const win of panels.values()) {
    if (!win.isDestroyed()) {
      win.webContents.send('main:message', { channel: 'app:snapshot', payload: snapshot });
    }
  }
}

function forwardToPet(action) {
  if (!petWindow || petWindow.isDestroyed()) return { ok: false, error: 'pet_window_missing' };
  petWindow.webContents.send('main:message', { channel: 'app:action', payload: action });
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    recallShortcut,
    tray: tray && !tray.isDestroyed() ? { ready: true, bounds: tray.getBounds() } : { ready: false },
    taskbar: taskbarWindow&&!taskbarWindow.isDestroyed()?{ready:true,minimized:taskbarWindow.isMinimized(),title:taskbarWindow.getTitle()}:{ready:false},
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    dataDir: userDataDir(),
    dev: IS_DEV
  }));

  ipcMain.handle('data:load', () => {
    if (!store) initStore();
    const loaded = store.loadAll();
    const tasks = sanitizeTasks(loaded.tasks);
    const settings = sanitizeSettings(loaded.settings);

    const issues = loaded.issues.slice();
    for (const issue of tasks.issues) issues.push({ kind: 'tasks', level: 'warn', message: issue });
    for (const issue of settings.issues) issues.push({ kind: 'settings', level: 'warn', message: issue });

    // session 里的 focusTaskId 需要跟任务表对账
    const session = loaded.session && typeof loaded.session === 'object' ? loaded.session : null;

    return {
      ok: true,
      tasks: tasks.tasks,
      settings: settings.settings,
      session,
      issues
    };
  });

  ipcMain.handle('data:save-tasks', (_event, payload) => {
    if (!store) initStore();
    const sanitized = sanitizeTasks(payload);
    const saved = store.saveOne('tasks', sanitized.tasks);
    return saved.ok
      ? { ok: true, tasks: sanitized.tasks }
      : { ok: false, error: saved.error, tasks: sanitized.tasks };
  });

  ipcMain.handle('data:save-settings', (_event, payload) => {
    if (!store) initStore();
    const sanitized = sanitizeSettings(payload);

    // 记住宠物位置，方便下次启动还原
    const position = currentPetPosition();
    if (position) sanitized.settings.petPosition = position;

    const saved = store.saveOne('settings', sanitized.settings);
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setAlwaysOnTop(sanitized.settings.alwaysOnTop, 'screen-saver');
    }
    if (tray) tray.setToolTip('DeskBuddy · 桌面伙伴');

    return saved.ok
      ? { ok: true, settings: sanitized.settings }
      : { ok: false, error: saved.error, settings: sanitized.settings };
  });

  ipcMain.handle('data:save-session', (_event, payload) => {
    if (!store) initStore();
    const session = payload && typeof payload === 'object' ? payload : {};
    const saved = store.saveOne('session', session);
    return saved.ok ? { ok: true } : { ok: false, error: saved.error };
  });

  ipcMain.handle('window:drag-start', () => {
    if (!petWindow || petWindow.isDestroyed()) return { ok: false };
    visits.cancel(false);
    popupHome=null;
    clearVisitEscape();
    const [x, y] = petWindow.getPosition();
    dragOrigin = { x, y, startedAt: Date.now() };
    return { ok: true };
  });

  ipcMain.handle('window:drag-move', (_event, payload) => {
    if (!petWindow || petWindow.isDestroyed() || !dragOrigin) return { ok: false };
    const dx = Number(payload && payload.dx);
    const dy = Number(payload && payload.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { ok: false };
    if (Math.abs(dx) > 4000 || Math.abs(dy) > 4000) return { ok: false };

    const display = screen.getDisplayMatching(petWindow.getBounds());
    const size = petWindow.getBounds();
    const target = windows.clampPetToWorkArea(
      dragOrigin.x + dx,
      dragOrigin.y + dy,
      size.width,
      size.height,
      display
    );
    petWindow.setPosition(target.x, target.y, false);
    return { ok: true, position: target };
  });

  ipcMain.handle('window:drag-end', () => {
    dragOrigin = null;
    if (store && petWindow) {
      const position = currentPetPosition();
      if (position) {
        const loaded = store.loadAll();
        const merged = settingsCore.normalizeSettings(
          Object.assign({}, loaded.settings || {}, { petPosition: position })
        );
        store.saveOne('settings', merged);
      }
    }
    return { ok: true, position: currentPetPosition() };
  });

  ipcMain.handle('window:position', () => currentPetPosition());

  ipcMain.handle('window:always-on-top', (_event, on) => {
    if (!petWindow || petWindow.isDestroyed()) return { ok: false };
    petWindow.setAlwaysOnTop(Boolean(on), 'screen-saver');
    return { ok: true, alwaysOnTop: Boolean(on) };
  });

  ipcMain.handle('window:set-scale', (_event, scale) => {
    const value = Number(scale);
    if (!Number.isFinite(value) || value < 0.75 || value > 1.6) {
      return { ok: false, error: 'bad_scale' };
    }
    if (!petWindow || petWindow.isDestroyed()) return { ok: false };
    const width = Math.round(windows.PET_WINDOW.width * value);
    const height = Math.round(windows.PET_WINDOW.height * value);
    const display = screen.getDisplayMatching(petWindow.getBounds());
    const pos = windows.clampPetToWorkArea(petWindow.getBounds().x, petWindow.getBounds().y, width, height, display);
    petWindow.setBounds({ x: pos.x, y: pos.y, width, height }, false);
    return { ok: true, scale: value };
  });

  ipcMain.handle('window:open-panel', (_event, kind) => {
    return openPanel(String(kind || ''));
  });

  ipcMain.handle('window:close-panel', (_event, kind) => closePanel(String(kind || '')));
  ipcMain.handle('window:hide-pet', () => {
    const result = hidePet();
    refreshTrayMenu();
    return result;
  });
  ipcMain.handle('window:show-pet', () => {
    const result = showPet();
    refreshTrayMenu();
    return result;
  });
  ipcMain.handle('window:recover-pet', recoverPet);
  ipcMain.on('window:pet-popup',(event,on)=>{if(petWindow&&!petWindow.isDestroyed()&&event.sender.id===petWindow.webContents.id)fitPetPopup(on===true);});
  ipcMain.on('window:pet-interactive', (event, on) => {
    if (petWindow && !petWindow.isDestroyed() && event.sender.id === petWindow.webContents.id) petWindow.setIgnoreMouseEvents(on !== true, { forward: true });
  });
  ipcMain.on('app:actor-anchor', (event, frame) => {
    if (!petWindow || petWindow.isDestroyed() || event.sender.id !== petWindow.webContents.id) return;
    fxOverlay.updateAnchor(screenActorFrame(frame));
  });
  ipcMain.handle('window:set-badge', () => ({ ok: true }));

  ipcMain.handle('app:open-data-folder', () => {
    openDataFolder();
    return { ok: true };
  });

  ipcMain.handle('app:get-snapshot', () => {
    return { ok: true, snapshot: lastSnapshot };
  });

  ipcMain.handle('app:dispatch', (_event, action) => {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
      return { ok: false, error: 'bad_action' };
    }
    return forwardToPet(action);
  });

  ipcMain.handle('app:broadcast-state', (_event, snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false };
    broadcastToPanels(snapshot);
    return { ok: true };
  });

  /** 宠物窗口请求播放全屏特效 */
  ipcMain.handle('app:fullscreen-fx', (_event, payload) => {
    const name = payload && typeof payload.name === 'string' ? payload.name : '';
    return playFullscreenEffect(name, payload && payload.holder, payload && payload.kind, payload && payload.frame);
  });

  ipcMain.handle('app:quit', () => {
    quitApp();
    return { ok: true };
  });
  ipcMain.handle('window:pet-visit', async (event, request) => {
    if (!petWindow || event.sender.id !== petWindow.webContents.id) return { ok: false };
    const kind=typeof request==='string'?request:request&&request.kind;
    const holder=request&&typeof request.holder==='string'?request.holder:'';
    const settings = activitySettings();
    if (!desktopActive()||settings.doNotDisturb || (kind === 'wander' && !mayWander(lastSnapshot))) return { ok: false };
    if (!['water', 'task_nudge', 'wander'].includes(kind)) return { ok: false };
    fitPetPopup(false);
    const result = visits.visit(kind,holder);
    if (result.ok && kind !== 'wander') armVisitEscape();
    if (kind === 'task_nudge' && settings.guardMode === 'minimize' && result.ok) await operateEntertainment('minimize');
    return result;
  });
  ipcMain.handle('window:pet-return', (event) => {
    if (!petWindow || event.sender.id !== petWindow.webContents.id) return { ok: false };
    clearVisitEscape();
    fxOverlay.hide();
    return visits.cancel(true);
  });
  ipcMain.handle('activity:window-action', (event, command) => {
    if (!petWindow || event.sender.id !== petWindow.webContents.id || !['minimize', 'close'].includes(command)) return { ok: false };
    return operateEntertainment(command);
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function quitApp() {
  isQuitting = true;
  app.quit();
}

function applyLaunchAtLogin(enabled) {
  // 只在打包后启用，开发环境注册自启会指向 electron.exe，容易造成困扰
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
}

function bootstrap() {
  pendingRecovery = ARGV.has('--recover-pet');
  if (process.platform === 'win32') app.setAppUserModelId('com.deskbuddy.pet');

  initStore();
  const loaded = store.loadAll();
  const settings = settingsCore.normalizeSettings(loaded.settings);
  initialActivitySettings = settings;

  createMainWindow(settings);
  createTaskbarEntry();
  createTray();
  createRecoveryShortcut();
  registerIpc();
  powerMonitor.on('lock-screen',()=>{desktopLocked=true;visits.cancel(true);fxOverlay.hide();pollActivity();});
  powerMonitor.on('unlock-screen',()=>{desktopLocked=false;pollActivity();});
  powerMonitor.on('suspend',()=>{desktopSuspended=true;visits.cancel(true);fxOverlay.hide();pollActivity();});
  powerMonitor.on('resume',()=>{desktopSuspended=false;pollActivity();});
  applyLaunchAtLogin(settings.launchAtLogin);
  if (!recallShortcut) recallShortcut = globalShortcut.register('CommandOrControl+Alt+P', recoverPet);
  if (process.platform === 'win32') {
    app.setUserTasks([{ program: process.execPath, arguments: recoveryLaunchArguments(),
      iconPath: process.execPath, iconIndex: 0, title: '找回桌宠', description: '恢复桌宠的正常大小和默认位置' }]);
  }
  if (activityInterval) clearInterval(activityInterval);
  if (!IS_AUTOMATED) {
    activityInterval = setInterval(pollActivity, 5000);
  }

  // 首次启动给一点引导
  if (loaded.issues.length > 0) {
    petWindow.webContents.once('did-finish-load', () => {
      broadcast('pet:state', { recoveredIssues: loaded.issues });
    });
  }
}

// 单实例：第二次启动只让已运行的实例显示窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, args) => {
    if (args.includes('--recover-pet')) recoverPet(); else showPet();
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.show();
      petWindow.focus();
    }
  });

  // 兼容受限运行环境（远程会话、部分沙箱）：
  // 这些环境里 Chromium 多进程 IPC 需要禁用浏览器进程沙箱才能建立。
  // 设置 DESKBUDDY_COMPAT=1 时启用；普通桌面用户不需要，保持默认沙箱。
  if (process.env.DESKBUDDY_COMPAT === '1') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu');
  }

  // 透明窗口在部分 Windows 显卡上会闪黑，禁用 GPU 合成更稳
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();

  app.whenReady().then(() => {
    bootstrap();
    if (SMOKE) runSmokeCheck();
    if (RESTART_PHASE) runRestartPhase();
    if (REMINDER_TEST) runReminderPhase();
    if (BREAK_TEST) runBreakPhase();
    if (ARGV.has('--initiative-test')) require('../../scripts/initiative-phase.js').run({ app, petWindow, openPanel, panels });
    if (ARGV.has('--actor-test')) require('../../scripts/actor-phase.js').run({ app, petWindow, getFxWindow: () => fxOverlay.getWindow(), recoverPet });
    if (ARGV.has('--usability-test')) require('../../scripts/usability-phase.js').run({app,petWindow,taskbarWindow});
    if (ARGV.has('--autonomy-test')) require('../../scripts/autonomy-phase.js').run({app,petWindow,getFxWindow:()=>fxOverlay.getWindow()});
  }).catch((error) => {
    dialog.showErrorBox('DeskBuddy 启动失败', String((error && error.stack) || error));
    app.exit(1);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      bootstrap();
    } else {
      showPet();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    clearVisitEscape();
    if (activityInterval) clearInterval(activityInterval);
    activityInterval = null;
    activityMonitor.stop();
    // 真正退出：允许窗口关闭，并清理全屏特效覆盖层
    if (store && petWindow && !petWindow.isDestroyed()) {
      const position = currentPetPosition();
      if (position) {
        const loaded = store.loadAll();
        store.saveOne(
          'settings',
          settingsCore.normalizeSettings(Object.assign({}, loaded.settings || {}, { petPosition: position }))
        );
      }
    }
    visits.dispose();
    fxOverlay.destroy();
  });

  app.on('will-quit', () => {
    if (recallShortcut) globalShortcut.unregister('CommandOrControl+Alt+P');
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 冒烟自检（npm run smoke）
 * ------------------------------------------------------------------ */

async function runSmokeCheck() {
  const report = await selftest.runSelfTest({
    petWindow,
    openPanel,
    panels,
    store,
    userDataDir: userDataDir(),
    getFxWindow: () => fxOverlay.getWindow()
  });

  const failed = report.failed;
  const full = {
    at: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    passed: report.passed,
    failed,
    results: report.results
  };

  const reportPath = path.join(userDataDir(), 'smoke-report.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(full, null, 2));
  } catch (_) {
    /* 报告写失败不影响结论 */
  }

  process.stdout.write('SMOKE_REPORT_PATH=' + reportPath + '\n');
  process.stdout.write('SMOKE_RESULT=' + (failed === 0 ? 'PASS' : 'FAIL') + '\n');
  for (const item of report.results) {
    process.stdout.write(
      (item.ok ? '  [PASS] ' : '  [FAIL] ') + item.name + (item.detail ? ' :: ' + item.detail : '') + '\n'
    );
  }

  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 250);
}

/* ------------------------------------------------------------------ *
 * 休息提醒验证（node scripts/break-test.js）
 * ------------------------------------------------------------------ */

async function runBreakPhase() {
  try {
    const breakPhase = require('../../scripts/break-phase.js');
    await breakPhase.run({ app, petWindow, store });
  } catch (error) {
    process.stdout.write('PHASE_RESULT=FAIL reason=' + ((error && error.message) || error) + '\n');
    app.exit(1);
  }
}

/* ------------------------------------------------------------------ *
 * 提醒闭环验证（node scripts/reminder-test.js）
 * ------------------------------------------------------------------ */

async function runReminderPhase() {
  try {
    const reminderPhase = require('../../scripts/reminder-phase.js');
    await reminderPhase.run({ app, petWindow, store });
  } catch (error) {
    process.stdout.write('PHASE_RESULT=FAIL reason=' + ((error && error.message) || error) + '\n');
    app.exit(1);
  }
}

/* ------------------------------------------------------------------ *
 * 重启恢复验证（node scripts/restart-test.js）
 * ------------------------------------------------------------------ */

async function runRestartPhase() {
  try {
    const restartPhaseModule = require('../../scripts/restart-phase.js');
    await restartPhaseModule.runPhase({
      app,
      BrowserWindow,
      ipcMain,
      store,
      petWindow,
      settingsCore
    });
  } catch (error) {
    process.stdout.write('PHASE_RESULT=FAIL reason=' + ((error && error.message) || error) + '\n');
    app.exit(1);
  }
}
