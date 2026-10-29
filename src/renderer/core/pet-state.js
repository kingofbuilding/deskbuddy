/**
 * 宠物状态机（对应需求第六章）。
 *
 * 设计要点：
 *  - 所有状态变更都走 transition()，任何模块都不直接改 state.pet。
 *  - 用“状态优先级 + 锁”避免多个计时器同时触发相互冲突的动画：
 *    EFFECT / REMINDER 这类独占状态在结束前不会被低优先级请求抢占。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  const PET_STATES = {
    IDLE: 'idle',
    FOCUS: 'focus',
    REMINDER: 'reminder',
    CELEBRATION: 'celebration',
    COMPANION: 'companion',
    DO_NOT_DISTURB: 'do_not_disturb',
    EFFECT: 'effect'
  };

  // 数值越小越优先。需求 6.2 的排序在这里落地。
  const PRIORITY = {
    effect: 100,
    reminder: 80,
    celebration: 60,
    do_not_disturb: 40,
    focus: 30,
    companion: 20,
    idle: 10
  };

  // 这些状态是“独占”的：结束后要回到 base 状态，期间拒绝低优先级抢占
  const EXCLUSIVE = new Set([PET_STATES.EFFECT, PET_STATES.REMINDER, PET_STATES.CELEBRATION]);

  function createPetState(initial) {
    return {
      current: initial || PET_STATES.IDLE,
      base: PET_STATES.IDLE,
      since: 0,
      reason: 'init',
      // 独占状态的持有者标识，用于避免重复进入同一特效
      holder: null
    };
  }

  function isExclusive(state) {
    return EXCLUSIVE.has(state);
  }

  /**
   * @param {object} pet
   * @param {object} request {to, reason, now, force, holder}
   * @returns {{pet:object, changed:boolean, rejected:boolean}}
   */
  function transition(pet, request) {
    const p = pet || createPetState();
    const req = request || {};
    const target = util.toEnum(req.to, Object.keys(PRIORITY), p.current);
    const now = util.isFiniteNumber(req.now) ? req.now : Date.now();

    if (target === p.current && req.force !== true) {
      return { pet: p, changed: false, rejected: false, same: true };
    }

    const currentPriority = PRIORITY[p.current] || 0;
    const targetPriority = PRIORITY[target] || 0;
    const exclusiveActive = isExclusive(p.current) && req.force !== true;

    if (exclusiveActive && targetPriority <= currentPriority) {
      return { pet: p, changed: false, rejected: true, reason: 'exclusive_busy' };
    }

    const next = {
      current: target,
      base: isExclusive(target) ? (isExclusive(p.current) ? p.base : p.current) : target,
      since: now,
      reason: typeof req.reason === 'string' ? req.reason : '',
      holder: isExclusive(target) ? req.holder || null : null
    };

    return { pet: next, changed: true, rejected: false };
  }

  /** 独占状态结束，回到之前的基础状态 */
  function release(pet, request) {
    const p = pet || createPetState();
    const req = request || {};
    const now = util.isFiniteNumber(req.now) ? req.now : Date.now();
    if (!isExclusive(p.current)) {
      return { pet: p, changed: false };
    }
    if (req.holder && p.holder && req.holder !== p.holder) {
      return { pet: p, changed: false, rejected: true, reason: 'holder_mismatch' };
    }
    const next = {
      current: p.base || PET_STATES.IDLE,
      base: p.base || PET_STATES.IDLE,
      since: now,
      reason: typeof req.reason === 'string' ? req.reason : 'release',
      holder: null
    };
    return { pet: next, changed: true };
  }

  /**
   * 计算“当前应该处于哪个常态”。
   * 免打扰优先于专注和陪伴，但不会覆盖独占的提醒/特效。
   */
  function desiredBaseState(context) {
    const c = context || {};
    if (c.doNotDisturb === true) return PET_STATES.DO_NOT_DISTURB;
    if (c.focusRunning === true) return PET_STATES.FOCUS;
    if (c.companionMode === true) return PET_STATES.COMPANION;
    return PET_STATES.IDLE;
  }

  function canShowAutoReminder(context) {
    const c = context || {};
    if (c.doNotDisturb === true) return false;
    if (c.reminderBusy === true) return false;
    if (c.effectActive === true) return false;
    return true;
  }

  const api = {
    PET_STATES,
    PRIORITY,
    EXCLUSIVE,
    createPetState,
    isExclusive,
    transition,
    release,
    desiredBaseState,
    canShowAutoReminder
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.petState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
