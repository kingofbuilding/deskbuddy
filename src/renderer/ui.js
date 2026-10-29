/**
 * 视图层：把状态渲染成 DOM。不含业务判断。
 *
 * 设计要点：
 *  - 只做“状态 -> 界面”的映射，所有决定都来自 state。
 *  - 增量对比，避免每秒重建 DOM 造成输入框失焦或动画重播。
 *  - 所有用户可关闭的动效都受 settings.effectsEnabled 控制。
 */
(function (global) {
  'use strict';

  const util = global.DeskBuddy.util;
  const tasksModule = global.DeskBuddy.tasks;
  const PET_STATES = global.DeskBuddy.petState.PET_STATES;

  const SPRITE_BY_STATE = {
    idle: 'idle',
    focus: 'focus',
    reminder: 'angry',
    celebration: 'happy',
    companion: 'happy',
    do_not_disturb: 'dnd',
    effect: 'slash'
  };

  const STATE_LABEL = {
    idle: '待机',
    focus: '专注中',
    reminder: '提醒',
    celebration: '庆祝',
    companion: '陪伴',
    do_not_disturb: '免打扰',
    effect: '特效'
  };

  const SPRITE_BY_EFFECT = {
    slash: 'slash',
    crack: 'slash',
    confetti: 'happy',
    reminder: 'angry'
  };

  const NEXT_DURATIONS = [5, 10, 25, 45, 60, 90];

  function createUi(options) {
    const opts = options || {};
    const doc = opts.document || global.document;

    const el = {
      petView: doc.getElementById('pet-view'),
      pet: doc.getElementById('pet'),
      sprites: Array.prototype.slice.call(doc.querySelectorAll('.pet-sprite')),
      stateChip: doc.getElementById('state-chip'),
      focusPill: doc.getElementById('focus-pill'),
      focusPillText: doc.getElementById('focus-pill-text'),
      dndBadge: doc.getElementById('dnd-badge'),
      bubble: doc.getElementById('bubble'),
      bubbleTitle: doc.getElementById('bubble-title'),
      bubbleText: doc.getElementById('bubble-text'),
      bubbleActions: doc.getElementById('bubble-actions'),
      bubbleClose: doc.getElementById('bubble-close'),
      quickMenu: doc.getElementById('quick-menu'),
      ringProgress: doc.querySelector('.ring-progress'),
      menuTaskCount: doc.getElementById('menu-task-count'),
      menuFocusHint: doc.getElementById('menu-focus-hint'),
      dndSwitch: doc.getElementById('dnd-switch'),
      toastHost: doc.getElementById('toast-host')
    };

    let menuTimer=null,leaveTimer=null,lastPopupVisible=null;
    function syncPopupVisibility() {
      const visible=el.quickMenu.classList.contains('visible')||el.bubble.classList.contains('visible');
      const api=global.deskbuddy;
      if(visible!==lastPopupVisible&&api&&api.window&&api.window.setPopupVisible){lastPopupVisible=visible;api.window.setPopupVisible(visible);}
    }
    const prev = {
      sprite: null,
      bubbleId: null,
      bubbleActions: '',
      petState: null,
      focusText: '',
      taskSignature: '',
      scale: null,
      motion: null
    };

    /* ---------------- 宠物 ---------------- */

    function spriteFor(state) {
      if (state.pet.current === PET_STATES.REMINDER && state.ui.bubble && ['water', 'break'].includes(state.ui.bubble.kind)) return 'happy';
      if (state.pet.current === PET_STATES.EFFECT && state.pet.effect) {
        return SPRITE_BY_EFFECT[state.pet.effect] || 'slash';
      }
      return SPRITE_BY_STATE[state.pet.current] || 'idle';
    }

    function renderPet(state) {
      el.pet.dataset.living = state.settings.lifeEnabled ? 'on' : 'off';
      const spriteName = spriteFor(state);
      if (spriteName !== prev.sprite) {
        for (const sprite of el.sprites) {
          sprite.classList.toggle('active', sprite.dataset.sprite === spriteName);
        }
        prev.sprite = spriteName;
      }

      if (state.pet.current !== prev.petState) {
        el.pet.dataset.state = state.pet.current;
        el.stateChip.textContent = STATE_LABEL[state.pet.current] || state.pet.current;
        prev.petState = state.pet.current;
      }

      const focusing = state.timers.focus.status !== 'idle';
      el.petView.dataset.focusing = focusing ? 'true' : 'false';

      if (focusing) {
        const remaining = global.DeskBuddy.timers.focusRemainingMs(state.timers.focus, state.now);
        const text = util.formatClock(remaining);
        if (text !== prev.focusText) {
          el.focusPillText.textContent = text;
          prev.focusText = text;
        }
        el.focusPill.classList.add('visible');
        el.focusPill.classList.toggle('paused', state.timers.focus.status === 'paused');

        const circumference = 2 * Math.PI * 46;
        const ratio = global.DeskBuddy.timers.focusProgress(state.timers.focus, state.now);
        el.ringProgress.style.strokeDasharray = circumference.toFixed(2);
        el.ringProgress.style.strokeDashoffset = (circumference * (1 - ratio)).toFixed(2);
      } else {
        el.focusPill.classList.remove('visible');
        prev.focusText = '';
      }

      el.dndBadge.classList.toggle('visible', state.settings.doNotDisturb === true);
    }

    /* ---------------- 气泡 ---------------- */

    function renderBubble(state) {
      const bubble = state.ui.bubble;
      if (!bubble) {
        el.bubble.classList.remove('visible');
        prev.bubbleId = null;
        return;
      }

      const actionsKey = bubble.id + '|' + bubble.actions.map((a) => a.id).join(',');
      const same = prev.bubbleId === bubble.id && prev.bubbleActions === actionsKey;
      if (same) {
        el.bubble.classList.add('visible');
        return;
      }

      el.bubble.dataset.tone = bubble.tone || 'info';
      el.bubbleTitle.textContent = bubble.title || '';
      el.bubbleTitle.hidden = !bubble.title;
      el.bubbleText.textContent = bubble.text || '';

      el.bubbleActions.textContent = '';
      for (const action of bubble.actions || []) {
        const btn = doc.createElement('button');
        btn.className = 'btn';
        btn.dataset.tone = action.tone || 'default';
        btn.dataset.actionId = action.id;
        btn.textContent = action.label;
        el.bubbleActions.appendChild(btn);
      }

      // 没有按钮的纯提示气泡给一个“知道了”
      if ((!bubble.actions || bubble.actions.length === 0) && bubble.kind !== 'chatter') {
        const btn = doc.createElement('button');
        btn.className = 'btn';
        btn.dataset.tone = 'ghost';
        btn.dataset.actionId = '__dismiss';
        btn.textContent = '知道了';
        el.bubbleActions.appendChild(btn);
      }

      el.bubble.classList.add('visible');
      prev.bubbleId = bubble.id;
      prev.bubbleActions = actionsKey;
    }

    /* ---------------- 快捷菜单 ---------------- */

    function renderMenu(state) {
      const summary = tasksModule.summarize(state.tasks);
      el.menuTaskCount.textContent = summary.isEmpty ? '空' : summary.remaining + '/' + summary.total;
      el.menuFocusHint.textContent = state.settings.focusDurationMinutes + ' 分';
      el.dndSwitch.dataset.on = state.settings.doNotDisturb ? 'true' : 'false';
    }

    function showMenu(visible) {
      if(menuTimer)global.clearTimeout(menuTimer);
      if(leaveTimer)global.clearTimeout(leaveTimer);
      menuTimer=leaveTimer=null;
      el.quickMenu.classList.toggle('visible', Boolean(visible));
      if(visible)menuTimer=global.setTimeout(()=>showMenu(false),10000);
      syncPopupVisibility();
    }

    function trackMenuPointer(x,y) {
      if(!isMenuOpen())return;
      const menu=el.quickMenu.getBoundingClientRect(),pet=el.pet.getBoundingClientRect();
      const inside=r=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
      if(inside(menu)||inside(pet)){if(leaveTimer)global.clearTimeout(leaveTimer);leaveTimer=null;}
      else if(!leaveTimer)leaveTimer=global.setTimeout(()=>showMenu(false),450);
    }

    function isMenuOpen() {
      return el.quickMenu.classList.contains('visible');
    }

    /* ---------------- 全局动效开关 ---------------- */

    function renderMotion(state) {
      const on = state.settings.effectsEnabled ? 'on' : 'off';
      if (on !== prev.motion) {
        doc.body.dataset.motion = on;
        prev.motion = on;
      }
    }

    function renderScale(state) {
      if (state.settings.petScale !== prev.scale) {
        doc.documentElement.style.setProperty('--pet-scale', String(state.settings.petScale));
        prev.scale = state.settings.petScale;
      }
    }

    /* ---------------- Toast ---------------- */

    function toast(text, level, ttl) {
      if (!text) return;
      const node = doc.createElement('div');
      node.className = 'toast';
      node.dataset.level = level || 'info';
      node.textContent = text;
      el.toastHost.appendChild(node);
      const life = util.isFiniteNumber(ttl) ? ttl : level === 'error' ? 5200 : 2600;
      global.setTimeout(() => {
        node.classList.add('leaving');
        global.setTimeout(() => node.remove(), 220);
      }, life);
    }

    /* ---------------- 宠物窗口总渲染 ---------------- */

    function renderPetWindow(state) {
      renderPet(state);
      renderBubble(state);
      renderMenu(state);
      renderMotion(state);
      renderScale(state);
      syncPopupVisibility();
    }

    return {
      el,
      renderPet,
      renderBubble,
      renderMenu,
      renderPetWindow,
      showMenu,
      isMenuOpen,
      trackMenuPointer,
      toast,
      NEXT_DURATIONS,
      spriteFor
    };
  }

  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.ui = { createUi, NEXT_DURATIONS, STATE_LABEL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
