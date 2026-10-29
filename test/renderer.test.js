'use strict';

/**
 * 渲染层集成测试：用 jsdom 加载真实的 index.html + 全部脚本，
 * 模拟 preload 桥接，验证“点击 -> 状态 -> 界面”这条链路真的通。
 *
 * 这一层补上了纯 reducer 测试覆盖不到的东西：
 *  DOM 选择器、事件绑定、气泡按钮、面板表单、特效 DOM。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');

// 每个测试都会开一个 jsdom 窗口，里面的 setInterval 必须显式关掉，否则进程不退出
const openEnvs = new Set();
test.afterEach(() => {
  for (const env of openEnvs) {
    try {
      env.window.close();
    } catch (_) {
      /* 已关闭 */
    }
  }
  openEnvs.clear();
});

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');
const RENDERER = path.join(ROOT, 'src', 'renderer');

const SCRIPTS = [
  'core/util.js',
  'core/settings.js',
  'core/tasks.js',
  'core/timers.js',
  'core/pet-state.js',
  'core/reminder-queue.js',
  'core/copy.js',
  'core/stats.js',
  'core/initiative.js',
  'core/app-state.js',
  'glass-fracture.js',
  'effects.js',
  'audio.js',
  'ui.js',
  'panels.js',
  'pet-life.js',
  'pet-performance.js',
  'pet-input.js',
  'app.js'
];

/** 构造一个尽量接近真实 preload 的桥接 */
function createBridge(overrides) {
  const calls = { saves: [], panels: [], drags: [], toasts: [] };
  const handlers = new Set();

  const bridge = {
    calls,
    emit(message) {
      for (const handler of handlers) handler(message);
    },
    getInfo: async () => ({ version: '1.0.0', dataDir: 'C:\\fake\\DeskBuddy', dev: true, electron: '40.0.0' }),
    loadState: async () => ({
      ok: true,
      tasks: [],
      settings: {},
      session: null,
      issues: []
    }),
    saveTasks: async (tasks) => {
      calls.saves.push({ kind: 'tasks', tasks });
      return { ok: true };
    },
    saveSettings: async (settings) => {
      calls.saves.push({ kind: 'settings', settings });
      return { ok: true };
    },
    saveSession: async (session) => {
      calls.saves.push({ kind: 'session', session });
      return { ok: true };
    },
    window: {
      beginDrag: async () => ({ ok: true }),
      dragTo: async (dx, dy) => { calls.drags.push({dx,dy}); return { ok: true }; },
      endDrag: async () => ({ ok: true }),
      getPosition: async () => ({ x: 0, y: 0 }),
      openPanel: async (kind) => {
        calls.panels.push(kind);
        return { ok: true };
      },
      closePanel: async () => ({ ok: true }),
      setAlwaysOnTop: async () => ({ ok: true }),
      setScale: async () => ({ ok: true }),
      hidePet: async () => ({ ok: true }),
      showPet: async () => ({ ok: true }),
      quit: async () => ({ ok: true }),
      setBadge: async () => ({ ok: true })
    },
    openDataFolder: async () => ({ ok: true }),
    getSnapshot: async () => ({ ok: true, snapshot: null }),
    dispatch: async () => ({ ok: true }),
    broadcastState: async () => ({ ok: true }),
    onMainMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }
  };

  return Object.assign(bridge, overrides || {});
}

/**
 * 创建一个加载了完整渲染程序的 jsdom 环境。
 * @param {{panel?: string, bridge?: object}} options
 */
async function createEnv(options) {
  const opts = options || {};
  const html = fs.readFileSync(INDEX, 'utf8');
  const query = opts.panel ? '?panel=' + opts.panel : '';
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  virtualConsole.on('error', (...args) => errors.push(new Error(args.join(' '))));

  const dom = new JSDOM(html, {
    url: 'file:///' + INDEX.replace(/\\/g, '/') + query,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });

  const { window } = dom;

  // 精简版 WebAudio：只记录调用，不发真声
  const audioCalls = [];
  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
    }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {}
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {}
      };
    }
    resume() {
      return Promise.resolve();
    }
    suspend() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;

  // 指针捕获在 jsdom 里没有实现
  if (!window.Element.prototype.setPointerCapture) {
    window.Element.prototype.setPointerCapture = function () {};
    window.Element.prototype.releasePointerCapture = function () {};
    window.Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }

  const bridge = opts.bridge || createBridge();
  window.deskbuddy = bridge;

  // 收集音效播放次数（通过包装构造函数）
  const OriginalFake = FakeAudioContext;
  window.AudioContext = class extends OriginalFake {
    constructor() {
      super();
      audioCalls.push('context');
    }
    createOscillator() {
      audioCalls.push('note');
      return super.createOscillator();
    }
  };

  // 逐个执行脚本（等价于 <script src> 的顺序）
  for (const relative of SCRIPTS) {
    const code = fs.readFileSync(path.join(RENDERER, relative), 'utf8');
    window.eval(code);
  }

  openEnvs.add({ dom, window });

  return { dom, window, bridge, errors, audioCalls };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待界面进入 ready 状态 */
async function waitReady(env, timeout) {
  const limit = Date.now() + (timeout || 3000);
  while (Date.now() < limit) {
    if (env.window.document.documentElement.getAttribute('data-ready') === 'true') return true;
    await wait(20);
  }
  return false;
}

test('宠物窗口能启动并渲染初始状态', async () => {
  const env = await createEnv();
  const ready = await waitReady(env);
  assert.equal(ready, true, '页面应进入 ready 状态');
  assert.equal(env.errors.length, 0, '不应有脚本错误：' + env.errors.map((e) => e.message).join('; '));

  const doc = env.window.document;
  const pet = doc.getElementById('pet');
  assert.equal(pet.dataset.state, 'idle');
  assert.equal(doc.querySelectorAll('.pet-sprite').length, 6, '应有 6 种宠物形象');
  assert.equal(doc.querySelectorAll('.pet-sprite.active').length, 1, '同一时刻只显示一种形象');

  const selfTest = env.window.__deskbuddySelfTest();
  assert.equal(selfTest.ready, true);
  assert.equal(selfTest.sprites, 6);
  assert.equal(selfTest.effectsLayer, true);
});

test('点击宠物打开快捷菜单，再点击关闭', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;
  const pet = doc.getElementById('pet');
  const menu = doc.getElementById('quick-menu');

  assert.equal(menu.classList.contains('visible'), false);

  pet.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, screenX: 10, screenY: 10, bubbles: true }));
  pet.dispatchEvent(new window.PointerEvent('pointerup', { button: 0, screenX: 10, screenY: 10, bubbles: true }));
  await wait(30);
  assert.equal(menu.classList.contains('visible'), true, '单击应打开菜单');

  pet.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, screenX: 10, screenY: 10, bubbles: true }));
  pet.dispatchEvent(new window.PointerEvent('pointerup', { button: 0, screenX: 10, screenY: 10, bubbles: true }));
  await wait(30);
  assert.equal(menu.classList.contains('visible'), false, '再单击应关闭菜单');
});

test('本体动作控制器不会遮蔽拖动时钟，拖动后仍可打开菜单', async () => {
  const env = await createEnv(); await waitReady(env);
  const {window,bridge}=env, pet=window.document.getElementById('pet');
  const event=(type,x,y)=>pet.dispatchEvent(new window.PointerEvent(type,{button:0,screenX:x,screenY:y,bubbles:true}));
  event('pointerdown',10,10); event('pointermove',90,40); event('pointerup',90,40);
  assert.deepEqual(bridge.calls.drags,[{dx:80,dy:30}]);
  assert.equal(window.document.getElementById('quick-menu').classList.contains('visible'),false);
  event('pointerdown',90,40);event('pointerup',90,40);
  assert.equal(window.document.getElementById('quick-menu').classList.contains('visible'),true);
  assert.equal(env.errors.length,0);
});

test('菜单可以主动收起、移开自动收起、失焦关闭', async () => {
  const env=await createEnv();await waitReady(env);
  const {window}=env,doc=window.document,pet=doc.getElementById('pet'),menu=doc.getElementById('quick-menu');
  const open=()=>{for(const type of ['pointerdown','pointerup'])pet.dispatchEvent(new window.PointerEvent(type,{button:0,bubbles:true}));};
  open();doc.querySelector('[data-action="close-menu"]').click();assert.equal(menu.classList.contains('visible'),false);
  open();doc.dispatchEvent(new window.MouseEvent('mousemove',{clientX:-100,clientY:-100,bubbles:true}));await wait(500);assert.equal(menu.classList.contains('visible'),false);
  open();window.dispatchEvent(new window.Event('blur'));assert.equal(menu.classList.contains('visible'),false);
});

test('菜单可以打开任务面板与触发特效', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window, bridge } = env;
  const doc = window.document;

  const openTasks = doc.querySelector('button[data-action="open-tasks"]');
  openTasks.click();
  await wait(20);
  assert.deepEqual(bridge.calls.panels, ['tasks'], '应请求打开任务面板');

  const slash = doc.querySelector('button[data-action="effect-slash"]');
  slash.click();
  await wait(50);
  assert.equal(doc.getElementById('pet').dataset.state, 'effect', '应进入特效状态');
  assert.equal(doc.getElementById('slash-fx').classList.contains('active'), true, '刀光层应被激活');
});

test('砍刀特效能自动结束并恢复状态', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  window.__deskbuddyDispatch({ type: 'effect/play', name: 'slash', manual: true });
  await wait(40);
  assert.equal(doc.getElementById('pet').dataset.state, 'effect');

  // 等待特效时长 + 状态回落
  await wait(window.DeskBuddy.effects.DURATIONS.slash + 100);
  assert.equal(doc.getElementById('slash-fx').classList.contains('active'), false, '动画结束后应清理 DOM');
  const snap = window.__deskbuddySnapshot();
  assert.notEqual(snap.pet, 'effect', '应恢复到常态');
});

test('真正到期时通过桥接播放一次全屏提醒，手动预览也可播放', async () => {
  const calls = [];
  const env = await createEnv({ bridge: createBridge({ fullscreenFx: async (...args) => { calls.push(args); return { ok: true }; } }) });
  await waitReady(env);
  const { window } = env;
  window.__deskbuddyDispatch({ type: 'focus/start', minutes: 1 });
  const due = Date.now() + 2 * 60 * 1000;
  window.__deskbuddyDispatch({ type: 'tick', now: due });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'reminder');
  assert.equal(calls[0][2], 'focus_done');
  assert.equal(window.__deskbuddySnapshot().pet, 'reminder');
  window.__deskbuddyDispatch({ type: 'tick', now: due + 1000 });
  assert.equal(calls.length, 1);
  window.document.querySelector('[data-action="effect-reminder"]').click();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'reminder');
});

test('全屏成功时不叠加局部裂纹，全屏失败时显示本地玻璃兜底', async () => {
  for (const ok of [true, false]) {
    const env = await createEnv({ bridge: createBridge({ fullscreenFx: async () => ({ ok }) }) });
    await waitReady(env);
    env.window.__deskbuddyDispatch({ type: 'effect/play', name: 'crack', manual: true });
    await wait(30);
    const local = env.window.document.getElementById('crack-fx');
    assert.equal(local.classList.contains('active'), !ok);
    assert.equal(local.querySelectorAll('.glass-fracture path').length > 0, !ok);
  }
});

test('裂屏特效能播放并清理', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  window.__deskbuddyDispatch({ type: 'effect/play', name: 'crack', manual: true });
  await wait(40);
  assert.equal(doc.getElementById('crack-fx').classList.contains('active'), true);

  await wait(window.DeskBuddy.effects.DURATIONS.crack + 100);
  assert.equal(doc.getElementById('crack-fx').classList.contains('active'), false);
});

test('关闭特效后不再播放动画，但界面不崩', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  window.__deskbuddyDispatch({ type: 'settings/update', patch: { effectsEnabled: false } });
  await wait(30);
  assert.equal(doc.body.dataset.motion, 'off');

  const result = window.__deskbuddyDispatch({ type: 'effect/play', name: 'slash' });
  assert.equal(result.ok, false, '自动特效应被拒绝');
  await wait(60);
  assert.notEqual(doc.getElementById('pet').dataset.state, 'effect');
});

test('添加任务后气泡出现且列表更新', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  const result = window.__deskbuddyDispatch({ type: 'tasks/add', title: '写完 README' });
  assert.equal(result.ok, true);
  await wait(40);

  assert.equal(window.__deskbuddySnapshot().tasks, 1);
  const bubble = doc.getElementById('bubble');
  assert.equal(bubble.classList.contains('visible'), true);
  assert.match(doc.getElementById('bubble-text').textContent, /README/);
});

test('完成任务触发庆祝与撒花', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window, bridge } = env;
  const doc = window.document;

  // 捕获广播出来的快照，从中取真实任务 id
  let captured = null;
  bridge.broadcastState = async (snap) => {
    captured = snap;
    return { ok: true };
  };

  window.__deskbuddyDispatch({ type: 'tasks/add', title: '唯一任务' });
  await wait(30);

  // 触发一次 tick 以便广播快照
  window.__deskbuddyDispatch({ type: 'tick', now: Date.now() });
  await wait(120);
  assert.ok(captured && captured.tasks.length === 1, '应广播含任务的快照');

  const taskId = captured.tasks[0].id;
  window.__deskbuddyDispatch({ type: 'tasks/toggle', id: taskId });
  await wait(60);

  const snap = window.__deskbuddySnapshot();
  assert.equal(snap.pet, 'celebration', '全部完成后进入庆祝');
  assert.equal(doc.getElementById('confetti-fx').classList.contains('active'), true, '应播放撒花');
  assert.match(doc.getElementById('bubble-text').textContent, /完成|小红花|收工|清单|任务清空|烟花/);
});

test('免打扰开关会改变宠物状态并阻止闲聊', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  doc.querySelector('button[data-action="toggle-dnd"]').click();
  await wait(50);

  const snap = window.__deskbuddySnapshot();
  assert.equal(snap.doNotDisturb, true);
  assert.equal(snap.pet, 'do_not_disturb');
  assert.equal(doc.getElementById('dnd-badge').classList.contains('visible'), true);

  const chatter = window.__deskbuddyDispatch({ type: 'chatter' });
  assert.equal(chatter.ok, false, '免打扰时不应闲聊');
});

test('专注倒计时显示在胶囊里并逐秒减少', async () => {
  const env = await createEnv();
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  window.__deskbuddyDispatch({ type: 'focus/start', minutes: 1 });
  await wait(80);

  const pill = doc.getElementById('focus-pill');
  assert.equal(pill.classList.contains('visible'), true);
  const first = doc.getElementById('focus-pill-text').textContent;
  assert.match(first, /^0[01]:\d{2}$/);

  await wait(1200);
  const second = doc.getElementById('focus-pill-text').textContent;
  assert.notEqual(first, second, '倒计时应在走');
  assert.equal(doc.getElementById('pet').dataset.state, 'focus');
});

test('数据保存失败时给出可见提示，而不是静默失败', async () => {
  const bridge = createBridge({
    saveTasks: async () => ({ ok: false, error: '磁盘只读' })
  });
  const env = await createEnv({ bridge });
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  window.__deskbuddyDispatch({ type: 'tasks/add', title: '会保存失败的任务' });
  await wait(600);

  const toasts = doc.querySelectorAll('.toast');
  assert.ok(toasts.length > 0, '应出现提示');
  const text = Array.from(toasts).map((t) => t.textContent).join(' ');
  assert.match(text, /保存失败/);
});

test('读取数据失败时回退默认值并提示', async () => {
  const bridge = createBridge({
    loadState: async () => {
      throw new Error('文件被占用');
    }
  });
  const env = await createEnv({ bridge });
  await waitReady(env);
  await wait(80);

  const doc = env.window.document;
  const text = Array.from(doc.querySelectorAll('.toast')).map((t) => t.textContent).join(' ');
  assert.match(text, /读取本地数据失败|默认设置/);
  assert.equal(env.window.__deskbuddySnapshot().tasks, 0, '应回退到空任务列表');
});

test('损坏的设置被修复后仍能启动', async () => {
  const bridge = createBridge({
    loadState: async () => ({
      ok: true,
      tasks: 'not-an-array',
      settings: { focusDurationMinutes: 'x', soundEnabled: 'nope', doNotDisturb: 3 },
      session: null,
      issues: []
    })
  });
  const env = await createEnv({ bridge });
  await waitReady(env);
  await wait(60);

  const selfTest = env.window.__deskbuddySelfTest();
  assert.equal(selfTest.ready, true);
  assert.equal(selfTest.tasks, 0);
  // 设置被修复为默认值，界面不崩
  assert.equal(env.window.__deskbuddySnapshot().pet, 'idle');
});

test('面板窗口：任务表单可以添加并勾选任务', async () => {
  const env = await createEnv({ panel: 'tasks' });
  await waitReady(env);
  const { window, bridge } = env;
  const doc = window.document;
  assert.equal(doc.getElementById('pet-view').hidden, true, '面板不能被桌宠画布挤到窗口下方');
  assert.equal(doc.getElementById('panel-view').hidden, false);

  // 面板通过 IPC 转发动作，这里让 dispatch 直接落到同一个状态机
  const dispatched = [];
  bridge.dispatch = async (action) => {
    dispatched.push(action);
    return { ok: true };
  };

  const input = doc.getElementById('task-input');
  input.value = '面板里加的任务';
  doc.getElementById('task-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await wait(30);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'tasks/add');
  assert.equal(dispatched[0].title, '面板里加的任务');
  assert.equal(input.value, '', '提交后应清空输入框');
});

test('面板窗口：空标题给出错误提示且不发送动作', async () => {
  const env = await createEnv({ panel: 'tasks' });
  await waitReady(env);
  const { window, bridge } = env;
  const doc = window.document;

  const dispatched = [];
  bridge.dispatch = async (action) => {
    dispatched.push(action);
    return { ok: true };
  };

  doc.getElementById('task-input').value = '   ';
  doc.getElementById('task-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(20);

  assert.equal(dispatched.length, 0);
  assert.equal(doc.getElementById('task-error').classList.contains('visible'), true);
});

test('面板窗口：收到快照后渲染任务列表', async () => {
  const env = await createEnv({ panel: 'tasks' });
  await waitReady(env);
  const { window } = env;
  const doc = window.document;

  const now = Date.now();
  const snapshot = {
    tasks: [
      { id: 't1', title: '任务一', completed: false, createdAt: now, dueAt: null },
      { id: 't2', title: '任务二', completed: true, createdAt: now, dueAt: null }
    ],
    stats: { days: {}, totalCompleted: 1, totalFocusSessions: 0, streak: 0, lastActiveDay: '' },
    settings: {},
    timers: window.DeskBuddy.timers.createInitialState(),
    pet: { current: 'idle' },
    ui: { bubble: null, companionMode: false, focusTaskId: null }
  };

  env.bridge.emit({ channel: 'app:snapshot', payload: snapshot });
  await wait(80);

  const pending = doc.querySelectorAll('#task-list-pending .task-item');
  const done = doc.querySelectorAll('#task-list-done .task-item');
  assert.equal(pending.length, 1, '未完成任务应有 1 条');
  assert.equal(done.length, 1, '已完成任务应有 1 条');
  assert.match(doc.getElementById('task-progress-text').textContent, /1 \/ 2/);
  assert.equal(doc.getElementById('task-progress-pct').textContent, '50%');
});

test('面板窗口：点击勾选框派发完成动作', async () => {
  const env = await createEnv({ panel: 'tasks' });
  await waitReady(env);
  const { window, bridge } = env;
  const doc = window.document;

  const dispatched = [];
  bridge.dispatch = async (action) => {
    dispatched.push(action);
    return { ok: true };
  };

  env.bridge.emit({
    channel: 'app:snapshot',
    payload: {
      tasks: [{ id: 'abc', title: '要点掉的任务', completed: false, createdAt: Date.now(), dueAt: null }],
      stats: { days: {} },
      settings: {},
      timers: window.DeskBuddy.timers.createInitialState(),
      pet: { current: 'idle' },
      ui: {}
    }
  });
  await wait(80);

  const check = doc.querySelector('#task-list-pending .task-check');
  assert.ok(check, '应渲染出勾选框');
  check.click();
  await wait(30);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'tasks/toggle');
  assert.equal(dispatched[0].id, 'abc');
});

test('面板窗口：专注按钮按状态切换文案与动作', async () => {
  const env = await createEnv({ panel: 'focus' });
  await waitReady(env);
  const { window, bridge } = env;
  const doc = window.document;

  const dispatched = [];
  bridge.dispatch = async (action) => {
    dispatched.push(action);
    return { ok: true };
  };

  env.bridge.emit({
    channel: 'app:snapshot',
    payload: {
      tasks: [],
      stats: { days: {} },
      settings: { focusDurationMinutes: 25 },
      timers: window.DeskBuddy.timers.createInitialState(),
      pet: { current: 'idle' },
      ui: {}
    }
  });
  await wait(80);

  assert.equal(doc.getElementById('focus-primary').textContent, '开始专注');
  doc.getElementById('focus-primary').click();
  await wait(30);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'focus/start');
});

test('日常动作能切换挥手帧，关闭日常动作后立即复位', async () => {
  const env = await createEnv(); await waitReady(env);
  const { window } = env;
  window.__deskbuddyLifePreview('wave');
  assert.equal(window.document.getElementById('pet').dataset.life,'wave');
  assert.match(window.document.getElementById('pet-life-frame').src,/girl-wave/);
  window.__deskbuddyDispatch({type:'settings/update',patch:{lifeEnabled:false}});
  assert.equal(window.document.getElementById('pet-life-frame').hidden,true);
  assert.equal(window.document.getElementById('pet').dataset.living,'off');
});

test('主动递水走受限来访接口，设置面板能开启督促和保存应用列表', async () => {
  const visits=[];
  const bridge=createBridge();bridge.window.visit=async(kind)=>{visits.push(kind);return {ok:true};};
  const env=await createEnv({bridge});await waitReady(env);
  env.window.__deskbuddyDispatch({type:'initiative/demo',kind:'water'});await wait(30);
  assert.deepEqual(visits,['water']);
  assert.equal(env.window.__deskbuddySnapshot().bubble,'water');
  const panel=await createEnv({panel:'settings'});await waitReady(panel);
  const sent=[];panel.bridge.dispatch=async(action)=>{sent.push(action);return {ok:true};};
  panel.window.document.getElementById('game-guard-setting').click();
  panel.window.document.getElementById('entertainment-apps').value='cs2.exe';
  panel.window.document.getElementById('save-entertainment-apps').click();
  await wait(20);
  assert.equal(sent[0].patch.gameGuardEnabled,true);
  assert.equal(sent[1].patch.entertainmentApps,'cs2.exe');
});
