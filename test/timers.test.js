'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timers = require('../src/renderer/core/timers.js');

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 28, 9, 0, 0).getTime();

test('startFocus 记录绝对结束时间', () => {
  const state = timers.createInitialState();
  const started = timers.startFocus(state, { now: T0, durationMinutes: 25, taskId: 't1' });
  assert.equal(started.state.focus.status, 'running');
  assert.equal(started.state.focus.endsAt, T0 + 25 * MIN);
  assert.equal(started.state.focus.taskId, 't1');
  assert.equal(timers.focusRemainingMs(started.state.focus, T0 + 10 * MIN), 15 * MIN);
});

test('计时以绝对时间为准，失焦后也不会漂移', () => {
  const started = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 25 });
  // 模拟 3 分钟没有任何 tick
  const remaining = timers.focusRemainingMs(started.state.focus, T0 + 3 * MIN);
  assert.equal(remaining, 22 * MIN);

  const tick = timers.tickFocus(started.state, T0 + 3 * MIN);
  assert.equal(tick.finished, false);
  assert.equal(tick.remainingMs, 22 * MIN);
});

test('tickFocus 到点后报告 finished', () => {
  const started = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 1 });
  const tick = timers.tickFocus(started.state, T0 + 60 * 1000);
  assert.equal(tick.finished, true);
  assert.equal(tick.remainingMs, 0);
  assert.equal(tick.overdueMs, 0);
});

test('暂停后剩余时间冻结，继续后重新计算结束时间', () => {
  let s = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 25 }).state;
  s = timers.pauseFocus(s, T0 + 5 * MIN).state;

  assert.equal(s.focus.status, 'paused');
  assert.equal(s.focus.endsAt, null);
  assert.equal(s.focus.pausedRemainingMs, 20 * MIN);

  // 暂停期间过了 30 分钟，剩余时间不变
  assert.equal(timers.focusRemainingMs(s.focus, T0 + 35 * MIN), 20 * MIN);

  const resumed = timers.resumeFocus(s, T0 + 35 * MIN).state;
  assert.equal(resumed.focus.status, 'running');
  assert.equal(resumed.focus.endsAt, T0 + 55 * MIN);
  assert.equal(timers.focusRemainingMs(resumed.focus, T0 + 40 * MIN), 15 * MIN);
});

test('重复暂停 / 重复继续被拒绝', () => {
  const idle = timers.createInitialState();
  assert.equal(timers.pauseFocus(idle, T0).changed, false);
  assert.equal(timers.resumeFocus(idle, T0).changed, false);

  let s = timers.startFocus(idle, { now: T0, durationMinutes: 25 }).state;
  s = timers.pauseFocus(s, T0 + MIN).state;
  const again = timers.pauseFocus(s, T0 + 2 * MIN);
  assert.equal(again.changed, false, '暂停状态不能再次暂停');
});

test('extendFocus 延长结束时间并累加总时长', () => {
  let s = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 10 }).state;
  s = timers.extendFocus(s, 5, T0 + MIN).state;
  assert.equal(s.focus.endsAt, T0 + 15 * MIN);
  assert.equal(s.focus.totalMs, 15 * MIN);
});

test('settleFocus 累计完成轮次并清空当前轮次', () => {
  let s = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 1 }).state;
  s = timers.settleFocus(s).state;
  assert.equal(s.focus.status, 'idle');
  assert.equal(s.focus.completedSessions, 1);
  assert.equal(s.focus.endsAt, null);
});

test('休息提醒按间隔到期触发', () => {
  let s = timers.createInitialState({ breakReminderMinutes: 50 });
  s = timers.rescheduleBreak(s, T0);

  assert.equal(s.breakTimer.nextDueAt, T0 + 50 * MIN);
  assert.equal(
    timers.evaluateBreak(s, { now: T0 + 49 * MIN, enabled: true }).due,
    false,
    '未到点不应触发'
  );
  const due = timers.evaluateBreak(s, { now: T0 + 50 * MIN, enabled: true });
  assert.equal(due.due, true);
  assert.equal(due.dueAt, T0 + 50 * MIN);
});

test('免打扰、关闭休息提醒、已有提醒在展示时都不触发休息提醒', () => {
  const s = timers.rescheduleBreak(timers.createInitialState({ breakReminderMinutes: 50 }), T0);
  const at = T0 + 60 * MIN;

  assert.equal(timers.evaluateBreak(s, { now: at, enabled: false }).reason, 'disabled');
  assert.equal(timers.evaluateBreak(s, { now: at, enabled: true, doNotDisturb: true }).reason, 'do_not_disturb');
  assert.equal(timers.evaluateBreak(s, { now: at, enabled: true, busy: true }).reason, 'reminder_busy');
});

test('“今天不再提醒”会一直抑制到当天结束', () => {
  const base = timers.rescheduleBreak(timers.createInitialState(), T0);
  const s = timers.suppressBreakForToday(base, T0).state;
  assert.equal(timers.evaluateBreak(s, { now: T0 + 50 * MIN, enabled: true }).due, false);
  assert.equal(timers.breakSuppressed(s, T0 + 10 * 60 * MIN), true);
  // 第二天恢复
  const nextDay = new Date(2026, 9, 29, 9, 0, 0).getTime();
  assert.equal(timers.breakSuppressed(s, nextDay), false);
});

test('确认休息后重新计算下一次提醒', () => {
  const s = timers.confirmBreak(timers.createInitialState({ breakReminderMinutes: 50 }), T0 + 52 * MIN).state;
  assert.equal(s.breakTimer.lastConfirmedAt, T0 + 52 * MIN);
  assert.equal(s.breakTimer.nextDueAt, T0 + 102 * MIN);
});

test('稍后提醒只推后下一次时间，不改间隔', () => {
  const s = timers.snoozeBreak(timers.createInitialState({ breakReminderMinutes: 50 }), 10, T0).state;
  assert.equal(s.breakTimer.intervalMs, 50 * MIN);
  assert.equal(s.breakTimer.nextDueAt, T0 + 10 * MIN);
  assert.equal(s.breakTimer.snoozedUntil, T0 + 10 * MIN);
});

test('修改休息间隔立即生效', () => {
  const s = timers.setBreakInterval(timers.rescheduleBreak(timers.createInitialState(), T0), 30, T0);
  assert.equal(s.breakTimer.intervalMs, 30 * MIN);
  assert.equal(s.breakTimer.nextDueAt, T0 + 30 * MIN);
});

test('最小提醒间隔阻止提醒轰炸', () => {
  let s = timers.rescheduleBreak(timers.createInitialState({ breakReminderMinutes: 50 }), T0);
  s = timers.markReminderShown(s, T0 + 50 * MIN);
  const blocked = timers.evaluateBreak(s, {
    now: T0 + 51 * MIN,
    enabled: true,
    minGapMinutes: 3
  });
  assert.equal(blocked.due, false);
  assert.equal(blocked.reason, 'min_gap');

  const ok = timers.evaluateBreak(s, { now: T0 + 54 * MIN, enabled: true, minGapMinutes: 3 });
  assert.equal(ok.due, true);
});

test('restore：未到期专注继续按剩余时间运行', () => {
  const started = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 25 }).state;
  const restored = timers.restore(started, T0 + 10 * MIN);
  assert.equal(restored.state.focus.status, 'running');
  assert.equal(restored.state.focus.endsAt, T0 + 25 * MIN);
  assert.equal(restored.missed, null);
  assert.equal(timers.focusRemainingMs(restored.state.focus, T0 + 10 * MIN), 15 * MIN);
});

test('restore：关闭期间刚过期的专注只补一次提醒', () => {
  const started = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 25 }).state;
  const restored = timers.restore(started, T0 + 30 * MIN);
  assert.equal(restored.state.focus.status, 'idle');
  assert.equal(restored.missed.kind, 'focus');
  assert.equal(restored.missed.overdueMs, 5 * MIN);
});

test('restore：过期太久的专注不弹提醒，只保留记录', () => {
  const started = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 25 }).state;
  const restored = timers.restore(started, T0 + 12 * 60 * MIN);
  assert.equal(restored.missed, null);
  assert.equal(restored.state.focus.completedSessions, 1);
  assert.ok(restored.issues.length > 0);
});

test('restore：错过很久的休息提醒顺延，不集中补发', () => {
  const raw = {
    focus: { status: 'idle' },
    breakTimer: { intervalMs: 50 * MIN, nextDueAt: T0 }
  };
  const restored = timers.restore(raw, T0 + 10 * 60 * MIN);
  assert.equal(restored.state.breakTimer.nextDueAt, T0 + 10 * 60 * MIN + 50 * MIN);
  assert.ok(restored.issues.some((i) => i.includes('顺延')));
});

test('restore：损坏的数据回到默认状态而不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, { focus: 'nope' }]) {
    const restored = timers.restore(bad, T0);
    assert.equal(restored.state.focus.status, 'idle');
  }
});

test('restore：暂停中的专注保留剩余时间', () => {
  let s = timers.startFocus(timers.createInitialState(), { now: T0, durationMinutes: 25 }).state;
  s = timers.pauseFocus(s, T0 + 5 * MIN).state;
  const restored = timers.restore(s, T0 + 120 * MIN);
  assert.equal(restored.state.focus.status, 'paused');
  assert.equal(restored.state.focus.pausedRemainingMs, 20 * MIN);
});
