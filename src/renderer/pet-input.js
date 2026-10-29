/* 透明区域点击穿透。仅角色不透明像素、菜单和气泡响应鼠标。 */
(function (global) {
  'use strict';
  function create(options) {
    const { document: doc, pet, stage, setInteractive } = options;
    const cache = new Map();
    let interactive = null, down = false;
    const contains = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    function alphaHit(image, x, y) {
      if (!image || !image.complete || !image.naturalWidth) return false;
      const rect = image.getBoundingClientRect();
      if (!contains(rect, x, y) || !rect.width || !rect.height) return false;
      let pixels = cache.get(image.src);
      if (!pixels) {
        const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return true;
        const ratio = image.naturalWidth / image.naturalHeight;
        const w = Math.min(256, 256 * ratio), h = Math.min(256, 256 / ratio);
        context.drawImage(image, (256 - w) / 2, (256 - h) / 2, w, h);
        pixels = context.getImageData(0, 0, 256, 256).data; cache.set(image.src, pixels);
      }
      const px = Math.min(255, Math.max(0, Math.floor((x - rect.left) / rect.width * 256)));
      const py = Math.min(255, Math.max(0, Math.floor((y - rect.top) / rect.height * 256)));
      return pixels[(py * 256 + px) * 4 + 3] > 20;
    }
    function hit(x, y) {
      for (const selector of ['#quick-menu.visible', '#bubble.visible']) {
        const node = doc.querySelector(selector);
        if (node && contains(node.getBoundingClientRect(), x, y)) return { interactive: true, actor: false };
      }
      const life = doc.getElementById('pet-life-frame');
      const image = life && !life.hidden ? life : pet.querySelector('.pet-sprite.active');
      const actor = alphaHit(image, x, y);
      return { interactive: actor, actor };
    }
    function apply(on) { if (interactive !== on) { interactive = on; setInteractive(on); } }
    function update(event) {
      const result = hit(event.clientX, event.clientY);
      stage.dataset.pointer = result.actor ? 'actor' : 'empty';
      apply(down || result.interactive);
    }
    const press = () => { down = true; apply(true); };
    const release = (event) => { down = false; update(event); };
    const leave = () => { if (!down) { stage.dataset.pointer = 'empty'; apply(false); } };
    const cancel = () => { down = false; leave(); };
    doc.addEventListener('mousemove', update);
    doc.addEventListener('pointerdown', press);
    doc.addEventListener('pointerup', release);
    doc.addEventListener('pointercancel', cancel);
    global.addEventListener('blur', cancel);
    doc.addEventListener('mouseleave', leave);
    apply(false);
    return { hit, update, dispose() {
      doc.removeEventListener('mousemove', update); doc.removeEventListener('pointerdown', press);
      doc.removeEventListener('pointerup', release); doc.removeEventListener('pointercancel', cancel);
      global.removeEventListener('blur', cancel); doc.removeEventListener('mouseleave', leave); cache.clear();
    } };
  }
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.petInput = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
