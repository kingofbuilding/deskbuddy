/* 屏幕玻璃裂纹：不采集桌面，透明玻璃层直接叠在真实桌面上。 */
(function (global) {
  'use strict';
  function random(seed) {
    let value = seed >>> 0;
    return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
  }
  function createModel(options) {
    const opts = options || {};
    const width = opts.width || 1920, height = opts.height || 1080;
    const rand = random(opts.seed === undefined ? Date.now() : opts.seed);
    const cx = opts.impact && Number.isFinite(opts.impact.x) ? Math.max(10, Math.min(width - 10, opts.impact.x)) : width * (.48 + rand() * .08);
    const cy = opts.impact && Number.isFinite(opts.impact.y) ? Math.max(10, Math.min(height - 10, opts.impact.y)) : height * (.4 + rand() * .08);
    const diagonal = Math.hypot(width, height);
    const paths = [], facets = [], chips = [], rays = [];
    const point = (x, y) => [Number(x.toFixed(2)), Number(y.toFixed(2))];
    const polar = (a, r) => point(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    const pathData = (points) => points.map((p, i) => (i ? 'L' : 'M') + p.join(' ')).join(' ');
    const addPath = (points, thickness, distance) => paths.push({ d: pathData(points), thickness, delay: Math.round(10 + distance / diagonal * 170) });

    // 不等距的径向断口，主裂缝延伸至边缘，短裂缝终止在玻璃内部。
    for (let i = 0; i < 34; i++) {
      const angle = i * Math.PI * 2 / 34 + (rand() - .5) * .1;
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const edge = Math.min(ux > 0 ? (width - cx) / ux : -cx / ux, uy > 0 ? (height - cy) / uy : -cy / uy);
      const length = edge * (i % 4 === 0 ? .35 + rand() * .5 : 1.02);
      const points = [polar(angle, 3 + rand() * 8)];
      for (let d = 17; d < length; d += 17 + rand() * 39) {
        const jitter = (rand() - .5) * Math.min(13, d * .035);
        points.push(point(cx + ux * d - uy * jitter, cy + uy * d + ux * jitter));
      }
      points.push(polar(angle, length));
      addPath(points, i % 3 ? .7 + rand() * .6 : 1.5 + rand() * .7, 0);
      rays.push({ angle, length });

      for (let j = 0; j < 3; j++) {
        const distance = length * (.18 + rand() * .55);
        const start = polar(angle, distance);
        const branchAngle = angle + (rand() > .5 ? 1 : -1) * (.22 + rand() * .5);
        const branchLength = 35 + rand() * length * .3;
        const branch = [start];
        for (let t = 1; t <= 5; t++) {
          const travel = branchLength * t / 5;
          branch.push(point(start[0] + Math.cos(branchAngle) * travel + (rand() - .5) * 6, start[1] + Math.sin(branchAngle) * travel + (rand() - .5) * 6));
        }
        addPath(branch, .35 + rand() * .5, distance);
      }
    }

    // 受力形成的横向断口。每个扇区单独偏移、断开，避免规则蜘蛛网。
    for (const ring of [19, 39, 72, 126, 215, 360, 590]) {
      for (let i = 0; i < rays.length; i++) {
        if (rand() < .34) continue;
        const a = rays[i], b = rays[(i + 1) % rays.length];
        const radiusA = ring * (.7 + rand() * .6), radiusB = ring * (.7 + rand() * .6);
        if (radiusA > a.length || radiusB > b.length) continue;
        const p = polar(a.angle, radiusA), q = polar(b.angle, radiusB);
        const middle = point((p[0] + q[0]) / 2 + (rand() - .5) * 8, (p[1] + q[1]) / 2 + (rand() - .5) * 8);
        addPath([p, middle, q], .35 + rand() * .6, ring);
        if (rand() < .28 && ring > 70) {
          facets.push({ points: [p, q, polar(b.angle, Math.min(b.length, radiusB * 1.9)), polar(a.angle, Math.min(a.length, radiusA * 1.7))], alpha: .016 + rand() * .035 });
        }
      }
    }
    for (let i = 0; i < 65; i++) {
      const angle = rand() * Math.PI * 2, radius = Math.pow(rand(), 1.8) * 35;
      const p = polar(angle, radius), size = .7 + rand() * 4.5;
      chips.push([p, point(p[0] + size, p[1] - size * .4), point(p[0] + size * .3, p[1] + size * 1.6)]);
    }
    return { width, height, cx, cy, paths, facets, chips };
  }

  function render(host, options) {
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const model = createModel(Object.assign({ width: rect.width || 1920, height: rect.height || 1080 }, options));
    const ns = 'http://www.w3.org/2000/svg';
    const element = (tag, attrs) => { const node = host.ownerDocument.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
    host.textContent = '';
    host.setAttribute('viewBox', `0 0 ${model.width} ${model.height}`);
    host.setAttribute('preserveAspectRatio', 'none');
    host.setAttribute('data-impact-x', String(model.cx));
    host.setAttribute('data-impact-y', String(model.cy));
    const surface = element('g', { class: 'glass-facets' });
    for (const facet of model.facets) surface.appendChild(element('polygon', { points: facet.points.map((p) => p.join(',')).join(' '), fill: `rgba(240,247,255,${facet.alpha})` }));
    host.appendChild(surface);
    for (const [layer, stroke, offset, multiplier] of [
      ['glass-depth', 'rgba(8,15,24,.7)', 'translate(.6 .7)', 1.8],
      ['glass-edge', 'rgba(255,255,255,.88)', 'translate(-.45 -.4)', .63]
    ]) {
      const group = element('g', { class: layer, fill: 'none', stroke, transform: offset, 'stroke-linecap': 'round', 'stroke-linejoin': 'miter' });
      for (const path of model.paths) group.appendChild(element('path', { d: path.d, 'stroke-width': path.thickness * multiplier, pathLength: 1, style: `--fracture-delay:${path.delay}ms` }));
      host.appendChild(group);
    }
    const damage = element('g', { class: 'glass-chips' });
    model.chips.forEach((chip, i) => damage.appendChild(element('polygon', { points: chip.map((p) => p.join(',')).join(' '), fill: i % 3 ? 'rgba(248,251,255,.56)' : 'rgba(10,17,28,.6)' })));
    host.appendChild(damage);
    return model;
  }
  const api = { createModel, render };
  global.DeskBuddy = global.DeskBuddy || {};
  global.DeskBuddy.glass = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
