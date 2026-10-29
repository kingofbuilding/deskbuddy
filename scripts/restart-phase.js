'use strict';

/**
 * 重启恢复的两个阶段（由 scripts/restart-test.js 以不同进程调用）。
 *
 *  write  ：添加任务 + 开始 1 分钟专注，然后立刻退出（模拟用户直接关窗口）。
 *  verify ：重新启动，检查任务仍在、专注按剩余时间继续（而不是重新计时）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ARGV = new Set(process.argv.slice(1));
const PHASE = (() => {
  for (const arg of ARGV) {
    if (arg.startsWith('--restart-test=')) return arg.split('=')[1];
  }
  return null;
})();

function out(line) {
  process.stdout.write(line + '\n');
}

function summarize(state) {
  return {
    tasks: state.tasks.length,
    titles: state.tasks.map((t) => t.title),
    focusStatus: state.timers.focus.status,
    focusEndsAt: state.timers.focus.endsAt,
    focusTaskId: state.timers.focus.taskId,
    pet: state.pet.current,
    settings: {
      focusDurationMinutes: state.settings.focusDurationMinutes,
      soundEnabled: state.settings.soundEnabled,
      alwaysOnTop: state.settings.alwaysOnTop
    }
  };
}

/**
 * @param {{app:any, BrowserWindow:any, ipcMain:any, store:any, petWindow:any, settingsCore:any}} ctx
 */
async function runPhase(ctx) {
  const { app, store, petWindow } = ctx;
  const core = require('../src/renderer/core/app-state.js');

  // 等界面 ready 以便调用页面内的 dispatch
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      ready = await petWindow.webContents.executeJavaScript(
        'document.documentElement.getAttribute("data-ready") === "true"'
      );
      if (ready) break;
    } catch (_) {
      /* 还在加载 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    out('PHASE_RESULT=FAIL reason=not_ready');
    app.exit(1);
    return;
  }

  if (PHASE === 'write') {
    // 清空旧任务，保证可重复
    await store.saveOne('tasks', []);

    const add = await petWindow.webContents.executeJavaScript(
      `window.__deskbuddyDispatch({ type:'tasks/add', title:'重启后仍然存在的任务' })`
    );
    out('add=' + JSON.stringify(add));

    // 用 20 分钟：足够覆盖两次进程启动之间的间隔，才能真正验证“恢复剩余时间”
    const start = await petWindow.webContents.executeJavaScript(
      `window.__deskbuddyDispatch({ type:'focus/start', minutes: 20 })`
    );
    out('start=' + JSON.stringify(start));

    // 等防抖落盘完成
    await new Promise((r) => setTimeout(r, 1500));

    const snap = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot ? window.__deskbuddySnapshot() : null'
    );
    out('snapshot_before_exit=' + JSON.stringify(snap));

    const disk = store.loadAll();
    out(
      'disk_tasks=' +
        (Array.isArray(disk.tasks) ? disk.tasks.length : -1) +
        ' disk_focus=' +
        (disk.session && disk.session.timers ? disk.session.timers.focus.status : 'none')
    );

    const pass =
      snap &&
      snap.tasks >= 1 &&
      snap.focus === 'running' &&
      Array.isArray(disk.tasks) &&
      disk.tasks.length >= 1;
    out('PHASE_RESULT=' + (pass ? 'PASS' : 'FAIL'));
    app.exit(pass ? 0 : 1);
    return;
  }

  if (PHASE === 'verify') {
    const snap = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot ? window.__deskbuddySnapshot() : null'
    );
    out('snapshot_after_restart=' + JSON.stringify(snap));

    const disk = store.loadAll();
    const titles = Array.isArray(disk.tasks) ? disk.tasks.map((t) => t.title) : [];
    out('disk_titles=' + JSON.stringify(titles));

    const storedFocus = disk.session && disk.session.timers ? disk.session.timers.focus : null;
    out('disk_focus=' + JSON.stringify(storedFocus));

    const tasksRestored = Boolean(snap && snap.tasks >= 1);
    const focusRestored = Boolean(snap && snap.focus === 'running');
    const titleRestored = titles.indexOf('重启后仍然存在的任务') >= 0;

    // 恢复后必须沿用原来保存的绝对结束时间：
    // endsAt 仍在未来，且结束时间不超过“开始时间 + 总时长”
    const now = Date.now();
    const remainingOk = Boolean(
      storedFocus &&
        storedFocus.status === 'running' &&
        storedFocus.endsAt > now &&
        storedFocus.endsAt <= storedFocus.startedAt + storedFocus.totalMs &&
        storedFocus.endsAt - now < storedFocus.totalMs
    );
    out('tasks_restored=' + tasksRestored);
    out('focus_restored=' + focusRestored);
    out('title_restored=' + titleRestored);
    out('remaining_consistent=' + remainingOk);

    const pass = tasksRestored && focusRestored && titleRestored && remainingOk;
    out('PHASE_RESULT=' + (pass ? 'PASS' : 'FAIL'));
    app.exit(pass ? 0 : 1);
    return;
  }

  out('PHASE_RESULT=SKIP reason=no_phase');
  app.exit(0);
}

module.exports = { PHASE, runPhase };
