'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const appState = require('../src/renderer/core/app-state.js');

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 28, 9, 0, 0).getTime();

test('到期提醒只演出一次，并保留提醒状态、持有者和四个按钮', () => {
  const started = appState.reduce(fresh(), { type: 'focus/start', minutes: 1 }).state;
  const due = appState.reduce(started, { type: 'tick', now: T0 + MIN + 1 });
  const show = due.effects.filter((e) => e.type === 'reminder-effect');
  assert.equal(show.length, 1);
  assert.equal(show[0].kind, 'focus_done');
  assert.equal(due.state.pet.current, 'reminder');
  assert.equal(show[0].holder, due.state.pet.holder);
  assert.equal(due.state.ui.bubble.actions.length, 4);
  const again = appState.reduce(due.state, { type: 'tick', now: T0 + MIN + 1001 });
  assert.equal(again.effects.some((e) => e.type === 'reminder-effect'), false);
});

test('关闭特效仍显示提醒气泡，免打扰不播放提醒演出', () => {
  for (const settings of [{ effectsEnabled: false }, { doNotDisturb: true }]) {
    const initial = fresh({ settings });
    const started = appState.reduce(initial, { type: 'focus/start', minutes: 1 }).state;
    const due = appState.reduce(started, { type: 'tick', now: T0 + MIN + 1 });
    assert.equal(due.effects.some((e) => e.type === 'reminder-effect'), false);
    if (!settings.doNotDisturb) assert.equal(due.state.ui.bubble.kind, 'focus_done');
  }
});

function fresh(overrides) {
  return appState.createInitialState(Object.assign({ now: T0 }, overrides));
}

function run(state, actions) {
  let current = state;
  const all = [];
  let last = null;
  for (const action of actions) {
    last = appState.reduce(current, action);
    current = last.state;
    all.push.apply(all, last.effects);
  }
  return { state: current, effects: all, last };
}

test('添加任务后进入清单并可完成', () => {
  const added = run(fresh(), [{ type: 'tasks/add', title: '完成 API 模块' }]);
  assert.equal(added.state.tasks.length, 1);
  assert.equal(added.last.ok, true);
  assert.ok(added.effects.some((e) => e.type === 'persist-tasks'));

  const taskId = added.state.tasks[0].id;
  const done = run(added.state, [{ type: 'tasks/toggle', id: taskId }]);
  assert.equal(done.state.tasks[0].completed, true);
  assert.equal(done.state.pet.current, 'celebration', '完成任务应触发庆祝状态');
  assert.ok(done.effects.some((e) => e.type === 'sound' && e.cue === 'pop'));
});

test('空标题被拒绝且不产生副作用', () => {
  const result = appState.reduce(fresh(), { type: 'tasks/add', title: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'empty');
  assert.equal(result.state.tasks.length, 0);
  assert.equal(result.effects.length, 0);
});

test('完成后取消勾选会回到待机状态', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: 'A' }]).state;
  const id = s.tasks[0].id;
  s = run(s, [{ type: 'tasks/toggle', id }]).state;
  assert.equal(s.pet.current, 'celebration');
  s = run(s, [{ type: 'pet/release' }]).state;
  assert.equal(s.pet.current, 'idle');
});

test('全部任务完成时触发庆祝特效', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: 'A' }, { type: 'tasks/add', title: 'B' }]).state;
  s = run(s, [{ type: 'tasks/toggle', id: s.tasks[0].id }]).state;
  const last = run(s, [{ type: 'tasks/toggle', id: s.tasks[1].id }]);
  assert.equal(last.state.pet.current, 'celebration');
  assert.ok(last.effects.some((e) => e.type === 'effect' && e.name === 'confetti'));
  assert.ok(last.effects.some((e) => e.type === 'sound' && e.cue === 'celebrate'));
});

test('专注启动后进入 focus 状态并记录结束时间', () => {
  const result = run(fresh(), [{ type: 'focus/start', minutes: 25 }]);
  assert.equal(result.state.timers.focus.status, 'running');
  assert.equal(result.state.timers.focus.endsAt, T0 + 25 * MIN);
  assert.equal(result.state.pet.current, 'focus');
  assert.ok(result.effects.some((e) => e.type === 'persist-timers'));
});

test('专注结束时产生一条提醒且只产生一次', () => {
  let s = run(fresh(), [{ type: 'focus/start', minutes: 25 }]).state;
  const tick = run(s, [{ type: 'tick', now: T0 + 25 * MIN }]);
  s = tick.state;

  assert.equal(s.timers.focus.status, 'idle');
  assert.equal(s.ui.bubble.kind, 'focus_done');
  assert.equal(s.pet.current, 'reminder');

  // 继续 tick 不应重复弹提醒
  const again = run(s, [{ type: 'tick', now: T0 + 26 * MIN }]);
  assert.equal(again.state.ui.bubble.id, s.ui.bubble.id, '不应重复生成提醒');
  assert.equal(again.effects.filter((e) => e.type === 'sound').length, 0);
});

test('专注未到点不会提醒', () => {
  let s = run(fresh(), [{ type: 'focus/start', minutes: 25 }]).state;
  s = run(s, [{ type: 'tick', now: T0 + 24 * MIN }]).state;
  assert.equal(s.ui.bubble, null);
  assert.equal(s.timers.focus.status, 'running');
});

test('免打扰时专注结束不弹自动提醒', () => {
  let s = fresh({ settings: { doNotDisturb: true } });
  s = run(s, [{ type: 'focus/start', minutes: 1 }]).state;
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  assert.equal(s.ui.bubble, null, '免打扰必须阻止普通提醒');
  assert.equal(s.timers.focus.status, 'idle');
  assert.equal(s.stats.totalFocusSessions, 1, '统计仍然要记');
});

test('免打扰时休息提醒同样被阻止', () => {
  let s = fresh({ settings: { doNotDisturb: true, breakReminderMinutes: 5 } });
  s.timers.breakTimer.nextDueAt = T0 + 1000;
  s = run(s, [{ type: 'tick', now: T0 + 2000 }]).state;
  assert.equal(s.ui.bubble, null);
});

test('休息提醒到期后弹出，并可通过“已休息”重排下一次', () => {
  let s = fresh({ settings: { breakReminderMinutes: 5 } });
  s.timers.breakTimer.nextDueAt = T0 + 1000;

  s = run(s, [{ type: 'tick', now: T0 + 2000 }]).state;
  assert.equal(s.ui.bubble.kind, 'break');
  assert.equal(s.pet.current, 'reminder');

  const resolved = run(s, [{ type: 'reminder/action', actionId: 'confirm' }]);
  assert.equal(resolved.state.ui.bubble, null);
  assert.equal(resolved.state.timers.breakTimer.lastConfirmedAt, T0 + 2000);
  assert.equal(resolved.state.timers.breakTimer.nextDueAt, T0 + 2000 + 5 * MIN);
});

test('“稍后提醒”会把下一次时间推后且不立即重弹', () => {
  let s = fresh({ settings: { breakReminderMinutes: 5, snoozeMinutes: 10 } });
  s.timers.breakTimer.nextDueAt = T0 + 1000;
  s = run(s, [{ type: 'tick', now: T0 + 2000 }]).state;

  s = run(s, [{ type: 'reminder/action', actionId: 'snooze' }]).state;
  assert.equal(s.ui.bubble, null);
  assert.equal(s.timers.breakTimer.nextDueAt, T0 + 2000 + 10 * MIN);

  const soon = run(s, [{ type: 'tick', now: T0 + 3000 }]).state;
  assert.equal(soon.ui.bubble, null, '延迟后不得立即再次触发');
});

test('“今天不再提醒”后当天不再弹休息提醒', () => {
  let s = fresh({ settings: { breakReminderMinutes: 5 } });
  s.timers.breakTimer.nextDueAt = T0 + 1000;
  s = run(s, [{ type: 'tick', now: T0 + 2000 }]).state;
  s = run(s, [{ type: 'reminder/action', actionId: 'suppress' }]).state;

  const later = run(s, [{ type: 'tick', now: T0 + 120 * MIN }]).state;
  assert.equal(later.ui.bubble, null);
});

test('焦点提醒“我完成了”会勾选关联任务并结算专注', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: '写 README' }]).state;
  const taskId = s.tasks[0].id;
  s = run(s, [{ type: 'focus/start', minutes: 1, taskId }]).state;
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  assert.equal(s.ui.bubble.kind, 'focus_done');
  const sessionsBefore = s.timers.focus.completedSessions;

  const result = run(s, [{ type: 'reminder/action', actionId: 'complete' }]);
  assert.equal(result.state.tasks[0].completed, true);
  assert.equal(
    result.state.timers.focus.completedSessions,
    sessionsBefore,
    'tick 已结算过，不应重复计数'
  );
  assert.equal(result.state.ui.bubble && result.state.ui.bubble.kind, 'celebration', '完成后显示庆祝气泡');
  assert.equal(result.state.pet.current, 'celebration', '完成后进入庆祝');
});

test('没有关联任务时，“我完成了”进入任务确认流程', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: '任务甲' }, { type: 'tasks/add', title: '任务乙' }]).state;
  s = run(s, [{ type: 'focus/start', minutes: 1 }]).state; // 不指定任务
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  assert.equal(s.ui.bubble.kind, 'focus_done');

  const picked = run(s, [{ type: 'reminder/action', actionId: 'complete' }]);
  assert.equal(picked.state.ui.bubble.kind, 'task_pick', '应要求用户确认是哪一件');
  const options = picked.state.ui.bubble.actions.map((a) => a.id);
  assert.ok(options.includes('pick:' + picked.state.tasks[0].id));
  assert.ok(options.includes('pick:none'));

  // 选第一条
  const targetId = picked.state.tasks[0].id;
  const done = run(picked.state, [{ type: 'reminder/action', actionId: 'pick:' + targetId }]);
  assert.equal(done.state.tasks[0].completed, true);
  assert.equal(done.state.timers.focus.status, 'idle');
});

test('任务确认流程里选“没有完成具体任务”也安全', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: '任务甲' }]).state;
  s = run(s, [{ type: 'focus/start', minutes: 1 }]).state;
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  s = run(s, [{ type: 'reminder/action', actionId: 'complete' }]).state;

  const none = run(s, [{ type: 'reminder/action', actionId: 'pick:none' }]);
  assert.equal(none.last.ok, true);
  assert.equal(none.state.tasks[0].completed, false, '不应误勾选任务');
});

test('清单为空时完成专注不报错只提示', () => {
  let s = run(fresh(), [{ type: 'focus/start', minutes: 1 }]).state;
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  const result = run(s, [{ type: 'reminder/action', actionId: 'complete' }]);
  assert.equal(result.last.ok, true);
  assert.equal(result.state.ui.bubble.kind, 'info');
  assert.equal(result.state.timers.focus.status, 'idle');
});

test('焦点提醒“再专注一会儿”会开启新一轮', () => {
  let s = run(fresh(), [{ type: 'focus/start', minutes: 1 }]).state;
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  const at = T0 + MIN;
  const result = run(s, [{ type: 'reminder/action', actionId: 'extend' }]);
  assert.equal(result.state.timers.focus.status, 'running');
  assert.notEqual(result.state.ui.bubble && result.state.ui.bubble.kind, 'focus_done', '提醒气泡应已处理');
  assert.ok(result.state.timers.focus.endsAt > at);
});

test('焦点提醒“稍后提醒”在延迟结束后重新出现', () => {
  let s = fresh({ settings: { snoozeMinutes: 10 } });
  s = run(s, [{ type: 'focus/start', minutes: 1 }]).state;
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  s = run(s, [{ type: 'reminder/action', actionId: 'snooze' }]).state;
  assert.equal(s.ui.bubble, null);

  const notYet = run(s, [{ type: 'tick', now: T0 + MIN + 5 * MIN }]).state;
  assert.equal(notYet.ui.bubble, null, '延迟期间不应重现');

  const due = run(notYet, [{ type: 'tick', now: T0 + MIN + 10 * MIN }]).state;
  assert.equal(due.ui.bubble.kind, 'focus_done');
});

test('同时到期时最多显示一个提醒', () => {
  let s = fresh({ settings: { breakReminderMinutes: 5 } });
  s.timers.breakTimer.nextDueAt = T0 + 1000;
  s = run(s, [{ type: 'focus/start', minutes: 1 }]).state;

  // 在同一时刻 tick：专注结束时刚好休息也到期
  s = run(s, [{ type: 'tick', now: T0 + MIN }]).state;
  assert.equal(s.ui.bubble !== null, true);
  assert.equal(s.queue.active !== null, true);
  assert.equal(s.ui.bubble.text.length > 0, true);
  // 队列里最多再排一条，不会出现多条同时展示
  const totalPending = s.queue.items.length + (s.queue.active ? 1 : 0);
  assert.ok(totalPending <= 1, '同一时刻只应有一个待处理提醒，实际 ' + totalPending);
});

test('特效播放后进入 effect，结束后恢复原状态', () => {
  let s = run(fresh(), [{ type: 'focus/start', minutes: 25 }]).state;
  const played = run(s, [{ type: 'effect/play', name: 'slash' }]);
  assert.equal(played.state.pet.current, 'effect');
  assert.equal(played.state.pet.effect, 'slash');
  assert.ok(played.effects.some((e) => e.type === 'sound' && e.cue === 'slash'));

  const holder = played.last.holder;
  const ended = run(played.state, [{ type: 'effect/end', holder }]);
  assert.equal(ended.state.pet.current, 'focus', '应恢复到特效前的专注状态');
});

test('特效持有者不匹配时不能结束别人的特效', () => {
  const played = run(fresh(), [{ type: 'effect/play', name: 'crack' }]);
  const blocked = appState.reduce(played.state, { type: 'effect/end', holder: 'wrong' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.state.pet.current, 'effect');
});

test('关闭特效时用户主动触发仍可播放，但不自动播放音效', () => {
  const s = fresh({ settings: { effectsEnabled: false, soundEnabled: false } });
  const auto = appState.reduce(s, { type: 'effect/play', name: 'slash' });
  assert.equal(auto.ok, false);
  assert.equal(auto.error, 'effects_disabled');

  const manual = appState.reduce(s, { type: 'effect/play', name: 'slash', manual: true });
  assert.equal(manual.ok, true);
  assert.equal(manual.effects.filter((e) => e.type === 'sound').length, 0);
});

test('开启免打扰会清空待处理提醒并切换到免打扰状态', () => {
  let s = fresh({ settings: { breakReminderMinutes: 5 } });
  s.timers.breakTimer.nextDueAt = T0 + 1000;
  s = run(s, [{ type: 'tick', now: T0 + 2000 }]).state;
  assert.ok(s.ui.bubble);

  s = run(s, [{ type: 'settings/update', patch: { doNotDisturb: true } }]).state;
  assert.equal(s.ui.bubble, null);
  assert.equal(s.pet.current, 'do_not_disturb');
});

test('关闭免打扰后回到待机（或专注）状态', () => {
  let s = fresh({ settings: { doNotDisturb: true } });
  assert.equal(s.pet.current, 'do_not_disturb');
  s = run(s, [{ type: 'settings/update', patch: { doNotDisturb: false } }]).state;
  assert.equal(s.pet.current, 'idle');
});

test('设置更新后立即调整休息间隔并落盘', () => {
  const s = run(fresh(), [{ type: 'settings/update', patch: { breakReminderMinutes: 30 } }]);
  assert.equal(s.state.settings.breakReminderMinutes, 30);
  assert.equal(s.state.timers.breakTimer.intervalMs, 30 * MIN);
  assert.ok(s.effects.some((e) => e.type === 'persist-settings'));
});

test('没有实际变化的设置更新不写盘', () => {
  const s = fresh();
  const result = appState.reduce(s, { type: 'settings/update', patch: { focusDurationMinutes: 25 } });
  assert.equal(result.ok, true);
  assert.equal(result.effects.length, 0, '无变化时不应产生磁盘写入');
});

test('越界设置被夹取', () => {
  const s = run(fresh(), [{ type: 'settings/update', patch: { focusDurationMinutes: 9999 } }]);
  assert.equal(s.state.settings.focusDurationMinutes, 180);
});

test('陪伴模式切换与闲聊台词', () => {
  const turnedOn = run(fresh(), [{ type: 'settings/update', patch: { companionMode: true } }]);
  assert.equal(turnedOn.state.ui.companionMode, true);
  assert.equal(turnedOn.state.pet.current, 'companion');

  const talk = run(turnedOn.state, [{ type: 'companion/talk', mode: 'joke', seed: T0 }]);
  assert.equal(talk.last.ok, true);
  assert.ok(talk.state.ui.bubble.text.length > 0);
  assert.equal(talk.state.ui.bubble.kind, 'companion');

  const turnedOff = run(talk.state, [{ type: 'settings/update', patch: { companionMode: false } }]);
  assert.equal(turnedOff.state.ui.companionMode, false);
  assert.equal(turnedOff.state.pet.current, 'idle');
});

test('免打扰时不会自动闲聊，但不会崩溃', () => {
  const s = fresh({ settings: { doNotDisturb: true, chatterEnabled: true } });
  const result = appState.reduce(s, { type: 'chatter' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'dnd');
});

test('专注中不闲聊', () => {
  const s = run(fresh(), [{ type: 'focus/start', minutes: 25 }]).state;
  const result = appState.reduce(s, { type: 'chatter' });
  assert.equal(result.ok, false);
});

test('气泡自动消失不会影响其他状态', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: 'A' }]).state;
  assert.ok(s.ui.bubble);
  const result = run(s, [{ type: 'bubble/dismiss', id: s.ui.bubble.id }]);
  assert.equal(result.state.ui.bubble, null);
  assert.equal(result.state.tasks.length, 1);
});

test('过期的气泡 id 不会误删新气泡', () => {
  let s = fresh();
  s = run(s, [{ type: 'tasks/add', title: 'A' }]).state;
  const result = appState.reduce(s, { type: 'bubble/dismiss', id: 'stale-id' });
  assert.equal(result.ok, false);
  assert.ok(result.state.ui.bubble);
});

test('未知动作被安全忽略', () => {
  const s = fresh();
  const result = appState.reduce(s, { type: 'nope' });
  assert.equal(result.ok, false);
  assert.equal(result.state, s);
  assert.equal(result.effects.length, 0);
});

test('重复点击开始专注不会产生并行计时', () => {
  let s = fresh();
  s = run(s, [{ type: 'focus/start', minutes: 25 }]).state;
  const first = s.timers.focus.endsAt;
  s = run(s, [{ type: 'focus/start', minutes: 25 }]).state;
  assert.equal(s.timers.focus.status, 'running');
  assert.equal(Object.keys(s.timers).length, 3, '计时器结构不应被复制出多份');
  assert.ok(s.timers.focus.endsAt >= first);
});

test('hydrate 能从损坏数据恢复并标记 recovered', () => {
  const broken = {
    tasks: 'not-an-array',
    settings: { focusDurationMinutes: 'x', soundEnabled: 'nope' },
    timers: null,
    stats: 'nope'
  };
  const hydrated = appState.hydrate(broken, T0);
  assert.equal(hydrated.recovered, true);
  assert.ok(hydrated.issues.length > 0);
  assert.equal(hydrated.state.settings.focusDurationMinutes, 25);
  assert.equal(hydrated.state.tasks.length, 0);
  assert.equal(hydrated.state.timers.focus.status, 'idle');
});

test('hydrate 恢复未完成专注并按剩余时间继续', () => {
  const payload = {
    settings: { focusDurationMinutes: 25 },
    tasks: [{ id: 't1', title: '旧任务', completed: false, createdAt: T0 - 1000 }],
    timers: {
      focus: {
        status: 'running',
        taskId: 't1',
        durationMs: 25 * MIN,
        totalMs: 25 * MIN,
        startedAt: T0 - 10 * MIN,
        endsAt: T0 + 15 * MIN,
        pausedRemainingMs: 0,
        completedSessions: 0
      },
      breakTimer: { intervalMs: 50 * MIN }
    }
  };
  const hydrated = appState.hydrate(payload, T0);
  assert.equal(hydrated.state.timers.focus.status, 'running');
  assert.equal(hydrated.state.timers.focus.endsAt, T0 + 15 * MIN);
  assert.equal(hydrated.state.pet.current, 'focus');
  assert.equal(hydrated.state.ui.focusTaskId, 't1');
});

test('hydrate 对关闭期间结束的专注只补一条提醒', () => {
  const payload = {
    settings: {},
    tasks: [{ id: 't1', title: '旧任务', completed: false, createdAt: T0 - 1000 }],
    timers: {
      focus: {
        status: 'running',
        taskId: 't1',
        durationMs: 25 * MIN,
        totalMs: 25 * MIN,
        startedAt: T0 - 30 * MIN,
        endsAt: T0 - 5 * MIN,
        pausedRemainingMs: 0,
        completedSessions: 0
      }
    }
  };
  const hydrated = appState.hydrate(payload, T0);
  assert.equal(hydrated.state.timers.focus.status, 'idle');
  assert.equal(hydrated.state.queue.items.length + (hydrated.state.ui.bubble ? 1 : 0), 0 === 1 ? 0 : 1);
  const pending = hydrated.state.queue.items.length + (hydrated.state.queue.active ? 1 : 0);
  assert.equal(pending, 1, '只应补一条提醒');
});
