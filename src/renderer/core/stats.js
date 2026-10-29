/**
 * 统计：今日完成数、专注轮次、连续天数。
 * 只保留聚合数字，不记录任何内容型数据（无输入记录、无截图、无浏览历史）。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  function createStats() {
    return {
      // dayKey -> { completed: number, focusSessions: number, focusMinutes: number }
      days: {},
      totalCompleted: 0,
      totalFocusSessions: 0,
      streak: 0,
      lastActiveDay: ''
    };
  }

  function normalizeStats(raw, issues) {
    const report = Array.isArray(issues) ? issues : [];
    const base = createStats();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (raw !== undefined) report.push('统计数据结构异常，已重置');
      return base;
    }
    const days = {};
    if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
      for (const key of Object.keys(raw.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        const entry = raw.days[key];
        if (!entry || typeof entry !== 'object') continue;
        days[key] = {
          completed: Math.max(0, util.clampNumber(entry.completed, 0, 10000, 0)),
          focusSessions: Math.max(0, util.clampNumber(entry.focusSessions, 0, 10000, 0)),
          focusMinutes: Math.max(0, util.clampNumber(entry.focusMinutes, 0, 1000000, 0))
        };
      }
    }
    base.days = days;
    base.totalCompleted = Math.max(0, util.clampNumber(raw.totalCompleted, 0, 1000000, 0));
    base.totalFocusSessions = Math.max(0, util.clampNumber(raw.totalFocusSessions, 0, 1000000, 0));
    base.streak = Math.max(0, util.clampNumber(raw.streak, 0, 100000, 0));
    base.lastActiveDay = typeof raw.lastActiveDay === 'string' ? raw.lastActiveDay : '';
    return base;
  }

  function ensureDay(stats, at) {
    const key = util.dayKey(at);
    if (!stats.days[key]) stats.days[key] = { completed: 0, focusSessions: 0, focusMinutes: 0 };
    return stats.days[key];
  }

  function recordTaskCompleted(stats, at) {
    const next = util.deepClone(stats);
    const day = ensureDay(next, at);
    day.completed += 1;
    next.totalCompleted += 1;
    next.lastActiveDay = util.dayKey(at);
    return next;
  }

  function recordFocusSession(stats, at, minutes) {
    const next = util.deepClone(stats);
    const day = ensureDay(next, at);
    day.focusSessions += 1;
    day.focusMinutes += Math.max(0, Math.round(minutes || 0));
    next.totalFocusSessions += 1;
    next.lastActiveDay = util.dayKey(at);
    return next;
  }

  function dayStats(stats, at) {
    const key = util.dayKey(at);
    return (stats && stats.days && stats.days[key]) || { completed: 0, focusSessions: 0, focusMinutes: 0 };
  }

  /** 连续天数：从今天（或昨天）往回数，每天有完成记录才算 */
  function computeStreak(stats, at) {
    const s = stats || createStats();
    const dayMs = 24 * 60 * 60 * 1000;
    let cursor = util.isFiniteNumber(at) ? at : Date.now();
    let streak = 0;
    // 今天还没完成也没关系，从昨天开始算连续
    if (!s.days[util.dayKey(cursor)] || s.days[util.dayKey(cursor)].completed === 0) {
      cursor -= dayMs;
    }
    for (let i = 0; i < 400; i += 1) {
      const key = util.dayKey(cursor);
      const entry = s.days[key];
      if (!entry || entry.completed === 0) break;
      streak += 1;
      cursor -= dayMs;
    }
    return streak;
  }

  const api = {
    createStats,
    normalizeStats,
    recordTaskCompleted,
    recordFocusSession,
    dayStats,
    computeStreak
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.stats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
