/**
 * 应用状态与 reducer。
 *
 * 这是整个应用唯一的“真相来源”（对应需求 6.2 与风险二）：
 * 所有计时、任务、宠物状态变更都经由 reduce() 完成，
 * 并以 effects 数组的形式声明副作用（音效、特效、落盘），
 * 由宿主（渲染进程 / 测试）负责执行。
 *
 * 好处：
 *  1. 不依赖 DOM，可以在 Node 里做完整的行为测试。
 *  2. 同一时刻只有一个入口修改状态，不会出现多个计时器互相打架。
 */
(function (global) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const util = isNode ? require('./util.js') : global.DeskBuddy.util;
  const settingsModule = isNode ? require('./settings.js') : global.DeskBuddy.settings;
  const tasksModule = isNode ? require('./tasks.js') : global.DeskBuddy.tasks;
  const timersModule = isNode ? require('./timers.js') : global.DeskBuddy.timers;
  const petModule = isNode ? require('./pet-state.js') : global.DeskBuddy.petState;
  const queueModule = isNode ? require('./reminder-queue.js') : global.DeskBuddy.reminderQueue;
  const copyModule = isNode ? require('./copy.js') : global.DeskBuddy.copy;
  const statsModule = isNode ? require('./stats.js') : global.DeskBuddy.stats;
  const initiativeModule = isNode ? require('./initiative.js') : global.DeskBuddy.initiative;

  const { PET_STATES } = petModule;

  const FOCUS_REMINDER_ACTIONS = [
    { id: 'complete', label: '我完成了', tone: 'primary' },
    { id: 'extend', label: '再专注一会儿', tone: 'default' },
    { id: 'snooze', label: '稍后提醒', tone: 'ghost' },
    { id: 'break', label: '先休息', tone: 'ghost' }
  ];

  const BREAK_REMINDER_ACTIONS = [
    { id: 'confirm', label: '已休息', tone: 'primary' },
    { id: 'snooze', label: '10 分钟后提醒', tone: 'default' },
    { id: 'suppress', label: '今天不再提醒', tone: 'ghost' }
  ];

  const EXTEND_MINUTES = 5;

  function createInitialState(options) {
    const opts = options || {};
    const now = util.isFiniteNumber(opts.now) ? opts.now : Date.now();
    const settings = settingsModule.normalizeSettings(opts.settings);
    const tasks = tasksModule.normalizeTasks(opts.tasks || []);
    const stats = statsModule.normalizeStats(opts.stats);
    const timers =
      opts.timers ||
      timersModule.createInitialState({ breakReminderMinutes: settings.breakReminderMinutes });

    return {
      now,
      tasks,
      stats,
      settings,
      timers,
      initiative: initiativeModule.create(now, opts.initiative),
      pet: petModule.createPetState(petModule.desiredBaseState({ doNotDisturb: settings.doNotDisturb })),
      queue: queueModule.createQueue(),
      ui: {
        bubble: null,
        companionMode: false,
        focusTaskId: timers.focus ? timers.focus.taskId : null,
        lastChatterAt: 0,
        lastChatterLine: '',
        recovered: false
      }
    };
  }

  function cloneState(state) {
    return {
      now: state.now,
      tasks: state.tasks.slice(),
      stats: state.stats,
      settings: state.settings,
      timers: state.timers,
      initiative: state.initiative,
      pet: Object.assign({}, state.pet),
      queue: state.queue,
      ui: Object.assign({}, state.ui)
    };
  }

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function withBubble(state, bubble) {
    const next = cloneState(state);
    next.ui.bubble = bubble;
    return next;
  }

  function makeBubble(fields) {
    return Object.assign(
      {
        id: util.createId('bubble'),
        kind: 'info',
        tone: 'info',
        title: '',
        text: '',
        actions: [],
        autoDismissMs: 0,
        shownAt: 0
      },
      fields
    );
  }

  function baseContext(state) {
    return {
      doNotDisturb: state.settings.doNotDisturb === true,
      focusRunning: state.timers.focus.status === 'running',
      companionMode: state.ui.companionMode === true
    };
  }

  /** 让宠物回到当前应有的常态（免打扰 > 专注 > 陪伴 > 待机） */
  function syncBasePet(state) {
    const t = petModule.transition(state.pet, {
      to: petModule.desiredBaseState(baseContext(state)),
      reason: 'sync',
      now: state.now
    });
    if (!t.changed) return state;
    const next = cloneState(state);
    next.pet = t.pet;
    return next;
  }

  /** 从队列中取出一个提醒，变成气泡 */
  function pumpBubble(state, effects) {
    if (state.ui.bubble) return state;
    const taken = queueModule.take(state.queue, state.now);
    if (!taken.item) return state;

    const item = taken.item;
    const known = ['focus_done', 'break', 'water', 'task_nudge'];
    const next = cloneState(state);
    next.queue = taken.queue;
    next.ui.bubble = makeBubble({
      id: item.id || util.createId('bubble'),
      kind: item.kind,
      tone: item.tone || (item.kind === 'focus_done' ? 'focus' : item.kind === 'break' ? 'break' : 'info'),
      title: item.title || '',
      text: item.text || '',
      actions: item.actions || [],
      appName: item.appName || '',
      guardEffect: '', performanceStarted: false,
      autoDismissMs: util.isFiniteNumber(item.autoDismissMs) ? item.autoDismissMs : 0,
      shownAt: state.now
    });

    if (known.indexOf(item.kind) >= 0) {
      next.pet = petModule.transition(next.pet, {
        to: PET_STATES.REMINDER,
        reason: item.kind,
        now: state.now,
        holder: next.ui.bubble.id
      }).pet;
      // 仅在提醒真正展示时演出一次，不改变提醒持有者或四个操作按钮。
      if ((item.kind === 'focus_done' || item.kind === 'break') && next.settings.effectsEnabled && !next.settings.doNotDisturb) {
        effects.push({ type: 'reminder-effect', kind: item.kind, holder: next.ui.bubble.id });
      }
      if (item.kind === 'water' || item.kind === 'task_nudge') {
        if(item.kind==='task_nudge'&&next.settings.gameGuardEnabled&&next.settings.guardEffectsEnabled&&next.settings.effectsEnabled&&!next.settings.doNotDisturb){
          next.ui.bubble.guardEffect=next.initiative.guardEffectCount%2?'crack':'slash';
        }
        effects.push({ type: 'pet-visit', kind: item.kind, holder: next.ui.bubble.id });
      }
    }
    if (item.sound && next.settings.soundEnabled) {
      effects.push({ type: 'sound', cue: item.sound });
    }
    return next;
  }

  function clearBubble(state, effects) {
    const list = effects || [];
    const bubble = state.ui.bubble;
    if (!bubble) return state;
    const next = cloneState(state);
    next.ui.bubble = null;
    if (['water', 'task_nudge'].includes(bubble.kind) && !list.some((effect) => effect.type === 'pet-return')) list.push({ type: 'pet-return' });
    // 释放队列中的 active，否则后续提醒永远取不出来
    next.queue = queueModule.resolve(next.queue, state.now).queue;
    if (next.pet.holder && bubble.id === next.pet.holder) {
      if(next.pet.current===PET_STATES.EFFECT)list.push({type:'effect-end'});
      next.pet = petModule.release(next.pet, { now: state.now, holder: bubble.id }).pet;
    }
    return pumpBubble(next, list);
  }

  function enqueueReminder(state, reminder, effects) {
    const item = Object.assign({}, reminder, {
      id: reminder.id || util.createId('reminder'),
      auto: reminder.auto === true,
      dnd: state.settings.doNotDisturb === true
    });
    const enqueued = queueModule.enqueue(state.queue, item);
    if (!enqueued.accepted) return state;
    const next = cloneState(state);
    next.queue = enqueued.queue;
    return pumpBubble(next, effects);
  }

  function addEffects(effects, names) {
    for (const name of names) {
      if (!effects.some((e) => e.type === name)) effects.push({ type: name });
    }
  }

  /**
   * 主动提醒（专注结束 / 休息）的优先级高于普通提示气泡。
   * 当界面上正显示这类提醒时，普通提示不会把它挤掉。
   */
  function mayReplaceBubble(state) {
    const bubble = state.ui.bubble;
    if (!bubble) return true;
    return !['focus_done', 'break', 'water', 'task_nudge'].includes(bubble.kind);
  }

  /* ------------------------------------------------------------------ *
   * 任务
   * ------------------------------------------------------------------ */

  function actTaskAdd(state, action, effects) {
    const result = tasksModule.addTask(state.tasks, action.title, {
      now: state.now,
      dueAt: action.dueAt
    });
    if (!result.ok) {
      return { state, effects, ok: false, error: result.reason };
    }
    let next = cloneState(state);
    next.tasks = result.tasks;
    if (mayReplaceBubble(state)) {
      next = withBubble(
        next,
        makeBubble({
          kind: 'info',
          tone: 'info',
          title: '任务已添加',
          text: '「' + result.task.title + '」进清单了，动手吧。',
          autoDismissMs: 3000,
          shownAt: state.now
        })
      );
    }
    if (!state.settings.doNotDisturb) next = syncBasePet(next);
    addEffects(effects, ['persist-tasks']);
    return { state: next, effects, ok: true, task: result.task };
  }

  function actTaskToggle(state, action, effects) {
    const result = tasksModule.toggleTask(state.tasks, action.id, {
      now: state.now,
      completed: typeof action.completed === 'boolean' ? action.completed : undefined
    });
    if (!result.ok) return { state, effects, ok: false, error: result.reason };

    let next = cloneState(state);
    next.tasks = result.tasks;

    if (!result.task.completed) {
      addEffects(effects, ['persist-tasks']);
      return { state: syncBasePet(next), effects, ok: true, task: result.task };
    }

    // 完成任务：记录统计 + 庆祝
    next.stats = statsModule.recordTaskCompleted(state.stats, state.now);
    const summary = tasksModule.summarize(next.tasks);
    if (next.ui.bubble && next.ui.bubble.kind === 'task_nudge') {
      next = clearBubble(next, effects);
      effects.push({ type: 'pet-return' });
    }
    const seed = next.stats.totalCompleted;
    const holder = 'celebrate-' + state.now;

    next.pet = petModule.transition(next.pet, {
      to: PET_STATES.CELEBRATION,
      reason: summary.allDone ? 'all_done' : 'task_done',
      now: state.now,
      holder
    }).pet;

    if (state.settings.soundEnabled) effects.push({ type: 'sound', cue: 'pop' });
    if (state.settings.effectsEnabled) {
      effects.push({ type: 'effect', name: 'confetti' });
      if (state.settings.soundEnabled) effects.push({ type: 'sound', cue: 'celebrate' });
    }

    // 若界面上还有未处理的主动提醒，庆祝气泡不抢占提醒位置，只切换宠物状态
    if (mayReplaceBubble(next)) {
      next = withBubble(
        next,
        makeBubble({
          id: holder,
          kind: 'celebration',
          tone: 'celebrate',
          title: summary.allDone ? '全部完成' : '又完成一件',
          text: summary.allDone
            ? copyModule.pick('celebrate', seed)
            : copyModule.pickAvoiding('celebratePartial', seed, state.ui.lastChatterLine),
          autoDismissMs: summary.allDone ? 5200 : 2800,
          shownAt: state.now
        })
      );
    }

    addEffects(effects, ['persist-tasks', 'persist-stats']);
    return { state: next, effects, ok: true, task: result.task, allDone: summary.allDone };
  }

  function actTaskRemove(state, action, effects) {
    const result = tasksModule.removeTask(state.tasks, action.id);
    if (!result.ok) return { state, effects, ok: false, error: result.reason };
    let next = cloneState(state);
    next.tasks = result.tasks;
    if (!next.tasks.some((task) => !task.completed) && next.ui.bubble && next.ui.bubble.kind === 'task_nudge') {
      next = clearBubble(next, effects); effects.push({ type: 'pet-return' });
    }
    if (next.ui.focusTaskId && !tasksModule.findTask(next.tasks, next.ui.focusTaskId)) {
      next.ui.focusTaskId = null;
    }
    addEffects(effects, ['persist-tasks']);
    return { state: next, effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function actSettingsUpdate(state, action, effects) {
    const patch = action.patch && typeof action.patch === 'object' ? action.patch : {};
    const wantsCompanion = Object.prototype.hasOwnProperty.call(patch, 'companionMode')
      ? Boolean(patch.companionMode)
      : null;

    const settingsPatch = Object.assign({}, patch);
    delete settingsPatch.companionMode;

    const merged = settingsModule.normalizeSettings(Object.assign({}, state.settings, settingsPatch));
    const settingsChanged = !settingsModule.settingsEqual(merged, state.settings);
    const companionChanged = wantsCompanion !== null && wantsCompanion !== state.ui.companionMode;

    if (!settingsChanged && !companionChanged) {
      return { state, effects, ok: true, changed: false };
    }

    let next = cloneState(state);
    next.settings = merged;
    if (companionChanged) next.ui.companionMode = wantsCompanion;

    // 休息间隔变化立即作用到计时器
    if (merged.breakReminderMinutes !== state.settings.breakReminderMinutes) {
      next.timers = timersModule.setBreakInterval(next.timers, merged.breakReminderMinutes, state.now);
      addEffects(effects, ['persist-timers']);
    }

    if (companionChanged && mayReplaceBubble(state)) {
      next.ui.companionMode = wantsCompanion;
      next = withBubble(
        next,
        makeBubble({
          kind: 'info',
          tone: 'companion',
          title: wantsCompanion ? '陪伴模式' : '',
          text: wantsCompanion ? '我在这儿，慢慢来。' : '',
          autoDismissMs: wantsCompanion ? 2800 : 0,
          shownAt: state.now
        })
      );
    }

    // 免打扰：清理自动提醒，优先于普通提醒（需求 6.2）
    const dndOn = merged.doNotDisturb && !state.settings.doNotDisturb;
    if((dndOn||!merged.effectsEnabled||!merged.guardEffectsEnabled)&&state.pet.current===PET_STATES.EFFECT&&state.pet.reason==='guard_auto'){
      next.pet=petModule.release(next.pet,{now:state.now,reason:'guard_cancel'}).pet;
      effects.push({type:'effect-end'},{type:'pet-return'});
    }
    if (dndOn) {
      effects.push({ type: 'pet-return' });
      // 未处理的提醒一并丢弃，避免开启后马上又弹出来
      next.queue = queueModule.clear(next.queue);
      if (next.ui.bubble) {
        next.ui.bubble = null;
      }
      next.pet = petModule.transition(next.pet, {
        to: PET_STATES.DO_NOT_DISTURB,
        reason: 'dnd_on',
        now: state.now,
        force: true
      }).pet;
    }

    next = syncBasePet(next);
    if ((!merged.gameGuardEnabled && next.ui.bubble && next.ui.bubble.kind === 'task_nudge') ||
      (!merged.healthRemindersEnabled && next.ui.bubble && next.ui.bubble.kind === 'water')) {
      next = clearBubble(next, effects);
      effects.push({ type: 'pet-return' });
    }

    if (merged.doNotDisturb !== state.settings.doNotDisturb) {
      addEffects(effects, ['persist-settings']);
    }
    if (settingsChanged) addEffects(effects, ['persist-settings']);
    return { state: next, effects, ok: true, changed: true };
  }

  /* ------------------------------------------------------------------ *
   * 专注
   * ------------------------------------------------------------------ */

  function resolveFocusMinutes(state, raw) {
    return util.clampNumber(raw, 1, 180, state.settings.focusDurationMinutes);
  }

  function actFocusStart(state, action, effects) {
    const minutes = resolveFocusMinutes(state, action.minutes);
    const taskId =
      action.taskId === null
        ? null
        : typeof action.taskId === 'string'
          ? action.taskId
          : state.ui.focusTaskId;

    const started = timersModule.startFocus(state.timers, {
      now: state.now,
      durationMinutes: minutes,
      taskId
    });

    let next = cloneState(state);
    next.timers = started.state;
    next.ui.focusTaskId = tasksModule.findTask(next.tasks, taskId) ? taskId : null;
    next.ui.companionMode = false;
    next.pet = petModule.transition(next.pet, {
      to: PET_STATES.FOCUS,
      reason: 'focus_start',
      now: state.now,
      force: true
    }).pet;
    next = withBubble(
      next,
      makeBubble({
        kind: 'info',
        tone: 'focus',
        title: '专注开始',
        text: copyModule.pick('focusStart', Math.floor(state.now / 1000)),
        autoDismissMs: 2600,
        shownAt: state.now
      })
    );
    if (state.settings.soundEnabled) effects.push({ type: 'sound', cue: 'start' });
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  function actFocusPause(state, action, effects) {
    const result = timersModule.pauseFocus(state.timers, state.now);
    if (!result.changed) return { state, effects, ok: false, error: result.reason };
    const next = cloneState(state);
    next.timers = result.state;
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  function actFocusResume(state, action, effects) {
    const result = timersModule.resumeFocus(state.timers, state.now);
    if (!result.changed) return { state, effects, ok: false, error: result.reason };
    let next = cloneState(state);
    next.timers = result.state;
    next.pet = petModule.transition(next.pet, {
      to: PET_STATES.FOCUS,
      reason: 'focus_resume',
      now: state.now
    }).pet;
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  function actFocusStop(state, action, effects) {
    const result = timersModule.stopFocus(state.timers);
    let next = cloneState(state);
    next.timers = result.state;
    next.ui.focusTaskId = null;
    next = syncBasePet(next);
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  function actFocusExtend(state, action, effects) {
    const minutes = util.clampNumber(action.minutes, 1, 180, EXTEND_MINUTES);
    const result = timersModule.extendFocus(state.timers, minutes, state.now);
    if (!result.changed) {
      // 已经没有进行中的专注（例如 tick 刚结算完）：直接开始新一轮
      return actFocusStart(state, { minutes, taskId: state.ui.focusTaskId }, effects);
    }
    let next = cloneState(state);
    next.timers = result.state;
    next.pet = petModule.transition(next.pet, {
      to: PET_STATES.FOCUS,
      reason: 'focus_extend',
      now: state.now,
      force: true
    }).pet;
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 休息
   * ------------------------------------------------------------------ */

  function actBreakConfirm(state, action, effects) {
    const result = timersModule.confirmBreak(state.timers, state.now);
    const next = cloneState(state);
    next.timers = result.state;
    next.initiative = Object.assign({}, next.initiative, { workMs: 0, restUntil: 0 });
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  function actBreakSnooze(state, action, effects) {
    const minutes = util.clampNumber(action.minutes, 1, 120, state.settings.snoozeMinutes);
    const result = timersModule.snoozeBreak(state.timers, minutes, state.now);
    const next = cloneState(state);
    next.timers = result.state;
    next.initiative = Object.assign({}, next.initiative, { restUntil: state.now + minutes * 60000 });
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  function actBreakSuppress(state, action, effects) {
    const result = timersModule.suppressBreakForToday(state.timers, state.now);
    const next = cloneState(state);
    next.timers = result.state;
    next.initiative = Object.assign({}, next.initiative, { restUntil: result.state.breakTimer.suppressedUntil || 0 });
    addEffects(effects, ['persist-timers']);
    return { state: next, effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 提醒气泡上的操作
   * ------------------------------------------------------------------ */

  function settleFocusSession(worked, effects) {
    const settled = timersModule.settleFocus(worked.timers);
    const next = cloneState(worked);
    next.timers = settled.state;
    next.stats = statsModule.recordFocusSession(
      next.stats,
      worked.now,
      util.msToMinutes(worked.timers.focus.totalMs || 0) || worked.settings.focusDurationMinutes
    );
    addEffects(effects, ['persist-timers', 'persist-stats']);
    return syncBasePet(next);
  }

  /**
   * 只在需要时结算这一轮专注。
   * tick 到期时已经结算过一次（状态已回到 idle），这里再结算就会重复计数。
   */
  function maybeSettleFocusSession(worked, effects) {
    if (worked.timers.focus.status === 'idle') return worked;
    return settleFocusSession(worked, effects);
  }

  /**
   * 专注结束后点“我完成了”。
   *
   * 需求 5.4 要求：将当前任务标记为完成，“或进入任务确认流程”。
   * 因此这里分三种情况：
   *  1. 有明确关联任务 -> 直接完成它；
   *  2. 没有关联任务但清单里还有未完成的 -> 弹出任务选择，让用户确认是哪一件；
   *  3. 清单是空的 -> 只结算这一轮专注，并说明情况。
   */
  function completeAfterFocus(state, effects) {
    const bubble = state.ui.bubble;
    const taskId = state.ui.focusTaskId || (bubble && bubble.taskId) || null;
    const task = taskId ? tasksModule.findTask(state.tasks, taskId) : null;

    if (task && !task.completed) {
      let worked = actTaskToggle(state, { id: task.id, completed: true }, effects).state;
      worked = maybeSettleFocusSession(worked, effects);
      return worked;
    }

    const pending = state.tasks.filter((t) => !t.completed);
    if (pending.length > 0) {
      // 进入任务确认流程：让用户挑一条作为本轮成果
      const options = pending.slice(0, 4).map((t) => ({
        id: 'pick:' + t.id,
        label: t.title.length > 14 ? t.title.slice(0, 13) + '…' : t.title,
        tone: 'default'
      }));
      options.push({ id: 'pick:none', label: '这轮没完成具体任务', tone: 'ghost' });

      const next = withBubble(
        state,
        makeBubble({
          id: util.createId('bubble'),
          kind: 'task_pick',
          tone: 'focus',
          title: '哪件事完成了？',
          text: '这一轮专注对应哪条任务？点一条就替你划掉。',
          actions: options,
          autoDismissMs: 0,
          shownAt: state.now
        })
      );
      return next;
    }

    // 清单为空：只结算专注
    const settled = maybeSettleFocusSession(state, effects);
    return withBubble(
      settled,
      makeBubble({
        kind: 'info',
        tone: 'info',
        title: '这一轮结束了',
        text: '清单里还没有任务，先记一条下次就能对上。',
        autoDismissMs: 3600,
        shownAt: state.now
      })
    );
  }

  function actReminderAction(state, action, effects) {
    const bubble = state.ui.bubble;
    if (!bubble) return { state, effects, ok: false, error: 'no_bubble' };
    if (bubble.kind === 'water') {
      const next = clearBubble(state, effects);
      next.initiative = Object.assign({}, next.initiative, action.actionId === 'drink'
        ? { waterMs: 0, waterUntil: 0 }
        : { waterUntil: state.now + state.settings.snoozeMinutes * 60000 });
      effects.push({ type: 'pet-return' }, { type: 'persist-timers' });
      return { state: next, effects, ok: true };
    }
    if (bubble.kind === 'task_nudge') {
      if (action.actionId === 'close_app') {
        effects.push({ type: 'entertainment-close', holder: bubble.id });
        return { state, effects, ok: true };
      }
      if (action.actionId === 'minimize_app') {
        effects.push({ type: 'entertainment-minimize', holder: bubble.id });
        return { state, effects, ok: true };
      }
      let next = clearBubble(state, effects);
      next.initiative = Object.assign({}, next.initiative, { guardUntil: state.now + (action.actionId === 'finish_round' ? 5 : state.settings.guardCooldownMinutes) * 60000 });
      effects.push({ type: 'pet-return' }, { type: 'persist-timers' });
      if (action.actionId === 'start_task') {
        const task = next.tasks.find((item) => !item.completed);
        if (task) next = actFocusStart(next, { taskId: task.id, minutes: next.settings.focusDurationMinutes }, effects).state;
        effects.push({ type: 'open-tasks' });
      }
      return { state: next, effects, ok: true };
    }

    // 任务确认流程的选择结果
    if (bubble.kind === 'task_pick') {
      const actionId = String(action.actionId || '');
      if (actionId.indexOf('pick:') !== 0) {
        return { state, effects, ok: false, error: 'unknown_action' };
      }
      const pickedId = actionId.slice('pick:'.length);
      let worked = clearBubble(state, effects);
      if (pickedId !== 'none') {
        const toggled = actTaskToggle(worked, { id: pickedId, completed: true }, effects);
        if (toggled.ok) {
          worked = toggled.state;
        } else {
          worked = withBubble(
            worked,
            makeBubble({
              kind: 'info',
              tone: 'warn',
              title: '任务已不存在',
              text: '这条任务好像被删掉了，专注记录已经保留。',
              autoDismissMs: 3200,
              shownAt: state.now
            })
          );
        }
      }
      worked = maybeSettleFocusSession(worked, effects);
      return { state: worked, effects, ok: true };
    }

    if (bubble.kind === 'focus_done') {
      switch (action.actionId) {
        case 'complete':
          return { state: completeAfterFocus(clearBubble(state, effects), effects), effects, ok: true };
        case 'extend':
          return actFocusExtend(clearBubble(state, effects), { minutes: EXTEND_MINUTES }, effects);
        case 'snooze': {
          const minutes = state.settings.snoozeMinutes;
          const worked = clearBubble(state, effects);
          const queued = enqueueReminder(
            worked,
            {
              kind: 'focus_done',
              tone: 'focus',
              title: '专注提醒',
              text: '刚才那一轮还没处理，现在继续吗？',
              actions: FOCUS_REMINDER_ACTIONS,
              taskId: state.ui.focusTaskId,
              sound: 'soft',
              auto: false,
              availableAt: state.now + util.minutesToMs(minutes)
            },
            effects
          );
          return { state: queued, effects, ok: true };
        }
        case 'break':
          return actBreakConfirm(clearBubble(state, effects), {}, effects);
        default:
          return { state, effects, ok: false, error: 'unknown_action' };
      }
    }

    if (bubble.kind === 'break') {
      switch (action.actionId) {
        case 'confirm': {
          const worked = actBreakConfirm(clearBubble(state, effects), {}, effects);
          if (state.settings.soundEnabled) effects.push({ type: 'sound', cue: 'ok' });
          return { state: worked.state, effects, ok: true };
        }
        case 'snooze':
          return actBreakSnooze(clearBubble(state, effects), { minutes: state.settings.snoozeMinutes }, effects);
        case 'suppress':
          return actBreakSuppress(clearBubble(state, effects), {}, effects);
        default:
          return { state, effects, ok: false, error: 'unknown_action' };
      }
    }

    return { state: clearBubble(state, effects), effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 特效
   * ------------------------------------------------------------------ */

  function actEffectPlay(state, action, effects) {
    const name = util.toEnum(action.name, ['slash', 'crack', 'confetti', 'reminder'], 'slash');
    if (state.settings.effectsEnabled !== true && action.manual !== true) {
      return { state, effects, ok: false, error: 'effects_disabled' };
    }
    const holder = 'effect-' + name + '-' + state.now;
    let next = cloneState(state);
    next.pet = petModule.transition(next.pet, {
      to: PET_STATES.EFFECT,
      reason: name,
      now: state.now,
      holder,
      force: true
    }).pet;
    next.pet.effect = name;
    if (name === 'reminder' && !next.ui.bubble) next.ui.bubble = makeBubble({
      kind: 'info', title: '鱼鱼来提醒你啦', text: '忙了一阵，记得喝水、看看远处。我就陪在这里。',
      autoDismissMs: 2800, shownAt: state.now
    });
    if (state.settings.soundEnabled) {
      effects.push({
        type: 'sound',
        cue: name === 'slash' ? 'slash' : name === 'crack' ? 'crack' : name === 'reminder' ? 'focus-done' : 'celebrate'
      });
    }
    effects.push({ type: 'effect', name, holder });
    return { state: next, effects, ok: true, holder };
  }

  function actGuardPerform(state,action,effects) {
    const bubble=state.ui.bubble;
    if(!bubble||bubble.kind!=='task_nudge'||bubble.id!==action.holder||bubble.performanceStarted||!bubble.guardEffect||
      !state.settings.gameGuardEnabled||!state.settings.guardEffectsEnabled||!state.settings.effectsEnabled||state.settings.doNotDisturb||!state.tasks.some(task=>!task.completed))return {state,effects,ok:false};
    const next=cloneState(state);
    next.ui.bubble=Object.assign({},bubble,{performanceStarted:true});
    next.initiative=Object.assign({},next.initiative,{guardEffectCount:next.initiative.guardEffectCount+1});
    next.pet=petModule.transition(next.pet,{to:PET_STATES.EFFECT,reason:'guard_auto',holder:bubble.id,now:state.now,force:true}).pet;
    next.pet.effect=bubble.guardEffect;
    effects.push({type:'effect',name:bubble.guardEffect,holder:bubble.id});
    effects.push({type:'persist-timers'});
    if(state.settings.soundEnabled)effects.push({type:'sound',cue:bubble.guardEffect});
    return {state:next,effects,ok:true};
  }

  function actEffectEnd(state, action, effects) {
    if (state.pet.current !== PET_STATES.EFFECT) {
      return { state, effects, ok: false, error: 'no_effect' };
    }
    if (action.holder && state.pet.holder && action.holder !== state.pet.holder) {
      return { state, effects, ok: false, error: 'holder_mismatch' };
    }
    let next = cloneState(state);
    next.pet = petModule.release(next.pet, { now: state.now, reason: 'effect_end' }).pet;
    next = syncBasePet(next);
    if(next.ui.bubble&&next.ui.bubble.kind==='task_nudge')next.pet=petModule.transition(next.pet,{to:PET_STATES.REMINDER,reason:'task_nudge',holder:next.ui.bubble.id,now:state.now,force:true}).pet;
    effects.push({ type: 'effect-end' });
    return { state: next, effects, ok: true };
  }

  function actReleasePet(state, action, effects) {
    if (state.pet.current !== PET_STATES.CELEBRATION) {
      return { state, effects, ok: false };
    }
    let next = cloneState(state);
    next.pet = petModule.release(next.pet, { now: state.now, reason: 'auto' }).pet;
    next = syncBasePet(next);
    return { state: next, effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 陪伴与闲聊
   * ------------------------------------------------------------------ */

  function actCompanionTalk(state, action, effects) {
    const mode = util.toEnum(action.mode, ['joke', 'praise', 'chat'], 'chat');
    const seed = Math.floor((util.isFiniteNumber(action.seed) ? action.seed : state.now) / 1000);
    const text =
      mode === 'joke'
        ? copyModule.joke(seed)
        : mode === 'praise'
          ? copyModule.praise(seed)
          : copyModule.pick('companion', seed);

    const next = withBubble(
      state,
      makeBubble({
        kind: 'companion',
        tone: 'companion',
        title: mode === 'joke' ? '冷笑话' : mode === 'praise' ? '夸夸你' : '陪你待会儿',
        text,
        autoDismissMs: 6000,
        shownAt: state.now
      })
    );
    return { state: next, effects, ok: true, text };
  }

  /** 定时闲聊：只在空闲且没有气泡时说话，避免打扰 */
  function actChatter(state, action, effects) {
    if (state.settings.chatterEnabled !== true) return { state, effects, ok: false, error: 'disabled' };
    if (state.settings.doNotDisturb) return { state, effects, ok: false, error: 'dnd' };
    if (state.ui.bubble) return { state, effects, ok: false, error: 'busy' };
    if (state.pet.current === PET_STATES.FOCUS) return { state, effects, ok: false, error: 'focus' };
    if (petModule.isExclusive(state.pet.current)) return { state, effects, ok: false, error: 'exclusive' };

    const summary = tasksModule.summarize(state.tasks);
    let pool = action.pool;
    if (!pool) {
      if (state.ui.companionMode) pool = 'companion';
      else if (summary.isEmpty) pool = 'emptyTasks';
      else pool = 'idle';
    }

    const text = copyModule.pickAvoiding(
      pool,
      Math.floor((util.isFiniteNumber(action.seed) ? action.seed : state.now) / 1000),
      state.ui.lastChatterLine
    );
    if (!text) return { state, effects, ok: false, error: 'empty_pool' };

    const next = withBubble(
      state,
      makeBubble({
        kind: 'chatter',
        tone: 'info',
        text,
        autoDismissMs: 4200,
        shownAt: state.now
      })
    );
    next.ui.lastChatterLine = text;
    next.ui.lastChatterAt = state.now;
    return { state: next, effects, ok: true, text };
  }

  function actBubbleDismiss(state, action, effects) {
    if (!state.ui.bubble) return { state, effects, ok: false };
    if (action.id && state.ui.bubble.id !== action.id) {
      return { state, effects, ok: false, error: 'stale' };
    }
    effects.push({ type: 'pet-return' });
    return { state: clearBubble(state, effects), effects, ok: true };
  }

  function showInitiative(state, event, effects) {
    const pending = state.tasks.filter((task) => !task.completed);
    const water = event.kind === 'water';
    const game = event.kind === 'task_nudge';
    const text = water ? '已经认真忙了一阵啦。鱼鱼把水杯递过来，先喝两口水好不好？'
      : game ? '清单里还有 ' + pending.length + ' 件事没做完' + (pending[0] ? '，先拿下「' + pending[0].title.slice(0, 24) + '」嘛。' : '，我们先回来做一小步吧。')
      : '你连续用电脑比较久啦，起来伸个懒腰、看看远处，我帮你守着桌面。';
    return enqueueReminder(state, {
      kind: event.kind, auto: true, appName: event.appName || '',
      autoDismissMs: water ? 20000 : game ? 25000 : 0,
      title: water ? '喝水时间，鱼鱼来啦' : game ? '抓到一只还有任务的你' : '站起来活动一下嘛',
      text, tone: water ? 'water' : game ? 'guard' : 'break', sound: 'soft',
      actions: water ? [
        { id: 'drink', label: '喝过啦', tone: 'primary' }, { id: 'later', label: '等会儿喝', tone: 'ghost' }
      ] : game ? [
        { id: 'start_task', label: '好，先做任务', tone: 'primary' },
        { id: 'finish_round', label: '这局打完 · 5 分钟', tone: 'default' },
        { id: 'minimize_app', label: '先收起娱乐窗口', tone: 'ghost' },
        { id: 'close_app', label: '关闭娱乐窗口…', tone: 'ghost' }
      ] : BREAK_REMINDER_ACTIONS
    }, effects);
  }

  function actActivity(state, action, effects) {
    const now = Number.isFinite(action.now) ? action.now : state.now;
    const plan = initiativeModule.advance(state.initiative, Object.assign({}, action, { now }), state.settings, {
      pendingCount: state.tasks.filter((task) => !task.completed).length,
      busy: Boolean(state.ui.bubble) || state.pet.current === 'effect' || queueModule.hasReady(state.queue, now)
    });
    let next = cloneState(state);
    next.now = now;
    next.initiative = plan.next;
    if(next.ui.bubble&&next.ui.bubble.kind==='task_nudge'&&(action.desktopActive===false||
      (next.ui.bubble.appName&&typeof action.matchedApp==='string'&&action.matchedApp!==next.ui.bubble.appName)))next=clearBubble(next,effects);
    if (plan.event) next = showInitiative(next, plan.event, effects);
    if (plan.event || Math.floor(plan.next.waterMs / 60000) !== Math.floor((state.initiative.waterMs || 0) / 60000)) effects.push({ type: 'persist-timers' });
    return { state: next, effects, ok: true };
  }

  function actInitiativeDemo(state, action, effects) {
    if (state.settings.doNotDisturb) return { state, effects, ok: false, error: 'do_not_disturb' };
    const kind = util.toEnum(action.kind, ['water', 'break', 'task_nudge'], 'water');
    return { state: showInitiative(clearBubble(state, effects), { kind }, effects), effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 时间推进
   * ------------------------------------------------------------------ */

  function actTick(state, action, effects) {
    const now = util.isFiniteNumber(action.now) ? action.now : Date.now();
    let next = cloneState(state);
    next.now = now;

    // 0) 到期的气泡自动消失（由 reducer 负责，避免窗口失焦后回调丢失导致气泡卡住）
    const bubble = next.ui.bubble;
    if (bubble && bubble.autoDismissMs > 0 && now - bubble.shownAt >= bubble.autoDismissMs) {
      next = clearBubble(next, effects);
    }

    const ctx = baseContext(next);

    // 1) 专注计时（以绝对结束时间判断，避免漂移）
    const tick = timersModule.tickFocus(next.timers, now);
    next.timers = tick.state;

    if (tick.finished) {
      const totalMs = next.timers.focus.totalMs || util.minutesToMs(next.settings.focusDurationMinutes);
      const settled = timersModule.settleFocus(next.timers);
      next.timers = settled.state;
      next.stats = statsModule.recordFocusSession(next.stats, now, util.msToMinutes(totalMs));
      addEffects(effects, ['persist-timers', 'persist-stats']);

      const busy = queueModule.isBusy(next.queue) || Boolean(next.ui.bubble);
      const allowed = petModule.canShowAutoReminder({
        doNotDisturb: ctx.doNotDisturb,
        reminderBusy: busy,
        effectActive: next.pet.current === PET_STATES.EFFECT
      });      if (allowed) {
        next = enqueueReminder(
          next,
          {
            kind: 'focus_done',
            tone: 'focus',
            title: '专注结束',
            text: copyModule.pick('focusDone', Math.floor(now / 1000)),
            actions: FOCUS_REMINDER_ACTIONS,
            taskId: next.ui.focusTaskId,
            sound: 'focus-done',
            auto: true
          },
          effects
        );
      }
      next = syncBasePet(next);
    }

    // 2) 休息提醒
    const evaluation = timersModule.evaluateBreak(next.timers, {
      now,
      enabled: next.settings.breakRemindersEnabled === true && !next.initiative.sampleSeen,
      doNotDisturb: ctx.doNotDisturb,
      busy: queueModule.isBusy(next.queue) || Boolean(next.ui.bubble),
      minGapMinutes: next.settings.minReminderGapMinutes
    });

    if (evaluation.due) {
      next = enqueueReminder(
        next,
        {
          kind: 'break',
          tone: 'break',
          title: '该休息了',
          text: copyModule.pick('break', Math.floor(now / 1000 / 3)),
          actions: BREAK_REMINDER_ACTIONS,
          sound: 'break',
          auto: true
        },
        effects
      );
      // 展示过就记一次，并把下一次推到未来，避免 tick 反复入队
      next.timers = timersModule.markReminderShown(next.timers, now);
      next.timers = timersModule.snoozeBreak(next.timers, next.settings.breakReminderMinutes, now).state;
      addEffects(effects, ['persist-timers']);
    }

    // 3) 延迟中的提醒（稍后提醒 / 排队的提醒）到点后进入气泡
    next = pumpBubble(next, effects);
    return { state: next, effects, ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 入口
   * ------------------------------------------------------------------ */

  const HANDLERS = {
    'tasks/add': actTaskAdd,
    'tasks/toggle': actTaskToggle,
    'tasks/remove': actTaskRemove,
    'settings/update': actSettingsUpdate,
    'focus/start': actFocusStart,
    'focus/pause': actFocusPause,
    'focus/resume': actFocusResume,
    'focus/stop': actFocusStop,
    'focus/extend': actFocusExtend,
    'break/confirm': actBreakConfirm,
    'break/snooze': actBreakSnooze,
    'break/suppress': actBreakSuppress,
    'reminder/action': actReminderAction,
    'bubble/dismiss': actBubbleDismiss,
    'effect/play': actEffectPlay,
    'effect/end': actEffectEnd,
    'pet/release': actReleasePet,
    'companion/talk': actCompanionTalk,
    chatter: actChatter,
    tick: actTick,
    'activity/sample': actActivity,
    'initiative/demo': actInitiativeDemo,
    'guard/perform': actGuardPerform,
    'pet/wave': (state, action, effects) => { effects.push({ type: 'pet-wave' }); return { state, effects, ok: true }; }
  };

  function reduce(state, action) {
    const effects = [];
    const act = action || {};
    const handler = HANDLERS[act.type];
    if (!handler) return { state, effects, ok: false, error: 'unknown_action' };
    const result = handler(state, act, effects);
    return result || { state, effects, ok: false };
  }

  /** 会话恢复：把磁盘内容装配成运行时状态，并给出恢复提示 */
  function hydrate(payload, now) {
    const at = util.isFiniteNumber(now) ? now : Date.now();
    const issues = [];
    const settings = settingsModule.normalizeSettings(payload && payload.settings, issues);
    const tasks = tasksModule.normalizeTasks(payload && payload.tasks, issues);
    const stats = statsModule.normalizeStats(payload && payload.stats, issues);

    // 计时状态可能包在 session 里（磁盘格式），也可能直接给 timers（测试/内存）
    const rawTimers =
      payload && payload.timers
        ? payload.timers
        : payload && payload.session && payload.session.timers
          ? payload.session.timers
          : null;
    const restored = timersModule.restore(rawTimers, at);
    for (const issue of restored.issues) issues.push(issue);

    let state = createInitialState({ now: at, settings, tasks, stats, timers: restored.state, initiative: payload && payload.session && payload.session.initiative });
    state.timers.breakTimer.intervalMs = util.minutesToMs(settings.breakReminderMinutes);
    state.ui.focusTaskId =
      state.timers.focus.taskId || (payload && payload.session && payload.session.focusTaskId) || null;
    state = syncBasePet(state);
    state.ui.recovered = issues.length > 0;

    // 关闭期间刚结束的那一轮专注：只补一次提醒，绝不批量补发（需求 7.5）
    if (restored.missed && restored.missed.kind === 'focus' && settings.doNotDisturb !== true) {
      const effects = [];
      state = enqueueReminder(
        state,
        {
          kind: 'focus_done',
          tone: 'focus',
          title: '专注结束',
          text: '刚才那一轮专注在你离开时结束了。',
          actions: FOCUS_REMINDER_ACTIONS,
          taskId: restored.missed.taskId,
          sound: 'soft',
          auto: true,
          availableAt: at
        },
        effects
      );
      state.ui.focusTaskId = state.ui.focusTaskId || restored.missed.taskId || null;
    }

    return {
      state,
      missed: restored.missed,
      issues,
      recovered: issues.length > 0
    };
  }

  const api = {
    FOCUS_REMINDER_ACTIONS,
    BREAK_REMINDER_ACTIONS,
    EXTEND_MINUTES,
    createInitialState,
    hydrate,
    reduce,
    clearBubble,
    syncBasePet,
    makeBubble
  };

  if (isNode) {
    module.exports = api;
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.appState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);


