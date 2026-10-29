/**
 * 面板视图：任务 / 专注 / 设置 / 陪伴。
 * 与宠物窗口共用同一份状态，通过 actions 回传给控制器。
 */
(function (global) {
  'use strict';

  const util = global.DeskBuddy.util;
  const tasksModule = global.DeskBuddy.tasks;
  const timersModule = global.DeskBuddy.timers;
  const statsModule = global.DeskBuddy.stats;

  const DURATIONS = [5, 15, 25, 45, 60, 90];

  const ERROR_TEXT = {
    empty: '先写点内容再添加。',
    too_long: '标题太长了，压缩到 80 个字以内。',
    duplicate: '这条任务已经在清单里了。',
    full: '任务数量已达上限，先清掉一些吧。'
  };

  function createPanels(options) {
    const opts = options || {};
    const doc = opts.document || global.document;
    const dispatch = opts.dispatch;

    const el = {
      view: doc.getElementById('panel-view'),
      title: doc.getElementById('panel-title-text'),
      close: doc.getElementById('panel-close'),
      body: doc.getElementById('panel-body'),
      screens: Array.prototype.slice.call(doc.querySelectorAll('.panel-screen')),
      footerPrimary: doc.getElementById('panel-primary'),
      footerSecondary: doc.getElementById('panel-secondary'),

      // tasks
      taskForm: doc.getElementById('task-form'),
      taskInput: doc.getElementById('task-input'),
      taskError: doc.getElementById('task-error'),
      pendingList: doc.getElementById('task-list-pending'),
      doneList: doc.getElementById('task-list-done'),
      doneLabel: doc.getElementById('done-label'),
      empty: doc.getElementById('task-empty'),
      progressText: doc.getElementById('task-progress-text'),
      progressPct: doc.getElementById('task-progress-pct'),
      progressFill: doc.getElementById('task-progress-fill'),

      // focus
      clock: doc.getElementById('focus-clock'),
      focusLabel: doc.getElementById('focus-label'),
      focusTask: doc.getElementById('focus-task'),
      focusPrimary: doc.getElementById('focus-primary'),
      focusSecondary: doc.getElementById('focus-secondary'),
      focusComplete: doc.getElementById('focus-complete'),
      focusStop: doc.getElementById('focus-stop'),
      durationRow: doc.getElementById('duration-row'),
      breakToggle: doc.getElementById('break-toggle'),
      breakValue: doc.getElementById('break-interval-value'),
      snoozeValue: doc.getElementById('snooze-value'),
      statFocus: doc.getElementById('stat-focus'),
      statDone: doc.getElementById('stat-done'),
      statStreak: doc.getElementById('stat-streak'),

      // settings
      dndSwitch: doc.getElementById('dnd-setting'),
      soundSwitch: doc.getElementById('sound-setting'),
      effectsSwitch: doc.getElementById('effects-setting'),
      chatterSwitch: doc.getElementById('chatter-setting'),
      alwaysTopSwitch: doc.getElementById('always-top-setting'),
      launchSwitch: doc.getElementById('launch-setting'),
      lifeSwitch: doc.getElementById('life-setting'),
      wanderSwitch: doc.getElementById('wander-setting'),
      healthSwitch: doc.getElementById('health-setting'),
      guardSwitch: doc.getElementById('game-guard-setting'),
      guardEffectsSwitch: doc.getElementById('guard-effects-setting'),
      waterInterval: doc.getElementById('water-interval-value'),
      restActive: doc.getElementById('rest-active-value'),
      gameGrace: doc.getElementById('game-grace-value'),
      guardMode: doc.getElementById('guard-mode'),
      entertainmentApps: doc.getElementById('entertainment-apps'),
      saveEntertainmentApps: doc.getElementById('save-entertainment-apps'),
      initiativeStatus: doc.getElementById('initiative-status'),
      launchDesc: doc.getElementById('launch-desc'),
      scaleValue: doc.getElementById('scale-value'),
      settingsDurationRow: doc.getElementById('settings-duration-row'),
      dataDir: doc.getElementById('data-dir'),
      openDataFolder: doc.getElementById('open-data-folder'),
      recoverPet: doc.getElementById('recover-pet'),

      // companion
      companionGreeting: doc.getElementById('companion-greeting'),
      companionBubble: doc.getElementById('companion-bubble'),
      companionSwitch: doc.getElementById('companion-switch'),
      cStatDone: doc.getElementById('c-stat-done'),
      cStatFocus: doc.getElementById('c-stat-focus'),
      cStatMinutes: doc.getElementById('c-stat-minutes')
    };

    let kind = '';
    let lastSignature = '';
    let lastTalkText = '';
    let errorTimer = null;
    const taskNodes = new Map();

    const TITLES = {
      tasks: '今日任务',
      focus: '专注与休息',
      settings: '设置',
      companion: '和鱼鱼聊聊'
    };

    function showError(text) {
      if (!el.taskError) return;
      el.taskError.textContent = text;
      el.taskError.classList.add('visible');
      el.taskInput.classList.add('invalid');
      if (errorTimer) global.clearTimeout(errorTimer);
      errorTimer = global.setTimeout(() => {
        el.taskError.classList.remove('visible');
        el.taskInput.classList.remove('invalid');
        errorTimer = null;
      }, 2400);
    }

    function clearError() {
      if (!el.taskError) return;
      el.taskError.classList.remove('visible');
      el.taskInput.classList.remove('invalid');
    }

    /* ---------------- 任务列表 ---------------- */

    function taskSignature(state) {
      return state.tasks
        .map((t) => t.id + ':' + (t.completed ? 1 : 0) + ':' + t.title)
        .join('|');
    }

    function renderTaskItem(task, state) {
      const li = doc.createElement('li');
      li.className = 'task-item' + (task.completed ? ' completed' : '');
      li.dataset.taskId = task.id;

      const check = doc.createElement('button');
      check.className = 'task-check';
      check.type = 'button';
      check.dataset.taskToggle = task.id;
      check.setAttribute('aria-label', task.completed ? '取消完成' : '标记完成');
      check.setAttribute('role', 'checkbox');
      check.setAttribute('aria-checked', task.completed ? 'true' : 'false');

      const main = doc.createElement('div');
      main.className = 'task-main';

      const title = doc.createElement('div');
      title.className = 'task-title';
      title.textContent = task.title;
      main.appendChild(title);

      const meta = doc.createElement('div');
      meta.className = 'task-meta';
      const created = doc.createElement('span');
      created.textContent = util.formatTime(task.createdAt) + ' 添加';
      meta.appendChild(created);

      const due = tasksModule.dueState(task, state.now);
      if (due.state !== 'none') {
        const dueEl = doc.createElement('span');
        if (due.state === 'overdue') {
          dueEl.className = 'due-overdue';
          dueEl.textContent = '已过期';
        } else if (due.state === 'today') {
          dueEl.className = 'due-today';
          dueEl.textContent = '今天 ' + util.formatTime(due.at);
        } else {
          dueEl.textContent = '截止 ' + util.formatTime(due.at);
        }
        meta.appendChild(dueEl);
      }
      main.appendChild(meta);

      const del = doc.createElement('button');
      del.className = 'task-del';
      del.type = 'button';
      del.dataset.taskRemove = task.id;
      del.title = '删除任务';
      del.setAttribute('aria-label', '删除任务 ' + task.title);
      del.textContent = '✕';

      li.appendChild(check);
      li.appendChild(main);
      li.appendChild(del);
      return li;
    }

    function renderTasks(state) {
      const signature = taskSignature(state);
      const summary = tasksModule.summarize(state.tasks);

      el.progressText.textContent = summary.completed + ' / ' + summary.total;
      el.progressPct.textContent = summary.percent + '%';
      el.progressFill.style.width = summary.percent + '%';
      el.empty.hidden = !summary.isEmpty;

      if (signature !== lastSignature) {
        const sorted = tasksModule.sortForDisplay(state.tasks);
        const pending = sorted.filter((t) => !t.completed);
        const done = sorted.filter((t) => t.completed);

        el.pendingList.textContent = '';
        el.doneList.textContent = '';
        taskNodes.clear();

        for (const task of pending) {
          const node = renderTaskItem(task, state);
          el.pendingList.appendChild(node);
          taskNodes.set(task.id, node);
        }
        for (const task of done) {
          const node = renderTaskItem(task, state);
          el.doneList.appendChild(node);
          taskNodes.set(task.id, node);
        }

        el.doneLabel.hidden = done.length === 0;
        if (pending.length === 0 && done.length > 0) {
          const hint = doc.createElement('li');
          hint.className = 'task-item';
          hint.style.background = 'transparent';
          hint.dataset.placeholder = 'true';
          hint.textContent = '全部完成，今天可以收工了。';
          el.pendingList.appendChild(hint);
        }
        lastSignature = signature;
      } else {
        // 只更新时间相关字段，避免整表重建导致闪烁
        for (const task of state.tasks) {
          const node = taskNodes.get(task.id);
          if (node) node.classList.toggle('completed', task.completed);
        }
      }
    }

    /* ---------------- 专注 ---------------- */

    function renderDurationChips(container, current, actionName) {
      if (!container) return;
      container.textContent = '';
      for (const minutes of DURATIONS) {
        const chip = doc.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (minutes === current ? ' selected' : '');
        chip.textContent = minutes + ' 分';
        chip.dataset.duration = String(minutes);
        chip.dataset.durationAction = actionName;
        container.appendChild(chip);
      }
    }

    function renderFocus(state) {
      const focus = state.timers.focus;
      const remaining = timersModule.focusRemainingMs(focus, state.now);

      el.clock.textContent = util.formatClock(remaining);
      el.clock.classList.toggle('paused', focus.status === 'paused');

      const task = focus.taskId ? tasksModule.findTask(state.tasks, focus.taskId) : null;
      el.focusTask.textContent = task ? '任务：' + task.title : '未关联任务';

      if (focus.status === 'running') {
        el.focusLabel.textContent = '专注进行中，别切窗口';
        el.focusPrimary.textContent = '暂停一下';
        el.focusPrimary.disabled = false;
        el.focusSecondary.textContent = '结束这一轮';
        el.focusSecondary.disabled = false;
        el.focusStop.disabled = false;
        el.focusComplete.disabled = !task;
      } else if (focus.status === 'paused') {
        el.focusLabel.textContent = '已暂停，随时可以继续';
        el.focusPrimary.textContent = '继续专注';
        el.focusPrimary.disabled = false;
        el.focusSecondary.textContent = '放弃这一轮';
        el.focusSecondary.disabled = false;
        el.focusStop.disabled = false;
        el.focusComplete.disabled = !task;
      } else {
        el.focusLabel.textContent = '准备开始';
        el.focusPrimary.textContent = '开始专注';
        el.focusPrimary.disabled = false;
        el.focusSecondary.textContent = '暂停';
        el.focusSecondary.disabled = true;
        el.focusStop.disabled = true;
        el.focusComplete.disabled = !task;
      }

      renderDurationChips(el.durationRow, state.settings.focusDurationMinutes, 'focusDuration');
      el.breakToggle.dataset.on = state.settings.breakRemindersEnabled ? 'true' : 'false';
      el.breakValue.textContent = state.settings.breakReminderMinutes + ' 分';
      el.snoozeValue.textContent = state.settings.snoozeMinutes + ' 分';
      // 开关按钮在 disabled 时应显示为半透明
      el.breakToggle.disabled = false;

      const today = statsModule.dayStats(state.stats, state.now);
      el.statFocus.textContent = String(today.focusSessions);
      el.statDone.textContent = String(today.completed);
      el.statStreak.textContent = String(statsModule.computeStreak(state.stats, state.now));
    }

    /* ---------------- 设置 ---------------- */

    function renderSettings(state, appInfo) {
      const recallHelp=doc.getElementById('recall-help');
      if(recallHelp && appInfo && appInfo.recallShortcut===false) recallHelp.textContent='快捷键被其他程序占用；点击任务栏图标或右侧按钮找回。';
      el.lifeSwitch.dataset.on = state.settings.lifeEnabled ? 'true' : 'false';
      el.wanderSwitch.dataset.on = state.settings.wanderEnabled ? 'true' : 'false';
      el.healthSwitch.dataset.on = state.settings.healthRemindersEnabled ? 'true' : 'false';
      el.guardSwitch.dataset.on = state.settings.gameGuardEnabled ? 'true' : 'false';
      el.waterInterval.textContent = (state.settings.waterReminderMinutes || 30) + ' 分';
      el.restActive.textContent = (state.settings.breakReminderMinutes || 50) + ' 分';
      el.gameGrace.textContent = (state.settings.gameGraceMinutes || 10) + ' 分';
      el.guardEffectsSwitch.dataset.on=state.settings.guardEffectsEnabled?'true':'false';
      if (doc.activeElement !== el.guardMode) el.guardMode.value = state.settings.guardMode || 'visit';
      if (doc.activeElement !== el.entertainmentApps) el.entertainmentApps.value = state.settings.entertainmentApps || '';
      const rhythm = state.initiative || {};
      el.initiativeStatus.textContent = '连续活动 ' + Math.floor((rhythm.workMs || 0) / 60000) + ' 分钟 · 喝水计时 ' + Math.floor((rhythm.waterMs || 0) / 60000) + ' 分钟。' +
        (state.settings.gameGuardEnabled ? (rhythm.matchedApp ? '正在娱乐：' + rhythm.matchedApp : '娱乐督促已开启。') : '娱乐督促未开启。');
      el.dndSwitch.dataset.on = state.settings.doNotDisturb ? 'true' : 'false';
      el.soundSwitch.dataset.on = state.settings.soundEnabled ? 'true' : 'false';
      el.effectsSwitch.dataset.on = state.settings.effectsEnabled ? 'true' : 'false';
      el.chatterSwitch.dataset.on = state.settings.chatterEnabled ? 'true' : 'false';
      el.alwaysTopSwitch.dataset.on = state.settings.alwaysOnTop ? 'true' : 'false';
      el.launchSwitch.dataset.on = state.settings.launchAtLogin ? 'true' : 'false';
      el.launchSwitch.disabled = Boolean(appInfo && appInfo.dev);
      el.launchDesc.textContent = appInfo && appInfo.dev ? '开发模式不注册开机启动' : '登录 Windows 后自动启动';
      el.scaleValue.textContent = Math.round(state.settings.petScale * 100) + '%';
      renderDurationChips(el.settingsDurationRow, state.settings.focusDurationMinutes, 'focusDuration');
      if (appInfo && appInfo.dataDir) el.dataDir.textContent = appInfo.dataDir;
    }

    /* ---------------- 陪伴 ---------------- */

    function renderCompanion(state) {
      const today = statsModule.dayStats(state.stats, state.now);
      const summary = tasksModule.summarize(state.tasks);

      el.companionSwitch.dataset.on = state.ui.companionMode ? 'true' : 'false';
      el.cStatDone.textContent = String(today.completed);
      el.cStatFocus.textContent = String(today.focusSessions);
      el.cStatMinutes.textContent = String(today.focusMinutes);

      if (summary.isEmpty) {
        el.companionGreeting.textContent = '今天还没有任务，要不要先写一条？';
      } else if (summary.allDone) {
        el.companionGreeting.textContent = '今天的任务全部完成了，厉害。';
      } else if (state.timers.focus.status === 'running') {
        el.companionGreeting.textContent = '专注中，我在旁边不说话。';
      } else {
        el.companionGreeting.textContent = '还有 ' + summary.remaining + ' 件事，慢慢来。';
      }

      const bubble = state.ui.bubble;
      if (bubble && (bubble.kind === 'companion' || bubble.kind === 'celebration')) {
        if (bubble.text !== lastTalkText) {
          el.companionBubble.textContent = bubble.text;
          el.companionBubble.classList.remove('pop');
          void el.companionBubble.offsetWidth;
          el.companionBubble.classList.add('pop');
          lastTalkText = bubble.text;
        }
      } else if (!lastTalkText) {
        el.companionBubble.textContent = '今天感觉怎么样？';
      }
    }

    /* ---------------- 面板框架 ---------------- */

    function renderFooter(state) {
      const focusing = state.timers.focus.status !== 'idle';
      if (kind === 'tasks') {
        el.footerPrimary.textContent = focusing ? '查看专注' : '开始专注';
      } else if (kind === 'focus') {
        el.footerPrimary.textContent = focusing ? '回到任务' : '开始专注';
      } else if (kind === 'settings') {
        el.footerPrimary.textContent = '今日任务';
      } else {
        el.footerPrimary.textContent = '今日任务';
      }
    }

    function render(state, appInfo) {
      if (!kind) return;
      for (const screen of el.screens) {
        screen.hidden = screen.dataset.screen !== kind;
      }
      if (kind === 'tasks') renderTasks(state);
      if (kind === 'focus') renderFocus(state);
      if (kind === 'settings') renderSettings(state, appInfo);
      if (kind === 'companion') renderCompanion(state);
      renderFooter(state);
    }

    function mount(panelKind) {
      kind = panelKind;
      doc.getElementById('pet-view').hidden = true;
      el.view.dataset.panel = kind;
      el.view.hidden = false;
      el.title.textContent = TITLES[kind] || 'DeskBuddy';
      lastSignature = '';
      lastTalkText = '';
      if (kind === 'tasks' && el.taskInput) {
        global.setTimeout(() => el.taskInput.focus(), 60);
      }
    }

    function focusInput() {
      if (el.taskInput) el.taskInput.focus();
    }

    function getKind() {
      return kind;
    }

    function setTalk(text) {
      if (!el.companionBubble) return;
      el.companionBubble.textContent = text;
      el.companionBubble.classList.remove('pop');
      void el.companionBubble.offsetWidth;
      el.companionBubble.classList.add('pop');
      lastTalkText = text;
    }

    return {
      el,
      mount,
      render,
      showError,
      clearError,
      focusInput,
      getKind,
      setTalk,
      ERROR_TEXT
    };
  }

  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.panels = { createPanels, ERROR_TEXT };
})(typeof globalThis !== 'undefined' ? globalThis : this);
