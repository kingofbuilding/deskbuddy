'use strict';

/**
 * 休息提醒 + 防轰炸验证（真实 Electron）。
 *
 * 检查点：
 *  - 到点弹出休息提醒，三个操作可见
 *  - “稍后提醒”后，延迟期内不得再次弹出
 *  - “今天不再提醒”后当天不再打扰
 *  - 免打扰开启时普通提醒被阻止
 *  - 同一时刻最多一个提醒气泡
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

async function evalJs(win, code) {
  return win.webContents.executeJavaScript(code);
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

    // 把休息间隔压到最小，并把下一次时间改成 1 秒后
    await evalJs(
      petWindow,
      `window.__deskbuddyDispatch({ type:'settings/update', patch:{ breakReminderMinutes: 5, breakRemindersEnabled: true, doNotDisturb: false } })`
    );
    await sleep(300);

    // 直接推进时间越过休息点
    await evalJs(petWindow, `window.__deskbuddyDispatch({ type:'tick', now: Date.now() + 6*60*1000 })`);
    await sleep(400);

    let snap = await evalJs(petWindow, 'window.__deskbuddySnapshot()');
    record('弹出休息提醒', snap && snap.bubble === 'break', snap && snap.bubble);
    record('宠物进入提醒状态', snap && snap.pet === 'reminder', snap && snap.pet);

    const breakUi = await evalJs(
      petWindow,
      `(function(){
        var list = document.querySelectorAll('#bubble-actions button[data-action-id]');
        return {
          ids: Array.from(list).map(function(b){ return b.dataset.actionId; }),
          visible: document.getElementById('bubble').classList.contains('visible'),
          title: document.getElementById('bubble-title').textContent
        };
      })()`
    );
    record('三个休息操作可见', breakUi && breakUi.ids.join(',') === 'confirm,snooze,suppress', breakUi && breakUi.ids.join(','));
    record('休息气泡可见', breakUi && breakUi.visible === true);

    // 同时只应有一个气泡
    const bubbleCount = await evalJs(
      petWindow,
      `document.querySelectorAll('.bubble.visible').length`
    );
    record('同一时刻只有一个气泡', bubbleCount === 1, 'count=' + bubbleCount);

    // 点“稍后提醒”
    await evalJs(
      petWindow,
      `document.querySelector('#bubble-actions button[data-action-id="snooze"]').click()`
    );
    await sleep(400);
    snap = await evalJs(petWindow, 'window.__deskbuddySnapshot()');
    record('稍后提醒后气泡关闭', snap && snap.bubble !== 'break', snap && snap.bubble);

    // 延迟期内再推进一小段时间，不应再次弹出
    await evalJs(petWindow, `window.__deskbuddyDispatch({ type:'tick', now: Date.now() + 30*1000 })`);
    await sleep(300);
    snap = await evalJs(petWindow, 'window.__deskbuddySnapshot()');
    record('延迟期内不重复提醒', snap && snap.bubble !== 'break', snap && snap.bubble);

    // 免打扰时彻底阻断
    await evalJs(
      petWindow,
      `window.__deskbuddyDispatch({ type:'settings/update', patch:{ doNotDisturb: true } })`
    );
    await sleep(200);
    await evalJs(petWindow, `window.__deskbuddyDispatch({ type:'tick', now: Date.now() + 3*60*60*1000 })`);
    await sleep(300);
    snap = await evalJs(petWindow, 'window.__deskbuddySnapshot()');
    record('免打扰阻止休息提醒', snap && snap.bubble !== 'break', snap && snap.bubble);

    // 关闭免打扰，触发一次后选“今天不再提醒”
    await evalJs(
      petWindow,
      `window.__deskbuddyDispatch({ type:'settings/update', patch:{ doNotDisturb: false } })`
    );
    await sleep(200);
    await evalJs(petWindow, `window.__deskbuddyDispatch({ type:'tick', now: Date.now() + 3*60*60*1000 })`);
    await sleep(400);

    snap = await evalJs(petWindow, 'window.__deskbuddySnapshot()');
    const canSuppress = snap && snap.bubble === 'break';
    record('关闭免打扰后恢复提醒', canSuppress, snap && snap.bubble);

    if (canSuppress) {
      await evalJs(
        petWindow,
        `document.querySelector('#bubble-actions button[data-action-id="suppress"]').click()`
      );
      await sleep(400);
      await evalJs(petWindow, `window.__deskbuddyDispatch({ type:'tick', now: Date.now() + 2*60*60*1000 })`);
      await sleep(300);
      snap = await evalJs(petWindow, 'window.__deskbuddySnapshot()');
      record('今天不再提醒生效', snap && snap.bubble !== 'break', snap && snap.bubble);
    } else {
      record('今天不再提醒生效', false, '无法进入休息提醒');
    }

    // 恢复默认，避免影响后续手动使用
    await evalJs(
      petWindow,
      `window.__deskbuddyDispatch({ type:'settings/update', patch:{ breakReminderMinutes: 50 } })`
    );
  } catch (error) {
    record('测试异常', false, (error && error.stack) || error);
  }

  const failed = results.filter((r) => !r.ok).length;
  out('PHASE_RESULT=' + (failed === 0 ? 'PASS' : 'FAIL'));
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200);
}

module.exports = { run };
