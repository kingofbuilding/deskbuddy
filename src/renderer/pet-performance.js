/* 桌宠本体演出。只操作现有 #pet，向特效层发送手和身体的位置。 */
(function (global) {
  'use strict';
  function create(options) {
    const { pet, onAnchor } = options;
    let timer = null, animationFrame = null, current = null, lastSent = 0;
    function measure() {
      const image = pet.querySelector('.pet-sprite.active');
      const width = pet.clientWidth || 176, height = pet.clientHeight || 176;
      const ratio = image && image.naturalWidth ? image.naturalWidth / image.naturalHeight : 1;
      const fitWidth = Math.min(width, height * ratio), fitHeight = Math.min(height, width / ratio);
      const localHand = { x: (width - fitWidth) / 2 + fitWidth * .26, y: (height - fitHeight) / 2 + fitHeight * .45 };
      const parent = pet.offsetParent;
      const base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
      const style = global.getComputedStyle(pet);
      const origin = style.transformOrigin.split(' ').map(Number.parseFloat);
      let hand = localHand;
      if (global.DOMMatrix && global.DOMPoint && style.transform !== 'none') {
        const point = new global.DOMPoint(localHand.x - (origin[0] || 0), localHand.y - (origin[1] || 0)).matrixTransform(new global.DOMMatrix(style.transform));
        hand = { x: point.x + (origin[0] || 0), y: point.y + (origin[1] || 0) };
      }
      const box = pet.getBoundingClientRect();
      const x = base.left + pet.offsetLeft + hand.x, y = base.top + pet.offsetTop + hand.y;
      return { hand: { x, y }, impact: { x: x - 14, y: y - 16 }, body: { x: box.left, y: box.top, width: box.width || width, height: box.height || height } };
    }
    function stop() {
      if (timer) global.clearTimeout(timer);
      if (animationFrame) global.cancelAnimationFrame(animationFrame);
      timer = animationFrame = null; current = null; delete pet.dataset.performance;
    }
    function play(name, duration, holder) {
      stop();
      pet.style.setProperty('--performance-duration', duration + 'ms');
      void pet.offsetWidth;
      pet.dataset.performance = name;
      current = { name, holder: holder || '', startedAt: Date.now() };
      const update = () => {
        if (!current) return;
        if (Date.now() - lastSent > 35) {
          lastSent = Date.now(); onAnchor(Object.assign({}, current, { anchor: measure() }));
        }
        animationFrame = global.requestAnimationFrame(update);
      };
      update(); timer = global.setTimeout(stop, duration);
      return Object.assign({}, current, { anchor: measure() });
    }
    return { play, stop, measure, dispose: stop };
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.petPerformance = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
