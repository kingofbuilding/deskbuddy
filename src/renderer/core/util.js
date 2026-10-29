/**
 * 通用小工具，被核心模块共享。
 * 同时支持两种加载方式：
 *  - Node（单元测试）：module.exports
 *  - 渲染进程（普通 script 标签）：挂到 globalThis.DeskBuddy.util
 */
(function (global) {
  'use strict';

  const MS_PER_MINUTE = 60 * 1000;
  const MINUTE_PER_DAY = 24 * 60;

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  /** 把任意输入收敛到 [min, max]；非法时返回 fallback（fallback 也会被夹取） */
  function clampNumber(value, min, max, fallback) {
    const base = isFiniteNumber(value) ? value : fallback;
    if (!isFiniteNumber(base)) return min;
    const rounded = Math.round(base);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
  }

  /** 布尔值：只接受真正的布尔；其他值用 fallback */
  function toBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  /** 允许的字符串枚举 */
  function toEnum(value, allowed, fallback) {
    return allowed.indexOf(value) >= 0 ? value : fallback;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 剩余毫秒 -> "24:59" / "1:02:03" */
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil((isFiniteNumber(ms) ? ms : 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    return pad2(minutes) + ':' + pad2(seconds);
  }

  /** 时长（分钟）-> "25 分钟" */
  function formatMinutes(minutes) {
    const value = Math.max(0, Math.round(isFiniteNumber(minutes) ? minutes : 0));
    if (value < 60) return value + ' 分钟';
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0 ? hours + ' 小时' : hours + ' 小时 ' + rest + ' 分钟';
  }

  /** 时间戳 -> "22:05" */
  function formatTime(ts) {
    if (!isFiniteNumber(ts)) return '--:--';
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 本地日期键 "2026-10-28"，用于“今天不再提醒”之类的当日判断 */
  function dayKey(ts) {
    if (!isFiniteNumber(ts)) return '';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 当天 23:59:59.999 的时间戳 */
  function endOfDay(ts) {
    const d = new Date(isFiniteNumber(ts) ? ts : Date.now());
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function minutesToMs(minutes) {
    return Math.max(0, Math.round((isFiniteNumber(minutes) ? minutes : 0) * MS_PER_MINUTE));
  }

  function msToMinutes(ms) {
    return (isFiniteNumber(ms) ? ms : 0) / MS_PER_MINUTE;
  }

  let idCounter = 0;

  /** 生成稳定可读的唯一 ID：task-<时间戳36>-<序号>-<随机> */
  function createId(prefix) {
    idCounter += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + random;
  }

  function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(deepClone);
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }

  /** 数组安全取值 idx 循环，用于确定性“随机” */
  function pickByIndex(list, index) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const i = Math.abs(Math.floor(isFiniteNumber(index) ? index : 0)) % list.length;
    return list[i];
  }

  const api = {
    MS_PER_MINUTE,
    MINUTE_PER_DAY,
    isFiniteNumber,
    clampNumber,
    toBoolean,
    toEnum,
    formatClock,
    formatMinutes,
    formatTime,
    dayKey,
    endOfDay,
    minutesToMs,
    msToMinutes,
    createId,
    deepClone,
    pickByIndex,
    pad2
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.util = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
