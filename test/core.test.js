'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const util = require('../src/renderer/core/util.js');
const settings = require('../src/renderer/core/settings.js');
const tasks = require('../src/renderer/core/tasks.js');

test('formatClock 向下取整到秒并处理小时', () => {
  assert.equal(util.formatClock(25 * 60 * 1000), '25:00');
  assert.equal(util.formatClock(0), '00:00');
  assert.equal(util.formatClock(-500), '00:00');
  assert.equal(util.formatClock(1500), '00:02');
  assert.equal(util.formatClock(3661 * 1000), '1:01:01');
});

test('clampNumber 对非法输入回退到默认并夹取范围', () => {
  assert.equal(util.clampNumber(10, 1, 180, 25), 10);
  assert.equal(util.clampNumber(0, 1, 180, 25), 1);
  assert.equal(util.clampNumber(999, 1, 180, 25), 180);
  assert.equal(util.clampNumber('abc', 1, 180, 25), 25);
  assert.equal(util.clampNumber(NaN, 1, 180, 25), 25);
  assert.equal(util.clampNumber(undefined, 1, 180, 25), 25);
});

test('toBoolean 只接受明确的布尔语义', () => {
  assert.equal(util.toBoolean(true, false), true);
  assert.equal(util.toBoolean('false', true), false);
  assert.equal(util.toBoolean('yes', true), true);
  assert.equal(util.toBoolean(1, false), false);
});

test('normalizeSettings 修复越界与类型错误的字段', () => {
  const issues = [];
  const s = settings.normalizeSettings(
    {
      focusDurationMinutes: 9999,
      breakReminderMinutes: 'x',
      soundEnabled: 'false',
      effectsEnabled: true,
      doNotDisturb: 'yes',
      alwaysOnTop: null,
      petPosition: { x: 'bad', y: 3 }
    },
    issues
  );
  assert.equal(s.focusDurationMinutes, 180);
  assert.equal(s.breakReminderMinutes, 50);
  assert.equal(s.soundEnabled, false);
  assert.equal(s.effectsEnabled, true);
  assert.equal(s.doNotDisturb, false);
  assert.equal(s.alwaysOnTop, true);
  assert.equal(s.petPosition, null);
  assert.ok(issues.length >= 4);
});

test('normalizeSettings 对非对象输入返回完整默认值', () => {
  const s = settings.normalizeSettings('not-an-object');
  assert.deepEqual(s, settings.DEFAULT_SETTINGS);
});

test('normalizeSettings 保留合法的宠物位置', () => {
  const s = settings.normalizeSettings({ petPosition: { x: 120.7, y: -40.2 } });
  assert.deepEqual(s.petPosition, { x: 121, y: -40 });
});

test('validateTitle 拒绝空标题、超长标题和重复标题', () => {
  assert.equal(tasks.validateTitle('', []).reason, 'empty');
  assert.equal(tasks.validateTitle('   ', []).reason, 'empty');
  assert.equal(tasks.validateTitle('x'.repeat(81), []).reason, 'too_long');
  const existing = [{ id: 'a', title: '写周报', completed: false }];
  assert.equal(tasks.validateTitle('写周报', existing).reason, 'duplicate');
  // 已完成的同名任务不算重复
  assert.equal(tasks.validateTitle('写周报', [{ id: 'a', title: '写周报', completed: true }]).ok, true);
});

test('validateTitle 折叠空白并清理控制字符', () => {
  const result = tasks.validateTitle('  写  周报  ', []);
  assert.equal(result.ok, true);
  assert.equal(result.title, '写 周报');
});

test('addTask 追加任务且不修改原数组', () => {
  const before = [];
  const result = tasks.addTask(before, '完成 API 模块', { now: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.task.title, '完成 API 模块');
  assert.equal(result.task.completed, false);
  assert.equal(result.task.createdAt, 1000);
  assert.equal(before.length, 0, '原数组不应被修改');
});

test('toggleTask 切换完成状态并记录 completedAt', () => {
  const base = tasks.addTask([], '任务 A', { now: 100 }).tasks;
  const done = tasks.toggleTask(base, base[0].id, { now: 200 });
  assert.equal(done.ok, true);
  assert.equal(done.task.completed, true);
  assert.equal(done.task.completedAt, 200);
  assert.equal(base[0].completed, false, '原数组不应被修改');

  const undone = tasks.toggleTask(done.tasks, base[0].id, { now: 300 });
  assert.equal(undone.task.completed, false);
  assert.equal(undone.task.completedAt, null);
});

test('toggleTask 对不存在的 id 返回 not_found', () => {
  const result = tasks.toggleTask([], 'missing');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('removeTask 删除指定任务', () => {
  const list = tasks.addTask([], 'A').tasks;
  const result = tasks.removeTask(list, list[0].id);
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 0);
  assert.equal(tasks.removeTask(list, 'nope').reason, 'not_found');
});

test('summarize 区分“没有任务”和“全部完成”', () => {
  const empty = tasks.summarize([]);
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.allDone, false, '没有任务不能被判定为全部完成');

  const one = tasks.addTask([], 'A').tasks;
  const partial = tasks.summarize(one);
  assert.equal(partial.isEmpty, false);
  assert.equal(partial.allDone, false);
  assert.equal(partial.percent, 0);

  const all = tasks.summarize(tasks.toggleTask(one, one[0].id).tasks);
  assert.equal(all.allDone, true);
  assert.equal(all.percent, 100);
});

test('normalizeTasks 过滤无效项、重建重复 id、按创建时间排序', () => {
  const issues = [];
  const list = tasks.normalizeTasks(
    [
      { id: 'dup', title: '第二条', createdAt: 2000 },
      { id: 'dup', title: '第三条', createdAt: 3000 },
      { title: '', createdAt: 4000 },
      null,
      'garbage',
      { title: '第一条', createdAt: 1000 }
    ],
    issues
  );
  assert.equal(list.length, 3);
  assert.equal(list[0].title, '第一条');
  assert.equal(list[1].id, 'dup');
  assert.notEqual(list[2].id, 'dup');
  assert.ok(issues.some((i) => i.includes('无效任务')));
});

test('sortForDisplay 未完成在前且保持创建顺序', () => {
  let list = [];
  list = tasks.addTask(list, 'A', { now: 100 }).tasks;
  list = tasks.addTask(list, 'B', { now: 200 }).tasks;
  list = tasks.addTask(list, 'C', { now: 300 }).tasks;
  list = tasks.toggleTask(list, list[1].id).tasks; // B 完成

  const sorted = tasks.sortForDisplay(list);
  assert.deepEqual(
    sorted.map((t) => t.title),
    ['A', 'C', 'B']
  );
});

test('dueState 区分过期、今天、临近和无截止', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  assert.equal(tasks.dueState({ dueAt: null }, now).state, 'none');
  assert.equal(tasks.dueState({ dueAt: now + 60_000 }, now).state, 'today');
  assert.equal(tasks.dueState({ dueAt: now - 60_000 }, now).state, 'overdue');
  // 同一天稍晚仍算今天
  assert.equal(tasks.dueState({ dueAt: now + 3 * 3600_000 }, now).state, 'today');
  // 次日上午：不在今天，但 24 小时内
  assert.equal(tasks.dueState({ dueAt: now + 20 * 3600_000 }, now).state, 'soon');
  assert.equal(tasks.dueState({ dueAt: now + 5 * 86400_000 }, now).state, 'later');
});
