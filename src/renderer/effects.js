/**
 * 特效控制器：砍刀 / 裂屏 / 撒花。
 *
 * 约束（需求 7.3、10.4）：
 *  - 只在 DeskBuddy 自己的窗口区域内绘制，不覆盖系统界面、不伪造系统崩溃。
 *  - 同时只有一个特效在播放，上一段会被安全清理。
 *  - 动画结束后自动清理 DOM 与定时器；窗口关闭时全部取消。
 */
(function (global) {
  'use strict';

  const DURATIONS = {
    slash: 3800,
    crack: 4200,
    confetti: 3000,
    reminder: 2800
  };

  function createEffects(options) {
    const opts = options || {};
    const doc = opts.document || global.document;
    const root = doc.getElementById('effects');
    const slashEl = doc.getElementById('slash-fx');
    const crackEl = doc.getElementById('crack-fx');
    const confettiEl = doc.getElementById('confetti-fx');
    const speedlines = root ? root.querySelector('.fx-speedlines') : null;

    let activeTimer = null;
    let activeName = null;
    let activeHolder = null;
    let onEnd = null;
    let disposed = false;

    function clearTimer() {
      if (activeTimer !== null) {
        global.clearTimeout(activeTimer);
        activeTimer = null;
      }
    }

    function resetAll() {
      clearTimer();
      activeName = null;
      activeHolder = null;
      if (slashEl) slashEl.classList.remove('active');
      if (crackEl) crackEl.classList.remove('active');
      if (confettiEl) {
        confettiEl.classList.remove('active');
        // 只清碎片，保留爆发光和文字节点
        const pieces = confettiEl.querySelectorAll('.confetti-piece');
        for (const piece of pieces) piece.remove();
      }
      if (speedlines) speedlines.classList.remove('active');
      if (root) root.dataset.active = '';
    }

    /** 撒花：大肥鱼版，一次性泼出 40 片 */
    function spawnConfetti(count) {
      if (!confettiEl) return;
      const colors = [
        '#ffd166', '#ff7ad9', '#5ff0e0', '#9d86ff',
        '#52e5a0', '#ffffff', '#ff9ad5', '#ffe066'
      ];
      const total = Math.max(12, Math.min(48, count || 40));
      const fragments = doc.createDocumentFragment();
      for (let i = 0; i < total; i += 1) {
        const piece = doc.createElement('i');
        piece.className = 'confetti-piece';
        const angle = (Math.PI * 2 * i) / total + Math.random() * 0.5;
        const distance = 80 + Math.random() * 110;
        const dx = Math.cos(angle) * distance;
        const dy = Math.sin(angle) * distance - 40 - Math.random() * 50;
        piece.style.background = colors[i % colors.length];
        piece.style.setProperty('--dx', dx.toFixed(1) + 'px');
        piece.style.setProperty('--dy', dy.toFixed(1) + 'px');
        piece.style.setProperty('--rot', Math.round(Math.random() * 900 - 450) + 'deg');
        piece.style.animationDelay = Math.random() * 160 + 'ms';
        // 部分碎片用圆形，更像彩带
        if (i % 4 === 0) {
          piece.style.borderRadius = '50%';
          piece.style.width = '10px';
          piece.style.height = '10px';
        }
        fragments.appendChild(piece);
      }
      confettiEl.appendChild(fragments);
      confettiEl.classList.add('active');
    }

    /**
     * 播放特效。
     * @param {string} name slash | crack | confetti
     * @param {{holder?:string, onEnd?:Function}} [meta]
     * @returns {{ok:boolean, name?:string, holder?:string, duration?:number, reason?:string}}
     */
    function play(name, meta) {
      if (disposed) return { ok: false, reason: 'disposed' };
      if (!slashEl || !crackEl) return { ok: false, reason: 'no_dom' };
      if (Object.prototype.hasOwnProperty.call(DURATIONS, name) === false) {
        return { ok: false, reason: 'unknown_effect' };
      }
      // 先清掉上一段，保证同时只有一个特效
      resetAll();

      const holder = (meta && meta.holder) || 'fx-' + Date.now();
      onEnd = (meta && typeof meta.onEnd === 'function' && meta.onEnd) || null;
      activeName = name;
      activeHolder = holder;
      if (root) root.dataset.active = name;

      const visual = !meta || meta.visual !== false;
      if (visual && name === 'slash' && slashEl) {
        // 强制重排，保证动画能重新触发
        void slashEl.offsetWidth;
        slashEl.classList.add('active');
      } else if (visual && name === 'crack' && crackEl) {
        if (global.DeskBuddy.glass) global.DeskBuddy.glass.render(crackEl.querySelector('.glass-fracture'));
        void crackEl.offsetWidth;
        crackEl.classList.add('active');
      } else if (visual && name === 'confetti') {
        spawnConfetti(40);
      }

      const duration = DURATIONS[name];
      activeTimer = global.setTimeout(() => {
        activeTimer = null;
        const finishedName = activeName;
        const finishedHolder = activeHolder;
        resetAll();
        if (onEnd) {
          const cb = onEnd;
          onEnd = null;
          try {
            cb({ name: finishedName, holder: finishedHolder });
          } catch (error) {
            // 回调出错不能影响后续
            if (global.console) global.console.error('[effects] onEnd 失败', error);
          }
        }
      }, duration);

      return { ok: true, name, holder, duration };
    }

    function stop() {
      resetAll();
    }

    function dispose() {
      disposed = true;
      onEnd = null;
      resetAll();
    }

    function isPlaying() {
      return activeName !== null;
    }

    return {
      DURATIONS,
      play,
      stop,
      dispose,
      isPlaying,
      get active() {
        return activeName;
      }
    };
  }

  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.effects = { createEffects, DURATIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createEffects, DURATIONS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
