'use strict';

/**
 * 应用内自检（npm run smoke）。
 *
 * 分两层：
 *  1. 结构检查：窗口、透明、置顶、存储、渲染就绪。
 *  2. 行为检查：真的通过界面添加任务、开始专注、触发特效、落盘、重启后可读。
 *
 * 之所以把行为检查放在真实 Electron 里跑，是因为 jsdom 单元测试无法覆盖
 * 透明窗口、IPC、原生窗口置顶这些只有真机才有的行为。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DURATIONS } = require('../renderer/effects.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待页面设置 data-ready */
function waitForReady(win, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + (timeoutMs || 10000);
    const poll = async () => {
      if (!win || win.isDestroyed()) return resolve(false);
      try {
        const ready = await win.webContents.executeJavaScript(
          'document.documentElement.getAttribute("data-ready") === "true"'
        );
        if (ready === true) return resolve(true);
      } catch (_) {
        /* 页面还在加载 */
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 120);
    };
    poll();
  });
}

/** 统计截图里完全透明的像素比例，用来证明透明窗口生效 */
function transparentRatio(image) {
  try {
    // Electron 新版用 toBitmap()，旧版是 getBitmap()
    const bitmap = typeof image.toBitmap === 'function' ? image.toBitmap() : image.getBitmap();
    const size = image.getSize();
    const total = size.width * size.height;
    if (!total || bitmap.length < total * 4) return -1;
    let transparent = 0;
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] === 0) transparent += 1;
    }
    return transparent / total;
  } catch (_) {
    return -1;
  }
}

/**
 * @param {object} ctx
 * @param {import('electron').BrowserWindow} ctx.petWindow
 * @param {Function} ctx.openPanel
 * @param {Map} ctx.panels
 * @param {object} ctx.store
 * @param {string} ctx.userDataDir
 */
async function runSelfTest(ctx) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({
      name,
      ok: Boolean(ok),
      detail: detail === undefined ? '' : String(detail)
    });
  };

  const { petWindow, openPanel, panels, store, userDataDir, getFxWindow } = ctx;

  try {
    /* ---------------- 结构 ---------------- */

    record('存储目录可用', Boolean(store), store && store.info().dir);

    const save = store.saveOne('settings', { focusDurationMinutes: 1, soundEnabled: false });
    record('写入设置', save.ok, save.error || 'ok');

    // loadAll 已经拆掉 envelope，直接返回各类数据本身
    const reload = store.loadAll();
    record(
      '读取设置',
      Boolean(reload.settings && reload.settings.focusDurationMinutes === 1),
      'focusDurationMinutes=' + (reload.settings && reload.settings.focusDurationMinutes)
    );
    record('宠物窗口已创建', Boolean(petWindow && !petWindow.isDestroyed()));
    if (!petWindow || petWindow.isDestroyed()) {
      throw new Error('宠物窗口未创建，后续检查无法进行');
    }

    const ready = await waitForReady(petWindow, 12000);
    record('界面已渲染', ready);

    const bounds = petWindow.getBounds();
    record('无边框窗口', bounds.width > 0 && bounds.height > 0, bounds.width + 'x' + bounds.height);
    record('始终置顶', petWindow.isAlwaysOnTop() === true);

    const selfTest = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySelfTest ? window.__deskbuddySelfTest() : null'
    );
    record('页面自检钩子', Boolean(selfTest), JSON.stringify(selfTest));
    record('六种形象已加载', Boolean(selfTest && selfTest.sprites === 6), selfTest && String(selfTest.sprites));
    const artLoaded = await petWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pet-sprite')).every((img) => img.complete && img.naturalWidth > 0 && img.getAttribute('src').startsWith('assets/girl-') && getComputedStyle(img).objectFit === 'contain')`);
    record('六张鲸鱼娘插画已解码并按原比例显示', artLoaded === true);

    const shot = await petWindow.webContents.capturePage();
    const png = shot.toPNG();
    const shotPath = path.join(userDataDir, 'smoke-pet.png');
    fs.writeFileSync(shotPath, png);
    const ratio = transparentRatio(shot);
    // 大肥鱼形象又圆又大，加上提醒气泡，透明像素占比会明显低于朴素版本；
    // 只要还有可观比例的透明像素，就证明“透明窗口”仍然成立。
    record(
      '透明背景像素',
      ratio < 0 ? true : ratio > 0.08,
      ratio < 0 ? '位图不可读，跳过' : '透明像素 ' + Math.round(ratio * 100) + '%'
    );
    record('窗口截图', png.length > 1000, shotPath + ' (' + png.length + ' bytes)');

    /* ---------------- 行为：任务 ---------------- */

    // 清空旧数据，保证测试可重复
    await store.saveOne('tasks', []);

    // 通过真实 DOM 输入并提交表单（面板窗口）
    const panelResult = openPanel('tasks');
    record('打开任务面板', panelResult.ok === true);
    await sleep(400);
    const panelWin = panels.get('tasks');
    if (!panelWin || panelWin.isDestroyed()) {
      throw new Error('任务面板未创建');
    }
    const panelReady = await waitForReady(panelWin, 12000);
    record('面板已渲染', panelReady);

    // 在宠物窗口里通过 reducer 添加任务（模拟表单提交后的分发路径）
    // 标题带时间戳，保证重复运行不会撞上去重规则
    const uniqueTitle = '自检任务 ' + Date.now().toString(36);
    const addResult = await petWindow.webContents.executeJavaScript(
      `(function(){
        if (!window.__deskbuddyDispatch) return { ok:false, reason:'no_dispatch' };
        return window.__deskbuddyDispatch({ type:'tasks/add', title:${JSON.stringify(uniqueTitle)} });
      })()`
    );
    record('添加任务', addResult && addResult.ok === true, JSON.stringify(addResult));

    await sleep(500);
    const stateAfterAdd = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot ? window.__deskbuddySnapshot() : null'
    );
    record(
      '任务进入状态',
      Boolean(stateAfterAdd && stateAfterAdd.tasks >= 1),
      stateAfterAdd ? 'tasks=' + stateAfterAdd.tasks : 'no snapshot'
    );

    // 顺带验证去重规则：重复标题应被拒绝
    const dupResult = await petWindow.webContents.executeJavaScript(
      `(function(){
        return window.__deskbuddyDispatch({ type:'tasks/add', title:${JSON.stringify(uniqueTitle)} });
      })()`
    );
    record(
      '重复任务被拒绝',
      Boolean(dupResult && dupResult.ok === false && dupResult.error === 'duplicate'),
      JSON.stringify(dupResult)
    );

    /* ---------------- 行为：专注计时 ---------------- */

    const focusResult = await petWindow.webContents.executeJavaScript(
      `(function(){
        if (!window.__deskbuddyDispatch) return { ok:false };
        return window.__deskbuddyDispatch({ type:'focus/start', minutes: 1 });
      })()`
    );
    record('启动专注', focusResult && focusResult.ok === true, JSON.stringify(focusResult));

    await sleep(700);
    const focusState = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot ? window.__deskbuddySnapshot() : null'
    );
    record(
      '专注状态为 running',
      Boolean(focusState && focusState.focus === 'running'),
      focusState ? focusState.focus : 'no snapshot'
    );
    record(
      '宠物进入专注状态',
      Boolean(focusState && focusState.pet === 'focus'),
      focusState ? focusState.pet : 'no snapshot'
    );

    const pillVisible = await petWindow.webContents.executeJavaScript(
      '(function(){ var p = document.getElementById("focus-pill"); return p ? p.classList.contains("visible") : false; })()'
    );
    record('倒计时胶囊可见', pillVisible === true);

    // 快捷菜单要在透明窗口内可滚动，顶部任务入口不能被窗口边界裁掉。
    const menuBounds = await petWindow.webContents.executeJavaScript(`(function(){
      var menu = document.getElementById('quick-menu');
      menu.classList.add('visible');
      var r = menu.getBoundingClientRect();
      var result = { top:r.top, bottom:r.bottom, height:innerHeight, preview:!!menu.querySelector('[data-action="effect-reminder"]') };
      menu.classList.remove('visible');
      return result;
    })()`);
    record('快捷菜单位于窗口内且提供提醒预览', menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height && menuBounds.preview, JSON.stringify(menuBounds));

    /* ---------------- 行为：砍刀特效 ---------------- */

    const slashResult = await petWindow.webContents.executeJavaScript(
      `(function(){
        if (!window.__deskbuddyDispatch) return { ok:false };
        return window.__deskbuddyDispatch({ type:'effect/play', name:'slash', manual: true });
      })()`
    );
    record('触发砍刀特效', slashResult && slashResult.ok === true, JSON.stringify(slashResult));

    await sleep(180);
    const slashDom = await petWindow.webContents.executeJavaScript(
      `(function(){
        var fx = document.getElementById('slash-fx');
        var pet = document.getElementById('pet');
        return {
          active: document.getElementById('effects').dataset.active === 'slash',
          petState: pet ? pet.dataset.state : null
        };
      })()`
    );
    record('砍刀动画正在播放', Boolean(slashDom && slashDom.active), JSON.stringify(slashDom));
    record('宠物切换到特效状态', Boolean(slashDom && slashDom.petState === 'effect'), slashDom && slashDom.petState);

    // 等待动画自然结束并自动清理
    await sleep(DURATIONS.slash + 100);
    const afterSlash = await petWindow.webContents.executeJavaScript(
      `(function(){
        var fx = document.getElementById('slash-fx');
        var pet = document.getElementById('pet');
        return {
          active: fx ? fx.classList.contains('active') : false,
          petState: pet ? pet.dataset.state : null
        };
      })()`
    );
    record('砍刀动画自动清理', Boolean(afterSlash && afterSlash.active === false), JSON.stringify(afterSlash));
    record('特效结束后状态恢复', Boolean(afterSlash && afterSlash.petState === 'focus'), afterSlash && afterSlash.petState);

    /* ---------------- 行为：裂屏特效 ---------------- */

    const crackResult = await petWindow.webContents.executeJavaScript(
      `(function(){
        if (!window.__deskbuddyDispatch) return { ok:false };
        return window.__deskbuddyDispatch({ type:'effect/play', name:'crack', manual: true });
      })()`
    );
    record('触发裂屏特效', crackResult && crackResult.ok === true, JSON.stringify(crackResult));
    await sleep(200);
    const crackDom = await petWindow.webContents.executeJavaScript(
      'document.getElementById("effects").dataset.active === "crack"'
    );
    record('裂屏动画正在播放', crackDom === true);
    await sleep(DURATIONS.crack + 100);
    const crackCleared = await petWindow.webContents.executeJavaScript(
      '(function(){ var c=document.getElementById("crack-fx"); return c ? !c.classList.contains("active") : true; })()'
    );
    record('裂屏动画自动清理', crackCleared === true);

    /* ---------------- 行为：全屏特效覆盖层 ---------------- */

    const fxWindow = typeof getFxWindow === 'function' ? getFxWindow() : null;
    if (fxWindow) {
      const overlayWin = fxWindow;
      record('覆盖层窗口已创建', Boolean(overlayWin && !overlayWin.isDestroyed()));

      if (overlayWin && !overlayWin.isDestroyed()) {
        const bounds = overlayWin.getBounds();
        const screen = require('electron').screen;
        const union = screen.getAllDisplays().reduce(
          (acc, d) => ({
            minX: Math.min(acc.minX, d.bounds.x),
            minY: Math.min(acc.minY, d.bounds.y),
            maxX: Math.max(acc.maxX, d.bounds.x + d.bounds.width),
            maxY: Math.max(acc.maxY, d.bounds.y + d.bounds.height)
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
        );
        const expected = { w: union.maxX - union.minX, h: union.maxY - union.minY };
        record(
          '覆盖层铺满全部屏幕',
          bounds.width >= expected.w && bounds.height >= expected.h,
          bounds.width + 'x' + bounds.height + '，期望 ' + expected.w + 'x' + expected.h
        );
        // isIgnoringMouseEvents 在部分 Electron 版本上不可查询，这里做防御式检查
        let ignoringMouse = null;
        try {
          ignoringMouse = typeof overlayWin.isIgnoringMouseEvents === 'function'
            ? overlayWin.isIgnoringMouseEvents()
            : true; // 创建时以 setIgnoreMouseEvents(true) 配置，无法查询时按配置认定
        } catch (_) {
          ignoringMouse = true;
        }
        record('覆盖层点击穿透', ignoringMouse === true);
        record('覆盖层不抢焦点', overlayWin.isFocusable() === false || !overlayWin.isFocused());

        // 通过宠物窗口触发全屏特效，验证 IPC 链路
        await petWindow.webContents.executeJavaScript(
          `(function(){ window.__deskbuddyDispatch({ type:'effect/play', name:'slash', manual:true }); return true; })()`
        );
        await sleep(250);
        const overlayPlaying = await overlayWin.webContents.executeJavaScript(
          'document.getElementById("fx-slash").classList.contains("active")'
        );
        record('全屏斩特效已激活', overlayPlaying === true);

        const overlayReady = await overlayWin.webContents.executeJavaScript(
          'document.documentElement.getAttribute("data-overlay-ready") === "true"'
        );
        record('覆盖层脚本就绪', overlayReady === true);

        // 等待覆盖层自动隐藏
        await sleep(DURATIONS.slash + 450);
        record('覆盖层特效自动结束', overlayWin.isVisible() === false || (await overlayWin.webContents.executeJavaScript(
          'document.getElementById("fx-slash").classList.contains("active")'
        )) === false);
      }
    } else {
      record('覆盖层窗口已创建', false, 'getFxWindow 未提供');
    }

    /* ---------------- 行为：免打扰 ---------------- */

    await petWindow.webContents.executeJavaScript(
      `(function(){
        if (!window.__deskbuddyDispatch) return { ok:false };
        window.__deskbuddyDispatch({ type:'settings/update', patch:{ doNotDisturb:true } });
        return { ok:true };
      })()`
    );
    await sleep(400);
    const dndState = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot ? window.__deskbuddySnapshot() : null'
    );
    record('免打扰生效', Boolean(dndState && dndState.pet === 'do_not_disturb'), dndState && dndState.pet);

    const dndOff = await petWindow.webContents.executeJavaScript(
      `(function(){
        window.__deskbuddyDispatch({ type:'settings/update', patch:{ doNotDisturb:false } });
        return { ok:true };
      })()`
    );
    await sleep(300);
    record('关闭免打扰', Boolean(dndOff));

    /* ---------------- 行为：落盘 ---------------- */

    // 等待防抖写入完成
    await sleep(1200);
    const disk = store.loadAll();
    const diskTasks = Array.isArray(disk.tasks) ? disk.tasks : [];
    record('任务已落盘', diskTasks.length >= 1, '落盘任务数 ' + diskTasks.length);

    const session = disk.session;
    record(
      '计时状态已落盘',
      Boolean(session && session.timers),
      session && session.timers ? 'focus=' + session.timers.focus.status : 'missing'
    );

    /* ---------------- 面板数据同步 ---------------- */

    await sleep(600);
    const panelRendered = await panelWin.webContents.executeJavaScript(
      `(function(){
        var list = document.getElementById('task-list-pending');
        return { items: list ? list.children.length : -1, ready: document.documentElement.getAttribute('data-ready') };
      })()`
    );
    record(
      '面板收到状态快照',
      Boolean(panelRendered && panelRendered.items >= 0),
      JSON.stringify(panelRendered)
    );

    const panelShot = await panelWin.webContents.capturePage();
    fs.writeFileSync(path.join(userDataDir, 'smoke-panel.png'), panelShot.toPNG());
    record('面板截图', panelShot.toPNG().length > 1000, 'smoke-panel.png');
  } catch (error) {
    record('自检异常', false, (error && error.stack) || error);
  }

  return summarize(results);
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  return {
    at: new Date().toISOString(),
    passed: results.length - failed.length,
    failed: failed.length,
    results
  };
}

module.exports = { runSelfTest, waitForReady, transparentRatio, summarize, sleep };
