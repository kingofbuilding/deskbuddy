'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const petState = require('../src/renderer/core/pet-state.js');
const queue = require('../src/renderer/core/reminder-queue.js');
const stats = require('../src/renderer/core/stats.js');

const T0 = new Date(2026, 9, 28, 9, 0, 0).getTime();

test('状态机按优先级拒绝低优先级抢占', () => {
  let pet = petState.createPetState('idle');
  pet = petState.transition(pet, { to: 'reminder', now: T0, holder: 'b1' }).pet;
  assert.equal(pet.current, 'reminder');

  const blocked = petState.transition(pet, { to: 'companion', now: T0 + 1 });
  assert.equal(blocked.changed, false);
  assert.equal(blocked.rejected, true);
  assert.equal(blocked.pet.current, 'reminder', '独占状态不能被低优先级打断');
});

test('状态机允许更高优先级抢占', () => {
  let pet = petState.createPetState('idle');
  pet = petState.transition(pet, { to: 'focus', now: T0 }).pet;
  const higher = petState.transition(pet, { to: 'effect', now: T0 + 1, holder: 'e1' });
  assert.equal(higher.changed, true);
  assert.equal(higher.pet.current, 'effect');
  assert.equal(higher.pet.base, 'focus', '应记住被覆盖的基础状态');
});

test('release 回到之前的基础状态，并校验持有者', () => {
  let pet = petState.createPetState('idle');
  pet = petState.transition(pet, { to: 'focus', now: T0 }).pet;
  pet = petState.transition(pet, { to: 'effect', now: T0 + 1, holder: 'e1' }).pet;

  const wrong = petState.release(pet, { now: T0 + 2, holder: 'other' });
  assert.equal(wrong.changed, false, '不匹配的持有者不能结束特效');

  const right = petState.release(pet, { now: T0 + 2, holder: 'e1' });
  assert.equal(right.changed, true);
  assert.equal(right.pet.current, 'focus');
});

test('desiredBaseState 中免打扰优先于专注', () => {
  assert.equal(petState.desiredBaseState({}), 'idle');
  assert.equal(petState.desiredBaseState({ focusRunning: true }), 'focus');
  assert.equal(petState.desiredBaseState({ companionMode: true }), 'companion');
  assert.equal(
    petState.desiredBaseState({ focusRunning: true, companionMode: true, doNotDisturb: true }),
    'do_not_disturb'
  );
});

test('canShowAutoReminder 在免打扰、忙碌、特效时返回 false', () => {
  assert.equal(petState.canShowAutoReminder({}), true);
  assert.equal(petState.canShowAutoReminder({ doNotDisturb: true }), false);
  assert.equal(petState.canShowAutoReminder({ reminderBusy: true }), false);
  assert.equal(petState.canShowAutoReminder({ effectActive: true }), false);
});

test('提醒队列同一时刻只放行一个提醒', () => {
  let q = queue.createQueue();
  q = queue.enqueue(q, { kind: 'break', auto: true }).queue;
  q = queue.enqueue(q, { kind: 'focus_done', auto: true }).queue;
  assert.equal(q.items.length, 2);

  const first = queue.take(q, T0);
  assert.equal(first.item.kind, 'focus_done', '高优先级先出');
  const second = queue.take(first.queue, T0);
  assert.equal(second.item, null, '已有 active 时不能再取');
});

test('提醒队列对同类提醒去重', () => {
  let q = queue.createQueue();
  q = queue.enqueue(q, { kind: 'break', auto: true }).queue;
  const again = queue.enqueue(q, { kind: 'break', auto: true });
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'duplicate');
});

test('免打扰时自动提醒被丢弃，但主动提醒仍可入队', () => {
  const q = queue.createQueue();
  const auto = queue.enqueue(q, { kind: 'break', auto: true, dnd: true });
  assert.equal(auto.accepted, false);
  assert.equal(auto.reason, 'do_not_disturb');

  const manual = queue.enqueue(q, { kind: 'info', auto: false, dnd: true });
  assert.equal(manual.accepted, true);
});

test('availableAt 未到点时取不出提醒', () => {
  let q = queue.createQueue();
  q = queue.enqueue(q, { kind: 'focus_done', auto: true, availableAt: T0 + 10000 }).queue;
  assert.equal(queue.take(q, T0).item, null);
  const later = queue.take(q, T0 + 10000);
  assert.equal(later.item.kind, 'focus_done');
});

test('统计只累计聚合数字，并支持连续天数', () => {
  let s = stats.createStats();
  s = stats.recordTaskCompleted(s, T0);
  s = stats.recordTaskCompleted(s, T0);
  s = stats.recordFocusSession(s, T0, 25);

  const day = stats.dayStats(s, T0);
  assert.equal(day.completed, 2);
  assert.equal(day.focusSessions, 1);
  assert.equal(day.focusMinutes, 25);
  assert.equal(s.totalCompleted, 2);

  // 昨天也完成过 -> 连续 2 天
  const yesterday = T0 - 24 * 60 * 60 * 1000;
  s = stats.recordTaskCompleted(s, yesterday);
  assert.equal(stats.computeStreak(s, T0), 2);
});

test('normalizeStats 对损坏数据给出空统计', () => {
  for (const bad of [null, 'x', [], 5]) {
    const s = stats.normalizeStats(bad);
    assert.equal(s.totalCompleted, 0);
  }
});

test('normalizeStats 丢弃非法日期键和负值', () => {
  const issues = [];
  const s = stats.normalizeStats(
    {
      days: { '2026-10-28': { completed: -5, focusSessions: 2 }, bad: { completed: 3 } },
      totalCompleted: -1
    },
    issues
  );
  assert.equal(s.days['2026-10-28'].completed, 0);
  assert.equal(s.days.bad, undefined);
  assert.equal(s.totalCompleted, 0);
});
