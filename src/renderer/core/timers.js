/**
 * 计时引擎（纯逻辑，不接触 DOM / Electron）。
 *
 * 设计要点（对应需求 7.6）：
 *  - 一律保存绝对目标时间 endsAt / nextDueAt，剩余时间 = 目标 - 当前时间，
 *    不依赖“每秒减一”的计数器，避免失焦或卡顿造成漂移。
 *  - 应用重启或系统休眠后，用同一个 absolute timestamp 重新计算，
 *    对过期事件只产出“一次”提醒，不会补发一整串过期提醒。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  const FOCUS_STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused'
  };

  // 过期超过这个阈值就认为是“很久以前的提醒”，只静默复位，不弹窗打扰
  const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

  function nowMs(now) {
    return util.isFiniteNumber(now) ? now : Date.now();
  }

  function createInitialState(minutes) {
    const opts = typeof minutes === 'number' ? { breakReminderMinutes: minutes } : minutes || {};
    const breakMinutes = util.clampNumber(opts.breakReminderMinutes, 5, 240, 50);
    return {
      focus: {
        status: FOCUS_STATUS.IDLE,
        taskId: null,
        durationMs: 0,
        totalMs: 0,
        startedAt: null,
        endsAt: null,
        pausedRemainingMs: 0,
        completedSessions: 0
      },
      breakTimer: {
        intervalMs: util.minutesToMs(breakMinutes),
        nextDueAt: null,
        lastConfirmedAt: null,
        snoozedUntil: null,
        suppressedUntil: null
      },
      meta: {
        lastReminderAt: null
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 专注计时
   * ------------------------------------------------------------------ */

  function focusRemainingMs(focus, now) {
    if (!focus || focus.status !== FOCUS_STATUS.RUNNING) {
      return Math.max(0, focus && util.isFiniteNumber(focus.pausedRemainingMs) ? focus.pausedRemainingMs : 0);
    }
    return Math.max(0, focus.endsAt - nowMs(now));
  }

  function focusProgress(focus, now) {
    if (!focus || !util.isFiniteNumber(focus.totalMs) || focus.totalMs <= 0) {
      return 0;
    }
    const remaining = focusRemainingMs(focus, now);
    const ratio = 1 - remaining / focus.totalMs;
    return Math.min(1, Math.max(0, Math.round(ratio * 1000) / 1000));
  }

  /**
   * 开始专注（会覆盖正在进行的专注）。
   * @returns {{state:object, changed:boolean}}
   */
  function startFocus(state, params) {
    const p = params || {};
    const now = nowMs(p.now);
    const minutes = util.clampNumber(p.durationMinutes, 1, 180, 25);
    const durationMs = util.minutesToMs(minutes);
    const next = util.deepClone(state);
    next.focus = {
      status: FOCUS_STATUS.RUNNING,
      taskId: typeof p.taskId === 'string' && p.taskId ? p.taskId : null,
      durationMs,
      totalMs: durationMs,
      startedAt: now,
      endsAt: now + durationMs,
      pausedRemainingMs: 0,
      completedSessions: next.focus ? next.focus.completedSessions || 0 : 0
    };
    return { state: next, changed: true };
  }

  function pauseFocus(state, now) {
    const next = util.deepClone(state);
    if (next.focus.status !== FOCUS_STATUS.RUNNING) {
      return { state: next, changed: false, reason: 'not_running' };
    }
    const at = nowMs(now);
    next.focus.pausedRemainingMs = Math.max(0, next.focus.endsAt - at);
    next.focus.status = FOCUS_STATUS.PAUSED;
    next.focus.endsAt = null;
    return { state: next, changed: true };
  }

  function resumeFocus(state, now) {
    const next = util.deepClone(state);
    if (next.focus.status !== FOCUS_STATUS.PAUSED) {
      return { state: next, changed: false, reason: 'not_paused' };
    }
    const at = nowMs(now);
    next.focus.endsAt = at + Math.max(0, next.focus.pausedRemainingMs);
    next.focus.status = FOCUS_STATUS.RUNNING;
    next.focus.pausedRemainingMs = 0;
    return { state: next, changed: true };
  }

  function stopFocus(state) {
    const next = util.deepClone(state);
    const hadSession = next.focus.status !== FOCUS_STATUS.IDLE;
    next.focus = {
      status: FOCUS_STATUS.IDLE,
      taskId: null,
      durationMs: 0,
      totalMs: 0,
      startedAt: null,
      endsAt: null,
      pausedRemainingMs: 0,
      completedSessions: next.focus.completedSessions || 0
    };
    return { state: next, changed: hadSession };
  }

  /** 加时：用于“再专注一会儿” */
  function extendFocus(state, minutes, now) {
    const next = util.deepClone(state);
    if (next.focus.status === FOCUS_STATUS.IDLE) {
      return { state: next, changed: false, reason: 'idle' };
    }
    const extraMs = util.minutesToMs(util.clampNumber(minutes, 1, 180, 5));
    if (next.focus.status === FOCUS_STATUS.PAUSED) {
      next.focus.pausedRemainingMs += extraMs;
    } else {
      next.focus.endsAt = Math.max(nowMs(now), next.focus.endsAt || 0) + extraMs;
    }
    next.focus.totalMs += extraMs;
    return { state: next, changed: true };
  }

  /**
   * 推进专注计时，返回是否到时。
   * 到时后状态保留为 running 且 endsAt 已过（remaining=0），由上层决定后续动作，
   * 以免在 tick 中隐式改变状态导致重复触发。
   */
  function tickFocus(state, now) {
    const next = util.deepClone(state);
    if (next.focus.status !== FOCUS_STATUS.RUNNING) {
      return { state: next, finished: false, remainingMs: focusRemainingMs(next.focus, now) };
    }
    const at = nowMs(now);
    const remainingMs = Math.max(0, next.focus.endsAt - at);
    return { state: next, finished: remainingMs <= 0, remainingMs, overdueMs: Math.max(0, at - next.focus.endsAt) };
  }

  /** 专注到时后落账：累计完成次数并回到 idle */
  function settleFocus(state) {
    const next = util.deepClone(state);
    next.focus = {
      status: FOCUS_STATUS.IDLE,
      taskId: null,
      durationMs: 0,
      totalMs: 0,
      startedAt: null,
      endsAt: null,
      pausedRemainingMs: 0,
      completedSessions: (next.focus.completedSessions || 0) + 1
    };
    return { state: next, changed: true };
  }

  /* ------------------------------------------------------------------ *
   * 休息提醒
   * ------------------------------------------------------------------ */

  /**
   * 重新计算下一次休息提醒。
   * @param {object} state
   * @param {number} now
   * @param {boolean} [force] true 时无论是否已有 nextDueAt 都重算（用于修改间隔）
   */
  function rescheduleBreak(state, now, force) {
    const next = util.deepClone(state);
    const at = nowMs(now);
    const t = next.breakTimer;
    if (t.nextDueAt === null || force === true) {
      const base = util.isFiniteNumber(t.lastConfirmedAt) ? t.lastConfirmedAt : at;
      t.nextDueAt = base + t.intervalMs;
    }
    return next;
  }

  function setBreakInterval(state, minutes, now) {
    const next = util.deepClone(state);
    next.breakTimer.intervalMs = util.minutesToMs(util.clampNumber(minutes, 5, 240, 50));
    return rescheduleBreak(next, now, true);
  }

  /** 用户确认已休息 */
  function confirmBreak(state, now) {
    const next = util.deepClone(state);
    const at = nowMs(now);
    next.breakTimer.lastConfirmedAt = at;
    next.breakTimer.nextDueAt = at + next.breakTimer.intervalMs;
    next.breakTimer.snoozedUntil = null;
    return { state: next, changed: true };
  }

  /** 稍后提醒：从现在起延后 N 分钟，不改变原间隔 */
  function snoozeBreak(state, minutes, now) {
    const next = util.deepClone(state);
    const at = nowMs(now);
    const delay = util.minutesToMs(util.clampNumber(minutes, 1, 120, 10));
    next.breakTimer.nextDueAt = at + delay;
    next.breakTimer.snoozedUntil = next.breakTimer.nextDueAt;
    return { state: next, changed: true };
  }

  /** 今天不再提醒 */
  function suppressBreakForToday(state, now) {
    const next = util.deepClone(state);
    const at = nowMs(now);
    next.breakTimer.suppressedUntil = util.endOfDay(at);
    return { state: next, changed: true };
  }

  function breakSuppressed(state, now) {
    const t = state && state.breakTimer;
    if (!t) return true;
    if (!util.isFiniteNumber(t.suppressedUntil)) return false;
    return nowMs(now) < t.suppressedUntil;
  }

  /**
   * 判断休息提醒是否应该触发。
   * @param {object} state
   * @param {{now:number, enabled:boolean, doNotDisturb:boolean, busy:boolean, minGapMinutes:number}} ctx
   */
  function evaluateBreak(state, ctx) {
    const c = ctx || {};
    const at = nowMs(c.now);
    const t = state && state.breakTimer;
    if (!t) return { due: false, reason: 'no_state' };
    if (c.enabled === false) return { due: false, reason: 'disabled' };
    if (c.doNotDisturb === true) return { due: false, reason: 'do_not_disturb' };
    if (c.busy === true) return { due: false, reason: 'reminder_busy' };
    if (breakSuppressed(state, at)) return { due: false, reason: 'suppressed_today' };
    if (!util.isFiniteNumber(t.nextDueAt)) return { due: false, reason: 'not_scheduled' };
    if (at < t.nextDueAt) return { due: false, reason: 'not_yet', remainingMs: t.nextDueAt - at };

    const gap = util.minutesToMs(util.clampNumber(c.minGapMinutes, 1, 120, 3));
    const last = state.meta && state.meta.lastReminderAt;
    if (util.isFiniteNumber(last) && at - last < gap) {
      return { due: false, reason: 'min_gap', remainingMs: gap - (at - last) };
    }
    return { due: true, overdueMs: at - t.nextDueAt, dueAt: t.nextDueAt };
  }

  /** 记录一次提醒已展示，用于最小间隔控制 */
  function markReminderShown(state, now) {
    const next = util.deepClone(state);
    next.meta = next.meta || {};
    next.meta.lastReminderAt = nowMs(now);
    return next;
  }

  /* ------------------------------------------------------------------ *
   * 序列化与恢复
   * ------------------------------------------------------------------ */

  function serialize(state) {
    return util.deepClone(state);
  }

  /**
   * 从磁盘恢复计时状态，并按当前时间修正。
   *
   * 返回：
   *  - state：可用于继续运行的干净状态
   *  - missed：需要补一次提醒的信息（聚焦是否过期为 stale）
   */
  function restore(raw, now) {
    const at = nowMs(now);
    const issues = [];
    const base = createInitialState();
    let missed = null;

    if (!raw || typeof raw !== 'object') {
      return { state: base, missed: null, issues: ['计时状态缺失，已重置'] };
    }

    const state = util.deepClone(base);
    const rawFocus = raw.focus && typeof raw.focus === 'object' ? raw.focus : null;
    const rawBreak = raw.breakTimer && typeof raw.breakTimer === 'object' ? raw.breakTimer : null;

    if (rawFocus) {
      const status = util.toEnum(rawFocus.status, ['idle', 'running', 'paused'], 'idle');
      const totalMs = util.isFiniteNumber(rawFocus.totalMs) ? Math.max(0, rawFocus.totalMs) : 0;
      const endsAt = util.isFiniteNumber(rawFocus.endsAt) ? rawFocus.endsAt : null;
      const pausedRemainingMs = util.isFiniteNumber(rawFocus.pausedRemainingMs)
        ? Math.max(0, rawFocus.pausedRemainingMs)
        : 0;
      const previousSessions = util.isFiniteNumber(rawFocus.completedSessions) ? rawFocus.completedSessions : 0;

      if (status === 'running' && endsAt === null) {
        issues.push('专注计时缺少结束时间，已重置');
      } else if (status === 'running' && at >= endsAt) {
        // 专注在关闭期间结束：只记录一次，并按“错过多久”决定是否补提醒
        const overdue = at - endsAt;
        state.focus = {
          status: 'idle',
          taskId: null,
          durationMs: 0,
          totalMs: 0,
          startedAt: null,
          endsAt: null,
          pausedRemainingMs: 0,
          completedSessions: previousSessions + 1
        };
        if (overdue > STALE_AFTER_MS) {
          issues.push('上次专注已结束很久，仅保留记录，不再弹出提醒');
        } else {
          missed = { kind: 'focus', overdueMs: overdue, taskId: rawFocus.taskId || null };
        }
      } else if (status === 'running' && endsAt !== null) {
        state.focus = {
          status: 'running',
          taskId: typeof rawFocus.taskId === 'string' ? rawFocus.taskId : null,
          durationMs: util.isFiniteNumber(rawFocus.durationMs) ? rawFocus.durationMs : totalMs,
          totalMs: totalMs || 1,
          startedAt: util.isFiniteNumber(rawFocus.startedAt) ? rawFocus.startedAt : at,
          endsAt,
          pausedRemainingMs: 0,
          completedSessions: util.isFiniteNumber(rawFocus.completedSessions) ? rawFocus.completedSessions : 0
        };
      } else if (status === 'paused') {
        state.focus = {
          status: 'paused',
          taskId: typeof rawFocus.taskId === 'string' ? rawFocus.taskId : null,
          durationMs: util.isFiniteNumber(rawFocus.durationMs) ? rawFocus.durationMs : totalMs,
          totalMs: totalMs || 1,
          startedAt: util.isFiniteNumber(rawFocus.startedAt) ? rawFocus.startedAt : null,
          endsAt: null,
          pausedRemainingMs,
          completedSessions: util.isFiniteNumber(rawFocus.completedSessions) ? rawFocus.completedSessions : 0
        };
      }
    }

    if (rawBreak) {
      state.breakTimer.intervalMs = util.minutesToMs(
        util.clampNumber(util.msToMinutes(rawBreak.intervalMs), 5, 240, 50)
      );
      state.breakTimer.lastConfirmedAt = util.isFiniteNumber(rawBreak.lastConfirmedAt)
        ? rawBreak.lastConfirmedAt
        : null;
      state.breakTimer.nextDueAt = util.isFiniteNumber(rawBreak.nextDueAt) ? rawBreak.nextDueAt : null;
      state.breakTimer.snoozedUntil = util.isFiniteNumber(rawBreak.snoozedUntil) ? rawBreak.snoozedUntil : null;
      state.breakTimer.suppressedUntil = util.isFiniteNumber(rawBreak.suppressedUntil)
        ? rawBreak.suppressedUntil
        : null;

      // 过期太久的休息提醒不补发，直接顺延到下一次
      if (util.isFiniteNumber(state.breakTimer.nextDueAt) && at - state.breakTimer.nextDueAt > STALE_AFTER_MS) {
        issues.push('错过的休息提醒已顺延，不会集中弹出');
        state.breakTimer.nextDueAt = at + state.breakTimer.intervalMs;
      }
    }

    if (raw.meta && util.isFiniteNumber(raw.meta.lastReminderAt)) {
      state.meta.lastReminderAt = raw.meta.lastReminderAt;
    }

    return { state: rescheduleBreak(state, at), missed, issues };
  }

  const api = {
    FOCUS_STATUS,
    STALE_AFTER_MS,
    createInitialState,
    focusRemainingMs,
    focusProgress,
    startFocus,
    pauseFocus,
    resumeFocus,
    stopFocus,
    extendFocus,
    tickFocus,
    settleFocus,
    rescheduleBreak,
    setBreakInterval,
    confirmBreak,
    snoozeBreak,
    suppressBreakForToday,
    breakSuppressed,
    evaluateBreak,
    markReminderShown,
    serialize,
    restore
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.timers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
