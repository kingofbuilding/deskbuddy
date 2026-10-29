/**
 * 渲染进程入口（宠物窗口 + 面板窗口共用）。
 *
 * 架构：
 *  宠物窗口是唯一的状态持有者，负责 tick、落盘、特效、音效。
 *  面板窗口通过 IPC 把用户操作转给宠物窗口，拿到状态快照后再渲染。
 *
 * 这样保证“同一时刻只有一个地方在推进计时”，从根上避免多个计时器互相打架。
 */
(function (global) {
  'use strict';

  const bridge = global.deskbuddy;
  const core = global.DeskBuddy;
  const util = core.util;

  const TICK_INTERVAL = 500;
  const CHATTER_MIN_GAP = 4 * 60 * 1000;

  const query = new URLSearchParams(global.location.search);
  const PANEL_KIND = query.get('panel');
  const IS_PANEL = Boolean(PANEL_KIND);

  /* ------------------------------------------------------------------ *
   * 共享工具
   * ------------------------------------------------------------------ */

  function safeBridge() {
    if (!bridge) {
      throw new Error('preload 未加载：请通过 npm start 启动');
    }
    return bridge;
  }

  /** 只把需要的字段传出去，避免把内部结构泄漏到别的窗口 */
  function toSnapshot(state) {
    return {
      at: Date.now(),
      tasks: state.tasks,
      stats: state.stats,
      settings: state.settings,
      timers: state.timers,
      initiative: state.initiative,
      pet: { current: state.pet.current, effect: state.pet.effect || null, since: state.pet.since },
      ui: {
        bubble: state.ui.bubble,
        companionMode: state.ui.companionMode,
        focusTaskId: state.ui.focusTaskId,
        recovered: state.ui.recovered
      }
    };
  }

  function fromSnapshot(snapshot, now) {
    const base = core.appState.createInitialState({ now: now || Date.now() });
    if (!snapshot) return base;
    return {
      now: now || Date.now(),
      tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : base.tasks,
      stats: snapshot.stats || base.stats,
      settings: snapshot.settings || base.settings,
      timers: snapshot.timers || base.timers,
      initiative: snapshot.initiative || base.initiative,
      pet: Object.assign({}, base.pet, snapshot.pet || {}),
      queue: base.queue,
      ui: Object.assign({}, base.ui, snapshot.ui || {})
    };
  }

  /* ================================================================== *
   * 宠物窗口
   * ================================================================== */

  function startPetWindow() {
    const api = safeBridge();
    const doc = global.document;

    const ui = core.ui.createUi({ document: doc });
    const effects = core.effects.createEffects({ document: doc });
    const audio = core.audio.createAudio({ enabled: true });

    let state = core.appState.createInitialState({ now: Date.now() });
    let appInfo = null;
    let tickTimer = null;
    let chatterTimer = null;
    let disposeMessage = null;
    let booted = false;
    let dragging = false;
    let pendingSave = { tasks: false, settings: false, session: false };
    let saveTimer = null;
    let lastSessionSave = 0;
    let lastChatterCheck = 0;
    const life = core.petLife ? core.petLife.create({
      pet: ui.el.pet, frame: doc.getElementById('pet-life-frame'),
      getContext: () => ({ settings: state.settings, petState: state.pet.current, bubble: state.ui.bubble, dragging, menuOpen: ui.isMenuOpen(),
        initiative:state.initiative,focusRunning:state.timers.focus.status==='running',pendingCount:state.tasks.filter(t=>!t.completed).length }),
      onWander: () => { if (api.window.visit) api.window.visit('wander').catch(() => {}); }
    }) : null;
    const performance = core.petPerformance ? core.petPerformance.create({ pet: ui.el.pet, onAnchor: (frame) => {
      if (api.actorAnchor) api.actorAnchor(frame);
    } }) : null;
    const input = core.petInput && api.window.setInteractive ? core.petInput.create({
      document: doc, pet: ui.el.pet, stage: ui.el.petView, setInteractive: api.window.setInteractive
    }) : null;

    /* ---------------- 落盘 ---------------- */

    function sessionPayload() {
      return {
        timers: core.timers.serialize(state.timers),
        initiative: {
          waterMs: state.initiative.waterMs,
          waterUntil: state.initiative.waterUntil,
          restUntil: state.initiative.restUntil,
          guardUntil: state.initiative.guardUntil,
          lastReminderAt: state.initiative.lastReminderAt,
          guardEffectCount: state.initiative.guardEffectCount
        },
        focusTaskId: state.ui.focusTaskId,
        savedAt: Date.now()
      };
    }

    function flushSaves() {
      if (!pendingSave.tasks && !pendingSave.settings && !pendingSave.session) return;
      const tasksDue = pendingSave.tasks;
      const settingsDue = pendingSave.settings;
      const sessionDue = pendingSave.session;
      pendingSave = { tasks: false, settings: false, session: false };

      if (tasksDue) {
        api.saveTasks(state.tasks).then(handleSaveResult('任务')).catch(handleSaveFailure('任务'));
      }
      if (settingsDue) {
        api.saveSettings(state.settings).then(handleSaveResult('设置')).catch(handleSaveFailure('设置'));
      }
      if (sessionDue) {
        api.saveSession(sessionPayload()).then(handleSaveResult('计时')).catch(handleSaveFailure('计时'));
      }
    }

    function scheduleSave(scope) {
      for (const name of scope) pendingSave[name] = true;
      if (saveTimer) return;
      saveTimer = global.setTimeout(() => {
        saveTimer = null;
        flushSaves();
      }, 260);
    }

    function handleSaveResult(label) {
      return (result) => {
        if (result && result.ok === false) {
          ui.toast(label + '保存失败：' + (result.error || '未知错误'), 'error', 6000);
          // 重新安排一次，避免瞬时失败后数据永久丢失
          global.setTimeout(() => {
            if (label === '任务') scheduleSave(['tasks']);
            if (label === '设置') scheduleSave(['settings']);
            if (label === '计时') scheduleSave(['session']);
          }, 4000);
        }
      };
    }

    function handleSaveFailure(label) {
      return (error) => {
        ui.toast(label + '保存失败：' + ((error && error.message) || error), 'error', 6000);
      };
    }

    /* ---------------- 副作用 ---------------- */

    function playSound(cue) {
      if (!state.settings.soundEnabled) return;
      audio.play(cue);
    }

    function runEffect(name, holder) {
      if (!state.settings.effectsEnabled) {
        // 用户关闭了特效：直接把状态放回去，避免卡在 effect
        dispatch({ type: 'effect/end', holder });
        return;
      }
      ui.renderPetWindow(state);
      if (life) life.setWalking(false);
      const frame = performance ? performance.play(name, core.effects.DURATIONS[name], holder) : undefined;
      // 本体负责动作；全屏层只负责跟随它的道具和环境反馈。
      const meta = {
        holder,
        visual: !api.fullscreenFx,
        onEnd: () => {
          if (performance) performance.stop();
          dispatch({ type: 'effect/end', holder });
        }
      };
      const result = effects.play(name, meta);
      if (api.fullscreenFx) {
        const fallback = () => {
          if (effects.active === name && (!holder || state.pet.holder === holder)) {
            effects.play(name, Object.assign({}, meta, { visual: true }));
          }
        };
        api.fullscreenFx(name, holder, undefined, frame).then((reply) => {
          if (!reply || reply.ok === false) fallback();
        }).catch(fallback);
      }
      if (!result.ok && result.reason === 'no_dom') {
        ui.toast('特效层不可用', 'warn');
      }
    }

    function applyEffects(list) {
      if (!Array.isArray(list)) return;
      for (const effect of list) {
        if (!effect || typeof effect.type !== 'string') continue;
        switch (effect.type) {
          case 'sound':
            playSound(effect.cue);
            break;
          case 'effect':
            runEffect(effect.name, effect.holder);
            break;
          case 'reminder-effect':
            ui.renderPetWindow(state);
            if (performance) performance.play('reminder', 2800, effect.holder);
            if (api.window.visit) api.broadcastState(toSnapshot(state)).then(() => api.window.visit('water')).catch(() => {});
            if (state.settings.effectsEnabled && !state.settings.doNotDisturb && api.fullscreenFx) {
              api.fullscreenFx('reminder', effect.holder, effect.kind, performance ? { name: 'reminder', holder: effect.holder, startedAt: Date.now(), anchor: performance.measure() } : undefined).catch(() => {});
            }
            break;
          case 'effect-end':
            effects.stop();
            if (performance) performance.stop();
            break;
          case 'persist-tasks':
            scheduleSave(['tasks']);
            break;
          case 'persist-settings':
            scheduleSave(['settings']);
            break;
          case 'persist-timers':
          case 'persist-stats':
            scheduleSave(['session']);
            break;
          case 'pet-visit':
            if (api.window.visit) {
              api.broadcastState(toSnapshot(state)).then(() => api.window.visit(effect.kind,effect.holder)).catch(() => {});
            }
            break;
          case 'pet-return':
            if (api.window.returnHome) api.window.returnHome().catch(() => {});
            break;
          case 'entertainment-minimize':
          case 'entertainment-close':
            if (api.entertainmentAction) api.entertainmentAction(effect.type === 'entertainment-close' ? 'close' : 'minimize').then((reply) => {
              if (reply && !reply.ok && !reply.cancelled) ui.toast(reply.error || '窗口操作未完成，鱼鱼还在这里。', 'warn');
              else if (reply && reply.ok) {
                ui.toast(effect.type === 'entertainment-close' ? '已发送正常关闭请求' : '娱乐窗口已暂时收起，可从任务栏恢复', 'ok');
                if (state.ui.bubble && state.ui.bubble.id === effect.holder) dispatch({ type: 'bubble/dismiss', id: effect.holder });
              }
            }).catch(() => ui.toast('这个窗口暂时无法操作', 'warn'));
            break;
          case 'open-tasks':
            api.window.openPanel('tasks').catch(() => {});
            break;
          case 'pet-wave':
            if (life) life.wave();
            break;
          default:
            break;
        }
      }
    }

    /* ---------------- 状态分发 ---------------- */

    function afterStateChange(previous, result) {
      ui.renderPetWindow(state);
      if (life) life.sync();
      broadcast();
    }

    let broadcastTimer = null;
    function broadcast() {
      if (broadcastTimer) return;
      broadcastTimer = global.setTimeout(() => {
        broadcastTimer = null;
        api.broadcastState(toSnapshot(state)).catch(() => {});
      }, 60);
    }

    function dispatch(action) {
      const previous = state;
      let result;
      try {
        result = core.appState.reduce(state, action);
      } catch (error) {
        ui.toast('操作失败：' + ((error && error.message) || error), 'error');
        return { ok: false, error: 'exception' };
      }
      state = result.state;
      applyEffects(result.effects);
      afterStateChange(previous, result);
      scheduleBubbleDismiss();
      return { ok: result.ok !== false, error: result.error };
    }

    /* ---------------- 计时 ---------------- */

    function tick() {
      const now = Date.now();
      // 只推进“时间”，不改变其它逻辑
      const result = core.appState.reduce(state, { type: 'tick', now });
      state = result.state;
      applyEffects(result.effects);
      ui.renderPetWindow(state);
      if (life) life.sync();
      scheduleBubbleDismiss();

      // 庆祝状态自动回到常态（不依赖 CSS 动画结束事件）
      if (state.pet.current === 'celebration') {
        const age = now - state.pet.since;
        const bubbleAge = state.ui.bubble ? now - state.ui.bubble.shownAt : Infinity;
        if (age > 5200 && bubbleAge > 5200) {
          dispatch({ type: 'pet/release' });
        }
      }

      maybeChatter(now);
      broadcast();
    }

    /** 定时闲聊：只在用户长时间空闲时偶尔说一句 */
    function maybeChatter(now) {
      if (!state.settings.chatterEnabled) return;
      if (state.settings.doNotDisturb) return;
      if (state.pet.current !== 'idle' && state.pet.current !== 'companion') return;
      if (state.ui.bubble) return;
      if (now - lastChatterCheck < 45 * 1000) return;
      lastChatterCheck = now;
      if (state.ui.lastChatterAt && now - state.ui.lastChatterAt < CHATTER_MIN_GAP) return;

      dispatch({ type: 'chatter', seed: now });
    }

    function startTicking() {
      if (tickTimer) return;
      tickTimer = global.setInterval(tick, TICK_INTERVAL);
    }

    function stopTicking() {
      if (tickTimer) {
        global.clearInterval(tickTimer);
        tickTimer = null;
      }
      if (chatterTimer) {
        global.clearTimeout(chatterTimer);
        chatterTimer = null;
      }
    }

    /* ---------------- 气泡自动消失 ---------------- */

    let bubbleDismissTimer = null;
    let lastBubbleId = null;

    function scheduleBubbleDismiss() {
      const bubble = state.ui.bubble;
      if (!bubble || !bubble.autoDismissMs) {
        if (bubbleDismissTimer) {
          global.clearTimeout(bubbleDismissTimer);
          bubbleDismissTimer = null;
        }
        lastBubbleId = null;
        return;
      }
      if (bubble.id === lastBubbleId) return;
      lastBubbleId = bubble.id;
      if (bubbleDismissTimer) global.clearTimeout(bubbleDismissTimer);
      bubbleDismissTimer = global.setTimeout(() => {
        bubbleDismissTimer = null;
        if (state.ui.bubble && state.ui.bubble.id === bubble.id) {
          dispatch({ type: 'bubble/dismiss', id: bubble.id });
        }
      }, bubble.autoDismissMs);
    }

    /* ---------------- 菜单 ---------------- */

    function menuAction(action) {
      ui.showMenu(false);
      audio.unlock();

      switch (action) {
        case 'open-tasks':
          api.window.openPanel('tasks');
          break;
        case 'open-settings':
          api.window.openPanel('settings');
          break;
        case 'open-companion':
          api.window.openPanel('companion');
          break;
        case 'start-focus':
          dispatch({
            type: state.timers.focus.status === 'paused' ? 'focus/resume' : 'focus/start',
            minutes: state.settings.focusDurationMinutes
          });
          api.window.openPanel('focus');
          break;
        case 'effect-slash':
          dispatch({ type: 'effect/play', name: 'slash', manual: true });
          break;
        case 'effect-crack':
          dispatch({ type: 'effect/play', name: 'crack', manual: true });
          break;
        case 'effect-reminder':
          dispatch({ type: 'effect/play', name: 'reminder', manual: true });
          break;
        case 'toggle-dnd':
          dispatch({ type: 'settings/update', patch: { doNotDisturb: !state.settings.doNotDisturb } });
          if (!state.settings.doNotDisturb) {
            ui.toast('免打扰已开启，普通提醒与音效暂停', 'ok');
          } else {
            ui.toast('免打扰已关闭', 'ok');
          }
          break;
        case 'hide-pet':
          api.window.hidePet();
          break;
        case 'quit':
          api.window.quit();
          break;
        default:
          break;
      }
    }

    /* ---------------- 拖拽 ---------------- */

    function setupDrag() {
      const pet = ui.el.pet;
      let startX = 0;
      let startY = 0;
      let draggingNow = false;
      let moved = false;
      let lastSent = 0;

      pet.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        draggingNow = true;
        moved = false;
        startX = event.screenX;
        startY = event.screenY;
        lastSent = 0;
        try {
          if (pet.setPointerCapture) pet.setPointerCapture(event.pointerId);
        } catch (_) {
          /* 部分环境不支持指针捕获，忽略即可 */
        }
        api.window.beginDrag().catch(() => {});
      });

      pet.addEventListener('pointermove', (event) => {
        if (!draggingNow) return;
        const dx = event.screenX - startX;
        const dy = event.screenY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        dragging = true;
        const now = global.performance.now();
        if (now - lastSent < 16) return;
        lastSent = now;
        api.window.dragTo(dx, dy).catch(() => {});
      });

      function endDrag(event) {
        if (!draggingNow) return;
        draggingNow = false;
        dragging = false;
        if (event && pet.hasPointerCapture && pet.hasPointerCapture(event.pointerId)) {
          pet.releasePointerCapture(event.pointerId);
        }
        api.window.endDrag().catch(() => {});
      }

      pet.addEventListener('pointerup', (event) => {
        const wasDrag = moved;
        endDrag(event);
        if (wasDrag) return;
        // 单击：切换快捷菜单
        ui.showMenu(!ui.isMenuOpen());
      });

      pet.addEventListener('pointercancel', endDrag);
      pet.addEventListener('lostpointercapture', endDrag);
      global.addEventListener('blur', endDrag);
      global.addEventListener('blur', () => ui.showMenu(false));
      doc.addEventListener('mousemove', event=>ui.trackMenuPointer(event.clientX,event.clientY));

      pet.addEventListener('dblclick', () => {
        audio.unlock();
        api.window.openPanel('tasks');
      });

      pet.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        audio.unlock();
        api.window.openPanel('settings');
      });

      pet.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          audio.unlock();
          ui.showMenu(!ui.isMenuOpen());
        }
        if (event.key === 'Escape') ui.showMenu(false);
      });

      doc.addEventListener('pointerdown', (event) => {
        if (!ui.isMenuOpen()) return;
        if (event.target.closest('#quick-menu') || event.target.closest('#pet')) return;
        ui.showMenu(false);
      });
    }

    /* ---------------- 事件绑定 ---------------- */

    function setupEvents() {
      ui.el.bubbleActions.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action-id]');
        if (!btn) return;
        audio.unlock();
        const actionId = btn.dataset.actionId;
        if (actionId === '__dismiss') {
          dispatch({ type: 'bubble/dismiss', id: state.ui.bubble ? state.ui.bubble.id : null });
          return;
        }
        dispatch({ type: 'reminder/action', actionId });
      });

      ui.el.bubbleClose.addEventListener('click', () => {
        dispatch({ type: 'bubble/dismiss', id: state.ui.bubble ? state.ui.bubble.id : null });
      });

      ui.el.quickMenu.addEventListener('click', (event) => {
        const item = event.target.closest('button[data-action]');
        if (!item) return;
        menuAction(item.dataset.action);
      });

      // 用户第一次交互解锁音频
      doc.addEventListener('pointerdown', () => audio.unlock(), { once: true });

      // 拖拽
      setupDrag();

      // 主进程推送
      disposeMessage = api.onMainMessage((message) => {
        if (message.channel === 'pet:pointer' && input && message.payload) {
          input.update({ clientX: message.payload.x, clientY: message.payload.y });
          ui.trackMenuPointer(message.payload.x,message.payload.y);
          return;
        }
        if (message.channel === 'app:action' && message.payload) {
          dispatch(message.payload);
          return;
        }
        if (message.channel === 'pet:state' && message.payload) {
          if(message.payload.closeMenu)ui.showMenu(false);
          if (message.payload.recoveredPet) {
            effects.stop(); if (performance) performance.stop(); if (life) life.setWalking(false);
            dispatch({ type: 'effect/end' });
          }
          if (message.payload.motion && life) life.setWalking(message.payload.motion.walking);
          if(message.payload.motion&&message.payload.motion.arrived&&message.payload.motion.kind==='task_nudge')dispatch({type:'guard/perform',holder:message.payload.motion.holder});
          if (message.payload.recoveredIssues) {
            ui.toast('部分数据异常，已恢复默认值', 'warn', 5000);
          }
          if (message.payload.panelClosed) {
            global.setTimeout(() => api.window.getPosition(), 0);
          }
        }
      });

      global.addEventListener('beforeunload', () => {
        stopTicking();
        effects.dispose();
        if (performance) performance.dispose();
        if (input) input.dispose();
        if (life) life.dispose();
        audio.dispose();
        if (disposeMessage) disposeMessage();
        flushSaves();
      });

      global.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          ui.showMenu(false);
          if (api.window.returnHome) api.window.returnHome().catch(() => {});
          if (state.ui.bubble && ['water', 'task_nudge'].includes(state.ui.bubble.kind)) dispatch({ type: 'bubble/dismiss' });
        }
      });
    }

    /* ---------------- 启动 ---------------- */

    async function boot() {
      try {
        appInfo = await api.getInfo();
      } catch (error) {
        appInfo = null;
      }

      let loaded = null;
      try {
        loaded = await api.loadState();
      } catch (error) {
        ui.toast('读取本地数据失败，已使用默认设置', 'error', 6000);
        loaded = null;
      }

      if (loaded && loaded.ok) {
        const hydrated = core.appState.hydrate(
          { settings: loaded.settings, tasks: loaded.tasks, session: loaded.session },
          Date.now()
        );
        state = hydrated.state;
        if (hydrated.issues.length > 0) {
          ui.toast('检测到数据异常，已自动修复 ' + hydrated.issues.length + ' 项', 'warn', 5000);
        }
      } else {
        ui.toast('读取本地数据失败，当前为默认设置', 'warn', 5000);
      }

      audio.setEnabled(state.settings.soundEnabled !== false);
      ui.renderPetWindow(state);
      scheduleBubbleDismiss();

      if (state.timers.focus.status !== 'idle') {
        ui.toast('已恢复上次的专注计时', 'ok');
      }

      setupEvents();
      if (life) {
        life.start();
        ui.el.pet.addEventListener('pointerenter', () => life.wave());
      }
      startTicking();

      // 空闲时的第一句招呼
      if (!state.ui.bubble && state.settings.chatterEnabled && !state.settings.doNotDisturb) {
        global.setTimeout(() => {
          if (!dragging) dispatch({ type: 'chatter', pool: 'greet', seed: Date.now() });
        }, 1800);
      }

      doc.documentElement.setAttribute('data-ready', 'true');
      booted = true;

      // 自检钩子：供 npm run smoke 读取
      global.__deskbuddySelfTest = () => ({
        ready: booted,
        petState: state.pet.current,
        tasks: state.tasks.length,
        focus: state.timers.focus.status,
        settingsLoaded: Boolean(state.settings),
        sprites: ui.el.sprites.length,
        effectsLayer: Boolean(global.document.getElementById('effects'))
      });

      // 供应用内自检读取精简状态
      global.__deskbuddySnapshot = () => ({
        pet: state.pet.current,
        effect: state.pet.effect || null,
        tasks: state.tasks.length,
        completed: core.tasks.summarize(state.tasks).completed,
        focus: state.timers.focus.status,
        doNotDisturb: state.settings.doNotDisturb,
        bubble: state.ui.bubble ? state.ui.bubble.kind : null
      });

      // 面板打开时随时能拿到状态
      global.__deskbuddyDispatch = dispatch;
      global.__deskbuddyLifePreview = (name) => { if (life) life.preview(name); };
      global.__deskbuddyActorAnchor = () => performance ? performance.measure() : null;
      global.__deskbuddyPointerHit = (x, y) => input ? input.hit(x, y) : null;
    }

    boot().catch((error) => {
      doc.documentElement.setAttribute('data-ready', 'error');
      ui.toast('启动失败：' + ((error && error.message) || error), 'error', 8000);
      if (global.console) global.console.error('[DeskBuddy] 启动失败', error);
    });
  }

  /* ================================================================== *
   * 面板窗口
   * ================================================================== */

  function startPanelWindow(kind) {
    const api = safeBridge();
    const doc = global.document;
    const panels = core.panels.createPanels({ document: doc });
    const ui = core.ui.createUi({ document: doc });

    let snapshot = null;
    let appInfo = null;
    let state = null;
    let panelTimer = null;
    let lastPetPosition = null;
    let runTimer = null;

    function dispatch(action) {
      api.dispatch(action).catch((error) => {
        ui.toast('操作失败：' + ((error && error.message) || error), 'error');
      });
    }

    function applySnapshot(next) {
      if (!next) return;
      snapshot = next;
      state = fromSnapshot(next, Date.now());
      state.now = Date.now();
      panels.render(state, appInfo);
    }

    async function boot() {
      panels.mount(kind);
      doc.body.dataset.panelKind = kind;

      try {
        appInfo = await api.getInfo();
      } catch (_) {
        appInfo = null;
      }

      // 先取主进程缓存，再尝试从宠物窗口实时拉取
      try {
        const cached = await api.getSnapshot();
        if (cached && cached.ok && cached.snapshot) applySnapshot(cached.snapshot);
      } catch (_) {
        /* 忽略：下面会用 IPC 动作拿最新状态 */
      }

      if (!snapshot) {
        // 主进程还没有快照时，退回直接读盘
        try {
          const loaded = await api.loadState();
          if (loaded && loaded.ok) {
            const hydrated = core.appState.hydrate(
              { settings: loaded.settings, tasks: loaded.tasks, session: loaded.session },
              Date.now()
            );
            state = hydrated.state;
            panels.render(state, appInfo);
          }
        } catch (_) {
          panels.render(core.appState.createInitialState({ now: Date.now() }), appInfo);
        }
      }

      setupEvents();

      // 面板每 500ms 按本地时间刷新倒计时显示
      panelTimer = global.setInterval(() => {
        if (!state) return;
        state.now = Date.now();
        panels.render(state, appInfo);
      }, 500);

      api.onMainMessage((message) => {
        if (message.channel === 'app:snapshot') applySnapshot(message.payload);
      });

      global.addEventListener('beforeunload', () => {
        if (panelTimer) global.clearInterval(panelTimer);
        if (runTimer) global.clearTimeout(runTimer);
      });

      doc.documentElement.setAttribute('data-ready', 'true');
    }

    /* ---------------- 交互 ---------------- */

    function closestWith(node, attribute) {
      let cursor = node;
      while (cursor && cursor !== doc) {
        if (cursor.dataset && cursor.dataset[attribute] !== undefined) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    }

    function setupEvents() {
      // 关闭
      const close = () => {
        api.window.closePanel(kind).catch(() => {});
      };
      panels.el.close.addEventListener('click', close);

      // 任务表单
      panels.el.taskForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = panels.el.taskInput.value;
        panels.clearError();
        if (!value || !value.trim()) {
          panels.showError(panels.ERROR_TEXT.empty);
          return;
        }
        dispatch({ type: 'tasks/add', title: value });
        panels.el.taskInput.value = '';
      });

      panels.el.taskInput.addEventListener('input', () => panels.clearError());

      // 任务勾选 / 删除
      panels.el.body.addEventListener('click', (event) => {
        const toggle = closestWith(event.target, 'taskToggle');
        if (toggle) {
          dispatch({ type: 'tasks/toggle', id: toggle.dataset.taskToggle });
          return;
        }
        const remove = closestWith(event.target, 'taskRemove');
        if (remove) {
          const node = remove.closest('.task-item');
          if (node) node.classList.add('removing');
          global.setTimeout(() => dispatch({ type: 'tasks/remove', id: remove.dataset.taskRemove }), 160);
          return;
        }

        const chip = closestWith(event.target, 'duration');
        if (chip) {
          const minutes = Number(chip.dataset.duration);
          dispatch({ type: 'settings/update', patch: { focusDurationMinutes: minutes } });
          return;
        }

        const step = closestWith(event.target, 'step');
        if (step) {
          handleStep(step.dataset.target, Number(step.dataset.step));
          return;
        }

        const effectBtn = event.target.closest('button[data-effect]');
        if (effectBtn) {
          dispatch({ type: 'effect/play', name: effectBtn.dataset.effect, manual: true });
          return;
        }

        const talkBtn = event.target.closest('button[data-talk]');
        if (talkBtn) {
          handleTalk(talkBtn.dataset.talk);
        }
      });

      // 专注按钮
      panels.el.focusPrimary.addEventListener('click', () => {
        if (!state) return;
        if (state.timers.focus.status === 'paused') {
          dispatch({ type: 'focus/resume' });
        } else if (state.timers.focus.status === 'running') {
          dispatch({ type: 'focus/pause' });
        } else {
          const taskId = state.ui.focusTaskId || null;
          dispatch({ type: 'focus/start', minutes: state.settings.focusDurationMinutes, taskId });
        }
      });
      panels.el.focusSecondary.addEventListener('click', () => {
        if (!state) return;
        if (state.timers.focus.status === 'running') {
          dispatch({ type: 'focus/pause' });
        } else if (state.timers.focus.status === 'paused') {
          dispatch({ type: 'focus/stop' });
        }
      });

      panels.el.focusStop.addEventListener('click', () => dispatch({ type: 'focus/stop' }));

      panels.el.focusComplete.addEventListener('click', () => {
        if (!state) return;
        const taskId = state.timers.focus.taskId || state.ui.focusTaskId;
        if (!taskId) {
          ui.toast('当前专注没有关联任务', 'warn');
          return;
        }
        dispatch({ type: 'tasks/toggle', id: taskId, completed: true });
      });

      // 开关
      const bindSwitch = (node, key, after) => {
        if (!node) return;
        node.addEventListener('click', () => {
          if (!state) return;
          if (node.disabled) return;
          const nextValue = !state.settings[key];
          dispatch({ type: 'settings/update', patch: { [key]: nextValue } });
          if (after) after(nextValue);
        });
      };

      bindSwitch(panels.el.breakToggle, 'breakRemindersEnabled');
      bindSwitch(panels.el.dndSwitch, 'doNotDisturb', (on) => {
        if (on) ui.toast('免打扰已开启', 'ok');
      });
      bindSwitch(panels.el.soundSwitch, 'soundEnabled');
      bindSwitch(panels.el.effectsSwitch, 'effectsEnabled');
      bindSwitch(panels.el.chatterSwitch, 'chatterEnabled');
      bindSwitch(panels.el.alwaysTopSwitch, 'alwaysOnTop', (on) => {
        api.window.setAlwaysOnTop(on).catch(() => {});
      });
      bindSwitch(panels.el.launchSwitch, 'launchAtLogin');
      bindSwitch(panels.el.lifeSwitch, 'lifeEnabled');
      bindSwitch(panels.el.wanderSwitch, 'wanderEnabled');
      bindSwitch(panels.el.healthSwitch, 'healthRemindersEnabled');
      bindSwitch(panels.el.guardSwitch, 'gameGuardEnabled');
      bindSwitch(panels.el.guardEffectsSwitch, 'guardEffectsEnabled');
      panels.el.guardMode.addEventListener('change', () => dispatch({ type: 'settings/update', patch: { guardMode: panels.el.guardMode.value } }));
      panels.el.saveEntertainmentApps.addEventListener('click', () => {
        dispatch({ type: 'settings/update', patch: { entertainmentApps: panels.el.entertainmentApps.value } });
        ui.toast('娱乐应用列表已保存', 'ok');
      });
      doc.querySelectorAll('[data-add-app]').forEach((button) => button.addEventListener('click', () => {
        const apps = panels.el.entertainmentApps.value.trim();
        dispatch({ type: 'settings/update', patch: { entertainmentApps: apps + '\n' + button.dataset.addApp } });
      }));
      doc.querySelectorAll('[data-initiative]').forEach((button) => button.addEventListener('click', () => dispatch({ type: 'initiative/demo', kind: button.dataset.initiative })));
      doc.querySelectorAll('[data-life]').forEach((button) => button.addEventListener('click', () => dispatch({ type: 'pet/wave' })));

      panels.el.companionSwitch.addEventListener('click', () => {
        if (!state) return;
        dispatch({ type: 'settings/update', patch: { companionMode: !state.ui.companionMode } });
      });

      panels.el.openDataFolder.addEventListener('click', () => {
        api.openDataFolder().catch(() => {});
      });
      panels.el.recoverPet.addEventListener('click', () => { if (api.window.recover) api.window.recover().catch(() => {}); });

      // 页脚
      panels.el.footerPrimary.addEventListener('click', () => {
        if (!state) return;
        if (kind === 'tasks') {
          if (state.timers.focus.status === 'idle') {
            dispatch({ type: 'focus/start', minutes: state.settings.focusDurationMinutes });
            api.window.openPanel('focus').catch(() => {});
          } else {
            api.window.openPanel('focus').catch(() => {});
          }
        } else if (kind === 'focus') {
          if (state.timers.focus.status === 'idle') {
            dispatch({ type: 'focus/start', minutes: state.settings.focusDurationMinutes });
          } else {
            api.window.openPanel('tasks').catch(() => {});
          }
        } else {
          api.window.openPanel('tasks').catch(() => {});
        }
      });

      panels.el.footerSecondary.addEventListener('click', close);

      doc.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          panels.el.taskForm.dispatchEvent(new global.Event('submit'));
        }
      });
    }

    function handleStep(target, delta) {
      if (!state) return;
      const patch = {};
      if (target === 'breakReminderMinutes') {
        patch.breakReminderMinutes = Math.min(240, Math.max(5, state.settings.breakReminderMinutes + delta));
      } else if (target === 'snoozeMinutes') {
        patch.snoozeMinutes = Math.min(120, Math.max(1, state.settings.snoozeMinutes + delta));
      } else if (target === 'waterReminderMinutes' || target === 'gameGraceMinutes') {
        const limits = core.settings.LIMITS[target];
        patch[target] = Math.min(limits.max, Math.max(limits.min, state.settings[target] + delta));
      } else if (target === 'petScale') {
        const current = Math.round(state.settings.petScale * 100);
        const next = Math.min(160, Math.max(75, current + delta));
        patch.petScale = next / 100;
        api.window.setScale(next / 100).catch(() => {});
      } else {
        return;
      }
      dispatch({ type: 'settings/update', patch });
    }

    function handleTalk(mode) {
      const seed = Date.now();
      dispatch({ type: 'companion/talk', mode, seed });
      panels.el.companionBubble.textContent = '……';
      if (runTimer) global.clearTimeout(runTimer);
      runTimer = global.setTimeout(() => {
        const bubble = state && state.ui.bubble;
        if (bubble) panels.setTalk(bubble.text);
      }, 220);
    }

    boot().catch((error) => {
      doc.documentElement.setAttribute('data-ready', 'error');
      ui.toast('面板加载失败：' + ((error && error.message) || error), 'error', 8000);
      if (global.console) global.console.error('[DeskBuddy] 面板加载失败', error);
    });
  }

  /* ------------------------------------------------------------------ *
   * 入口
   * ------------------------------------------------------------------ */

  if (IS_PANEL) {
    startPanelWindow(PANEL_KIND);
  } else {
    startPetWindow();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
