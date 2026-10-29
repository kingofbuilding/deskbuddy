/**
 * 任务模型与今日任务清单。
 * 纯逻辑：所有函数返回新的任务数组，不修改入参。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  const TITLE_MAX_LENGTH = 80;
  const MAX_TASKS = 200;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** 清理标题：去控制字符、折叠空白、限长 */
  function cleanTitle(raw) {
    if (typeof raw !== 'string') return '';
    const stripped = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ');
    const collapsed = stripped.replace(/\s+/g, ' ').trim();
    return collapsed.slice(0, TITLE_MAX_LENGTH);
  }

  /**
   * 校验并校验用户输入。
   * @returns {{ok:true,title:string}|{ok:false,reason:'empty'|'too_long'|'duplicate'}}
   */
  function validateTitle(raw, existingTasks) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, reason: 'empty' };
    }
    const title = cleanTitle(raw);
    if (title === '') return { ok: false, reason: 'empty' };
    if (raw.replace(/\s+/g, ' ').trim().length > TITLE_MAX_LENGTH) {
      return { ok: false, reason: 'too_long' };
    }
    const list = Array.isArray(existingTasks) ? existingTasks : [];
    const duplicated = list.some(
      (task) => !task.completed && task.title.toLowerCase() === title.toLowerCase()
    );
    if (duplicated) return { ok: false, reason: 'duplicate' };
    return { ok: true, title };
  }

  /** 把磁盘上的任意对象收敛成合法任务；无法修复则返回 null */
  function normalizeTask(raw) {
    if (!isPlainObject(raw)) return null;
    const title = cleanTitle(raw.title);
    if (title === '') return null;

    const createdAt = util.isFiniteNumber(raw.createdAt) && raw.createdAt > 0 ? Math.round(raw.createdAt) : Date.now();
    const dueAt =
      util.isFiniteNumber(raw.dueAt) && raw.dueAt > 0 ? Math.round(raw.dueAt) : null;

    return {
      id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : util.createId('task'),
      title,
      completed: raw.completed === true,
      createdAt,
      dueAt,
      completedAt: util.isFiniteNumber(raw.completedAt) && raw.completedAt > 0 ? Math.round(raw.completedAt) : null
    };
  }

  /**
   * 归一化整个任务列表：去无效项、去重复 id、限制数量。
   * @param {unknown} raw
   * @param {string[]} [issues]
   */
  function normalizeTasks(raw, issues) {
    const report = Array.isArray(issues) ? issues : [];
    if (!Array.isArray(raw)) {
      if (raw !== undefined) report.push('任务列表格式异常，已重置为空');
      return [];
    }

    const seen = new Set();
    const tasks = [];
    let dropped = 0;

    for (const item of raw) {
      const task = normalizeTask(item);
      if (!task) {
        dropped += 1;
        continue;
      }
      if (seen.has(task.id)) {
        task.id = util.createId('task');
      }
      seen.add(task.id);
      tasks.push(task);
    }

    if (dropped > 0) report.push('已忽略 ' + dropped + ' 条无效任务');

    tasks.sort((a, b) => a.createdAt - b.createdAt);
    if (tasks.length > MAX_TASKS) {
      report.push('任务超过上限，仅保留最近的 ' + MAX_TASKS + ' 条');
      return tasks.slice(tasks.length - MAX_TASKS);
    }
    return tasks;
  }

  /** 新建任务对象（不落盘） */
  function createTask(rawTitle, options) {
    const opts = isPlainObject(options) ? options : {};
    const refined = validateTitle(rawTitle, opts.existingTasks || []);
    if (!refined.ok) return { ok: false, reason: refined.reason };

    return {
      ok: true,
      task: {
        id: util.createId('task'),
        title: refined.title,
        completed: false,
        createdAt: util.isFiniteNumber(opts.now) ? opts.now : Date.now(),
        dueAt: util.isFiniteNumber(opts.dueAt) && opts.dueAt > 0 ? Math.round(opts.dueAt) : null,
        completedAt: null
      }
    };
  }

  function addTask(tasks, rawTitle, options) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (list.length >= MAX_TASKS) {
      return { ok: false, reason: 'full', tasks: list };
    }
    const created = createTask(rawTitle, Object.assign({}, options, { existingTasks: list }));
    if (!created.ok) return { ok: false, reason: created.reason, tasks: list };
    return { ok: true, task: created.task, tasks: list.concat([created.task]) };
  }

  function toggleTask(tasks, taskId, options) {
    const opts = isPlainObject(options) ? options : {};
    const now = util.isFiniteNumber(opts.now) ? opts.now : Date.now();
    let changed = null;
    const next = (Array.isArray(tasks) ? tasks : []).map((task) => {
      if (task.id !== taskId) return task;
      const completed = typeof opts.completed === 'boolean' ? opts.completed : !task.completed;
      changed = Object.assign({}, task, {
        completed,
        completedAt: completed ? now : null
      });
      return changed;
    });
    if (!changed) return { ok: false, reason: 'not_found', tasks, task: null };
    return { ok: true, task: changed, tasks: next };
  }

  function removeTask(tasks, taskId) {
    const list = Array.isArray(tasks) ? tasks : [];
    const next = list.filter((task) => task.id !== taskId);
    if (next.length === list.length) return { ok: false, reason: 'not_found', tasks: list };
    return { ok: true, tasks: next };
  }

  function findTask(tasks, taskId) {
    const list = Array.isArray(tasks) ? tasks : [];
    return list.find((task) => task.id === taskId) || null;
  }

  /**
   * 任务统计。
   * 重点：没有任何任务时 isEmpty=true，界面据此显示“今天还没有添加任务”，
   * 而不是误判为“全部完成”。
   */
  function summarize(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const total = list.length;
    const completed = list.filter((task) => task.completed).length;
    const remaining = total - completed;
    return {
      total,
      completed,
      remaining,
      isEmpty: total === 0,
      allDone: total > 0 && remaining === 0,
      percent: total === 0 ? 0 : Math.round((completed / total) * 100)
    };
  }

  /** 未完成优先、按创建时间排序，保证界面顺序稳定 */
  function sortForDisplay(tasks) {
    return (Array.isArray(tasks) ? tasks.slice() : []).sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return a.createdAt - b.createdAt;
    });
  }

  /** 是否在截止当天或已过期 */
  function dueState(task, now) {
    if (!isPlainObject(task) || !util.isFiniteNumber(task.dueAt)) return { state: 'none' };
    const current = util.isFiniteNumber(now) ? now : Date.now();
    if (current > task.dueAt) return { state: 'overdue', at: task.dueAt };
    if (util.dayKey(current) === util.dayKey(task.dueAt)) return { state: 'today', at: task.dueAt };
    if (task.dueAt - current <= 24 * 60 * 60 * 1000) return { state: 'soon', at: task.dueAt };
    return { state: 'later', at: task.dueAt };
  }

  const api = {
    TITLE_MAX_LENGTH,
    MAX_TASKS,
    cleanTitle,
    validateTitle,
    normalizeTask,
    normalizeTasks,
    createTask,
    addTask,
    toggleTask,
    removeTask,
    findTask,
    summarize,
    sortForDisplay,
    dueState
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.tasks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
