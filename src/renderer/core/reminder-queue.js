/**
 * 提醒队列（对应需求 7.5“防止提醒轰炸”）。
 *
 * 规则：
 *  - 同一时刻最多展示一个主动提醒气泡。
 *  - 同类提醒不会重复排队（focus_done / break），后到的直接丢弃，不叠加。
 *  - 免打扰时自动提醒被丢弃；用户主动触发的请求仍然展示（但不播声音）。
 *  - 支持 availableAt（稍后提醒）：到点之前不会被取走，因此不需要额外计时器。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  const KIND = {
    FOCUS_DONE: 'focus_done',
    BREAK: 'break',
    INFO: 'info'
  };

  const PRIORITY = {
    focus_done: 3,
    break: 2,
    info: 1
  };

  function createQueue() {
    return {
      items: [],
      active: null,
      lastShownAt: null
    };
  }

  function priorityOf(item) {
    return PRIORITY[item && item.kind] || 0;
  }

  function isAvailable(item, now) {
    if (!item) return false;
    if (!util.isFiniteNumber(item.availableAt)) return true;
    return now >= item.availableAt;
  }

  /**
   * 入队。
   * @param {object} queue
   * @param {object} item {kind, auto, dnd, now, availableAt, ...payload}
   * @returns {{queue:object, accepted:boolean, reason?:string}}
   */
  function enqueue(queue, item) {
    const q = queue || createQueue();
    const next = { items: q.items.slice(), active: q.active, lastShownAt: q.lastShownAt };

    if (!item || typeof item.kind !== 'string') {
      return { queue: next, accepted: false, reason: 'bad_item' };
    }
    if (item.auto === true && item.dnd === true) {
      return { queue: next, accepted: false, reason: 'do_not_disturb' };
    }
    // 同类提醒去重：正在展示或已在队列中就不再叠加
    const duplicate =
      next.items.some((existing) => existing.kind === item.kind) ||
      Boolean(next.active && next.active.kind === item.kind);
    if (duplicate) {
      return { queue: next, accepted: false, reason: 'duplicate' };
    }

    next.items.push(item);
    next.items.sort((a, b) => {
      const byPriority = priorityOf(b) - priorityOf(a);
      if (byPriority !== 0) return byPriority;
      return (a.availableAt || 0) - (b.availableAt || 0);
    });
    return { queue: next, accepted: true };
  }

  /** 取出下一个“已到点”的提醒；active 非空时返回 null，保证一次只显示一个 */
  function take(queue, now) {
    const q = queue || createQueue();
    const at = util.isFiniteNumber(now) ? now : Date.now();
    if (q.active) return { queue: q, item: null };

    const index = q.items.findIndex((item) => isAvailable(item, at));
    if (index < 0) return { queue: q, item: null };

    const item = q.items[index];
    const rest = q.items.slice(0, index).concat(q.items.slice(index + 1));
    return {
      queue: {
        items: rest,
        active: Object.assign({}, item, { shownAt: at }),
        lastShownAt: at
      },
      item
    };
  }

  function resolve(queue, now) {
    const q = queue || createQueue();
    return {
      queue: {
        items: q.items.slice(),
        active: null,
        lastShownAt: util.isFiniteNumber(now) ? now : q.lastShownAt
      }
    };
  }

  /** 清空所有自动提醒（例如用户开启免打扰） */
  function clear(queue) {
    return { items: [], active: null, lastShownAt: queue ? queue.lastShownAt : null };
  }

  function isBusy(queue) {
    return Boolean(queue && (queue.active || queue.items.length > 0));
  }

  /** 是否有已到点、正在等待展示的提醒 */
  function hasReady(queue, now) {
    const q = queue || createQueue();
    const at = util.isFiniteNumber(now) ? now : Date.now();
    return q.items.some((item) => isAvailable(item, at));
  }

  const api = {
    KIND,
    PRIORITY,
    createQueue,
    enqueue,
    take,
    resolve,
    clear,
    isBusy,
    hasReady,
    isAvailable
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.reminderQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
