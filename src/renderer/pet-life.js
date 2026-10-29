/* 小动作控制器：真实的闭眼/挥手/走路帧 + 轻微身体动作，独立于业务状态。 */
(function (global) {
  'use strict';
  function create(options) {
    const { pet, frame, getContext, onWander } = options;
    const timers = new Set();
    for (const name of ['blink', 'wave', 'walk_left', 'walk_right']) {
      const image = new global.Image(); image.src = 'assets/girl-' + name + '.png';
    }
    let enabled = false, walking = false, stepTimer = null, poseTimer = null;
    let lastWander = Date.now(), nextWander = 55000 + Math.random() * 35000;
    const reduced = () => Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const schedule = (callback, ms) => { const timer = global.setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return timer; };
    function clearPose() {
      if (poseTimer) { global.clearTimeout(poseTimer); timers.delete(poseTimer); poseTimer = null; }
      pet.dataset.life = ''; frame.hidden = true;
    }
    function canMove() {
      const c = getContext();
      return enabled && c.settings.lifeEnabled && c.settings.effectsEnabled && !c.settings.doNotDisturb && !c.dragging && !c.menuOpen && c.petState !== 'effect' && !reduced();
    }
    function canPose() {
      return canMove() && ['idle', 'companion'].includes(getContext().petState);
    }
    function pose(name, duration) {
      if (!canPose() || walking) return;
      clearPose();
      if (name !== 'tilt') frame.src = 'assets/girl-' + name + '.png';
      frame.hidden = name === 'tilt';
      pet.dataset.life = name;
      poseTimer = schedule(clearPose, duration);
    }
    function blinkLoop() {
      if (!enabled) return;
      pose('blink', 145);
      schedule(blinkLoop, 2800 + Math.random() * 3200);
    }
    function ambientLoop() {
      if (!enabled) return;
      const c = getContext(), now = Date.now();
      if (canPose() && !walking && !c.bubble && !pet.dataset.life) {
        if (c.settings.wanderEnabled && global.DeskBuddy.initiative.canRoam(Object.assign({},c.initiative,{focusRunning:c.focusRunning,pendingCount:c.pendingCount})) && now - lastWander > nextWander) {
          lastWander = now; nextWander = 55000 + Math.random() * 35000; onWander();
        } else if (Math.random() < .5) pose('wave', 1500);
        else pose('tilt', 1600);
      }
      schedule(ambientLoop, 12000 + Math.random() * 12000);
    }
    function setWalking(on) {
      if (stepTimer) { global.clearInterval(stepTimer); stepTimer = null; }
      walking = Boolean(on) && canMove();
      clearPose();
      if (!walking) return;
      let step = 0;
      const draw = () => {
        frame.src = 'assets/girl-walk_' + (step++ % 2 ? 'left' : 'right') + '.png';
        frame.hidden = false; pet.dataset.life = 'walk';
      };
      draw(); stepTimer = global.setInterval(draw, 210);
    }
    function sync() {
      if (!canMove() || (!walking && !canPose())) { setWalking(false); clearPose(); }
    }
    function start() {
      if (enabled) return;
      enabled = true; schedule(blinkLoop, 1200); schedule(ambientLoop, 7000);
    }
    function dispose() {
      enabled = false;
      for (const timer of timers) global.clearTimeout(timer);
      timers.clear();
      if (stepTimer) global.clearInterval(stepTimer);
      stepTimer = null; walking = false; clearPose();
    }
    return { start, dispose, sync, setWalking, wave: () => pose('wave', 1500), preview: (name) => pose(name, name === 'blink' ? 145 : 1500) };
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.petLife = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
