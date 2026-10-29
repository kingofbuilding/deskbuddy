/**
 * 用户设置：默认值、范围校验、异常数据恢复。
 * 纯函数，不接触磁盘。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;

  const LIMITS = {
    focusDurationMinutes: { min: 1, max: 180 },
    breakReminderMinutes: { min: 5, max: 240 },
    snoozeMinutes: { min: 1, max: 120 },
    minReminderGapMinutes: { min: 1, max: 120 },
    petScale: { min: 0.75, max: 1.6 },
    waterReminderMinutes: { min: 5, max: 180 },
    gameGraceMinutes: { min: 1, max: 60 },
    guardCooldownMinutes: { min: 5, max: 120 }
  };

  const DEFAULT_SETTINGS = {
    // 专注
    focusDurationMinutes: 25,
    // 休息
    breakReminderMinutes: 50,
    breakRemindersEnabled: true,
    // 提醒节奏
    snoozeMinutes: 10,
    minReminderGapMinutes: 3,
    // 开关
    soundEnabled: true,
    effectsEnabled: true,
    chatterEnabled: true,
    doNotDisturb: false,
    alwaysOnTop: true,
    launchAtLogin: false,
    lifeEnabled: true,
    wanderEnabled: true,
    healthRemindersEnabled: true,
    waterReminderMinutes: 30,
    gameGuardEnabled: false,
    gameGraceMinutes: 10,
    guardCooldownMinutes: 15,
    guardMode: 'visit',
    guardEffectsEnabled: true,
    entertainmentApps: 'cs2.exe\nvalorant-win64-shipping.exe\nleague of legends.exe\ngenshinimpact.exe\nyuanshen.exe\nstarrail.exe\nminecraft.windows.exe\neldenring.exe\nwutheringwaves.exe\nvlc.exe\nmpv.exe\npotplayermini64.exe\npotplayermini.exe\nqqplayer.exe\nqqvideo.exe\niqiyi.exe\nyouku.exe',
    // 外观
    petScale: 1,
    petPosition: null
  };

  const BOOLEAN_KEYS = [
    'breakRemindersEnabled',
    'soundEnabled',
    'effectsEnabled',
    'chatterEnabled',
    'doNotDisturb',
    'alwaysOnTop',
    'launchAtLogin', 'lifeEnabled', 'wanderEnabled', 'healthRemindersEnabled', 'gameGuardEnabled', 'guardEffectsEnabled'
  ];

  const NUMBER_KEYS = [
    'focusDurationMinutes',
    'breakReminderMinutes',
    'snoozeMinutes',
    'minReminderGapMinutes', 'waterReminderMinutes', 'gameGraceMinutes', 'guardCooldownMinutes'
  ];

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function clampScale(value) {
    const limits = LIMITS.petScale;
    const numeric = util.isFiniteNumber(value) ? value : DEFAULT_SETTINGS.petScale;
    const clamped = Math.min(limits.max, Math.max(limits.min, numeric));
    return Math.round(clamped * 100) / 100;
  }

  /** 宠物位置：必须是两个有限整数，且落在合理屏幕范围内；否则视为未保存 */
  function normalizePosition(raw) {
    if (!isPlainObject(raw)) return null;
    if (!util.isFiniteNumber(raw.x) || !util.isFiniteNumber(raw.y)) return null;
    const x = Math.round(raw.x);
    const y = Math.round(raw.y);
    if (x < -20000 || x > 20000 || y < -20000 || y > 20000) return null;
    return { x, y };
  }

  /**
   * 归一化设置。
   * @param {unknown} raw 可能来自磁盘的任意内容
   * @param {string[]} [issues] 收集修复信息，便于提示用户
   * @returns {typeof DEFAULT_SETTINGS}
   */
  function normalizeSettings(raw, issues) {
    const report = Array.isArray(issues) ? issues : [];
    const source = isPlainObject(raw) ? raw : {};
    if (!isPlainObject(raw) && raw !== undefined) {
      report.push('settings 不是对象，已恢复默认设置');
    }

    const settings = util.deepClone(DEFAULT_SETTINGS);

    for (const key of NUMBER_KEYS) {
      const limits = LIMITS[key];
      const value = source[key];
      if (value === undefined) continue;
      const next = util.clampNumber(value, limits.min, limits.max, DEFAULT_SETTINGS[key]);
      if (next !== value) report.push(key + ' 已修正为 ' + next);
      settings[key] = next;
    }

    for (const key of BOOLEAN_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      const next = util.toBoolean(value, DEFAULT_SETTINGS[key]);
      if (next !== value) report.push(key + ' 已修正为 ' + String(next));
      settings[key] = next;
    }

    if (source.petScale !== undefined) {
      const next = clampScale(source.petScale);
      if (next !== source.petScale) report.push('petScale 已修正为 ' + next);
      settings.petScale = next;
    }

    if (source.petPosition !== undefined) {
      const next = normalizePosition(source.petPosition);
      if (next === null && source.petPosition !== null) report.push('宠物位置无效，已重置');
      settings.petPosition = next;
    }

    settings.guardMode = source.guardMode === 'minimize' ? 'minimize' : 'visit';
    if (typeof source.entertainmentApps === 'string') {
      settings.entertainmentApps = Array.from(new Set(source.entertainmentApps.toLowerCase().split(/[\n,;，；]+/)
        .map((value) => value.trim()).filter((value) => /^[a-z0-9_. -]{1,80}\.exe$/.test(value))))
        .slice(0, 30).join('\n');
    }
    return settings;
  }

  /** 只保留已知字段，用于写盘前瘦身 */
  function serializeSettings(settings) {
    return normalizeSettings(settings);
  }

  /** 判断两组设置是否有实质差异（用于避免无意义的磁盘写入） */
  function settingsEqual(a, b) {
    const left = serializeSettings(a);
    const right = serializeSettings(b);
    return JSON.stringify(left) === JSON.stringify(right);
  }

  const api = {
    LIMITS,
    DEFAULT_SETTINGS,
    normalizeSettings,
    serializeSettings,
    normalizePosition,
    settingsEqual
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.settings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
