/* 主动陪伴策略。仅接收空闲秒数和已匹配的娱乐应用名，不读取窗口内容。 */
(function (global) {
  'use strict';
  const MINUTE = 60000;
  function create(now, raw) {
    const source = raw || {};
    const number = (key) => Number.isFinite(source[key]) ? Math.max(0, source[key]) : 0;
    return {
      sampleSeen: false, lastSampleAt: now, workMs: 0,
      waterMs: Math.min(number('waterMs'), 240 * MINUTE),
      waterUntil: number('waterUntil'), restUntil: number('restUntil'),
      guardUntil: number('guardUntil'), lastReminderAt: Math.min(now, number('lastReminderAt')),
      entertainmentMs: 0, matchedApp: '', idleSeconds: 0, desktopActive: true,
      guardEffectCount: Math.floor(number('guardEffectCount'))
    };
  }
  function advance(previous, sample, settings, context) {
    const now = Number.isFinite(sample.now) ? sample.now : Date.now();
    const next = Object.assign({}, previous || create(now));
    // 一次最多计 15 秒；系统休眠、监测失败和重启不补算工作时长。
    const gap = now - next.lastSampleAt;
    const resumed = next.sampleSeen && gap >= 180000;
    const elapsed = next.sampleSeen && gap >= 0 && !resumed ? Math.min(15000, gap) : 0;
    if (resumed) { next.workMs = 0; next.entertainmentMs = 0; next.matchedApp = ''; }
    next.sampleSeen = true;
    next.lastSampleAt = now;
    next.idleSeconds = Math.max(0, Number(sample.idleSeconds) || 0);
    next.desktopActive = sample.desktopActive !== false;
    const awake = next.desktopActive && next.idleSeconds < 180;
    if (!awake) next.workMs = 0;
    else if (settings.healthRemindersEnabled) {
      next.workMs += elapsed;
      next.waterMs += elapsed;
    }
    // 名单中的前台播放器即使没有键鼠输入，也继续计观看时间；锁屏/休眠不计。
    const app = settings.gameGuardEnabled && !settings.doNotDisturb && next.desktopActive && context.pendingCount > 0 && typeof sample.matchedApp === 'string' ? sample.matchedApp : '';
    next.entertainmentMs = app && app === next.matchedApp ? next.entertainmentMs + elapsed : 0;
    next.matchedApp = app;
    if ((!awake && !app) || settings.doNotDisturb || context.busy || now < next.lastReminderAt + settings.minReminderGapMinutes * MINUTE) return { next, event: null };
    let event = null;
    if (awake && settings.healthRemindersEnabled && settings.breakRemindersEnabled && next.workMs >= settings.breakReminderMinutes * MINUTE && now >= next.restUntil) {
      event = { kind: 'break' };
      next.restUntil = now + settings.snoozeMinutes * MINUTE;
    } else if (awake && settings.healthRemindersEnabled && next.waterMs >= settings.waterReminderMinutes * MINUTE && now >= next.waterUntil) {
      event = { kind: 'water' };
      next.waterUntil = now + settings.snoozeMinutes * MINUTE;
    } else if (app && context.pendingCount > 0 && next.entertainmentMs >= settings.gameGraceMinutes * MINUTE && now >= next.guardUntil) {
      event = { kind: 'task_nudge', appName: app };
      next.guardUntil = now + settings.guardCooldownMinutes * MINUTE;
    }
    if (event) next.lastReminderAt = now;
    return { next, event };
  }
  function canRoam(context) {
    return context.desktopActive !== false && !context.focusRunning &&
      (Boolean(context.matchedApp) || context.idleSeconds >= 60 || context.pendingCount === 0);
  }
  const api = { create, advance, canRoam };
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.initiative = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
