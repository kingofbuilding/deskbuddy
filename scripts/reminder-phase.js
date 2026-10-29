'use strict';

/**
 * 提醒闭环验证（由 scripts/reminder-test.js 启动）。
 *
 * 为了让“专注到期”在测试里立刻发生，直接把计时器的 endsAt 改成过去时间，
 * 而不是缩短真实等待——这样验证的仍是生产路径（tick -> 到期 -> 提醒 -> 用户选择）。
 */
const out = (line) => process.stdout.write(line + '\n');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(win, limitMs) {
  const deadline = Date.now() + (limitMs || 15000);
  while (Date.now() < deadline) {
    try {
      const ready = await win.webContents.executeJavaScript(
        'document.documentElement.getAttribute("data-ready") === "true"'
      );
      if (ready) return true;
    } catch (_) {
      /* 加载中 */
    }
    await sleep(150);
  }
  return false;
}

/**
 * @param {{app:any, petWindow:any, store:any}} ctx
 */
async function run(ctx) {
  const { app, petWindow, store } = ctx;
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
    out((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail !== undefined ? ' :: ' + detail : ''));
  };

  try {
    const ready = await waitReady(petWindow);
    record('界面就绪', ready);
    if (!ready) throw new Error('界面未就绪');

    await store.saveOne('tasks', []);

    const add = await petWindow.webContents.executeJavaScript(
      `window.__deskbuddyDispatch({ type:'tasks/add', title:'提醒流程任务' })`
    );
    record('添加任务', add && add.ok === true);

    // 取任务 id
    let captured = null;
    await petWindow.webContents.executeJavaScript(
      `(function(){
         // 借用 broadcastState 拿到最新快照
         return true;
       })()`
    );

    const snapshotBefore = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot ? window.__deskbuddySnapshot() : null'
    );
    record(
      '初始没有主动提醒',
      snapshotBefore && snapshotBefore.bubble !== 'focus_done' && snapshotBefore.bubble !== 'break',
      'bubble=' + (snapshotBefore && snapshotBefore.bubble)
    );

    // 开始 1 分钟专注
    const start = await petWindow.webContents.executeJavaScript(
      `window.__deskbuddyDispatch({ type:'focus/start', minutes: 1 })`
    );
    record('开始专注', start && start.ok === true);

    await sleep(300);
    const running = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot()'
    );
    record('专注运行中', running && running.focus === 'running', running && running.focus);

    // 把结束时间改到过去 —— 模拟“专注已经到点”
    const forced = await petWindow.webContents.executeJavaScript(
      `(function(){
        var api = window.DeskBuddy;
        // 通过 dispatch 不改内部字段，这里用 tick 的 now 推进两分钟，等价于时间流逝
        return window.__deskbuddyDispatch({ type:'tick', now: Date.now() + 2 * 60 * 1000 });
      })()`
    );
    record('推进时间到到期点', forced && forced.ok === true);

    await sleep(400);
    const afterDue = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot()'
    );
    record('专注已结束', afterDue && afterDue.focus === 'idle', afterDue && afterDue.focus);
    record('弹出专注提醒', afterDue && afterDue.bubble === 'focus_done', afterDue && afterDue.bubble);
    record('宠物进入提醒状态', afterDue && afterDue.pet === 'reminder', afterDue && afterDue.pet);

    // 界面上必须真的显示按钮
    const bubbleUi = await petWindow.webContents.executeJavaScript(
      `(function(){
        var b = document.getElementById('bubble');
        var buttons = b ? Array.from(b.querySelectorAll('button[data-action-id]')) : [];
        return {
          visible: b ? b.classList.contains('visible') : false,
          actionIds: buttons.map(function(x){ return x.dataset.actionId; }),
          text: document.getElementById('bubble-text').textContent
        };
      })()`
    );
    record('气泡可见', bubbleUi && bubbleUi.visible === true);
    record(
      '提供四个操作',
      bubbleUi && bubbleUi.actionIds.join(',') === 'complete,extend,snooze,break',
      bubbleUi && bubbleUi.actionIds.join(',')
    );

    // 点“我完成了”。这条专注没有关联任务，因此会进入任务确认流程
    const clicked = await petWindow.webContents.executeJavaScript(
      `(function(){
        var btn = document.querySelector('#bubble-actions button[data-action-id="complete"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`
    );
    record('点击“我完成了”', clicked === true);

    await sleep(400);
    const afterClick = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot()'
    );
    record(
      '进入任务确认流程',
      afterClick && afterClick.bubble === 'task_pick',
      afterClick && afterClick.bubble
    );

    const pickButtons = await petWindow.webContents.executeJavaScript(
      `(function(){
        var list = document.querySelectorAll('#bubble-actions button[data-action-id^="pick:"]');
        return { count: list.length, ids: Array.from(list).map(function(b){ return b.dataset.actionId; }) };
      })()`
    );
    record('提供可选任务', pickButtons && pickButtons.count >= 2, JSON.stringify(pickButtons));

    // 选第一条任务
    const picked = await petWindow.webContents.executeJavaScript(
      `(function(){
        var btn = document.querySelector('#bubble-actions button[data-action-id^="pick:"]:not([data-action-id="pick:none"])');
        if (!btn) return false;
        btn.click();
        return true;
      })()`
    );
    record('选择要完成的任务', picked === true);

    await sleep(500);
    const afterComplete = await petWindow.webContents.executeJavaScript(
      'window.__deskbuddySnapshot()'
    );
    record('任务已完成', afterComplete && afterComplete.completed >= 1, JSON.stringify(afterComplete));
    record(
      '进入庆祝状态',
      afterComplete && (afterComplete.pet === 'celebration' || afterComplete.pet === 'idle'),
      afterComplete && afterComplete.pet
    );
    record('提醒气泡已关闭', afterComplete && afterComplete.bubble !== 'focus_done', afterComplete && afterComplete.bubble);

    // 落盘检查
    await sleep(1200);
    const disk = store.loadAll();
    const diskTasks = Array.isArray(disk.tasks) ? disk.tasks : [];
    const completedOnDisk = diskTasks.filter((t) => t.completed).length;
    record('完成任务已落盘', completedOnDisk >= 1, '已完成 ' + completedOnDisk + ' 条');
    const session = disk.session;
    record(
      '专注轮次已记录',
      Boolean(session && session.timers && session.timers.focus.completedSessions >= 1),
      session && session.timers ? String(session.timers.focus.completedSessions) : 'none'
    );
  } catch (error) {
    record('测试异常', false, (error && error.stack) || error);
  }

  const failed = results.filter((r) => !r.ok).length;
  out('PHASE_RESULT=' + (failed === 0 ? 'PASS' : 'FAIL'));
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200);
}

module.exports = { run };
