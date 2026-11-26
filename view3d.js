/* Floor Planner: experimental 3D preview.
 *
 * index.html loads this file only when someone opens the 3D view, so the plan editor never
 * depends on it. It receives a plain copy of the drawing (see model3D() in index.html), never
 * changes it, draws only when something moves, and releases its WebGL context when closed.
 * Every event handler is guarded: if anything here fails, options.onError() is called and the
 * host closes the view; the editor keeps working.
 *
 * window.FP3D = { api, create(host, model, options) -> controller, counters }
 * Plan coordinates are centimetres with y pointing down the screen. In 3D, x stays x,
 * height is y, and the plan's y becomes z. Heights come from the drawing: each wall part has its own
 * height (the ceiling of the room it borders), doors carry their head height, windows their sill and head.
 */
(function () {
  'use strict';
  const API = 4;
  const counters = {created: 0, destroyed: 0, contextsCreated: 0, contextsReleased: 0, errors: 0};

  /* ---------- colours ---------- */
  const hex = h => {
    h = String(h || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(h)) h = 'dcd6cc';
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
  };
  const C = {
    bg: hex('eef0ec'), ground: hex('e1e4dd'), grid: hex('cdd2c8'),
    wall: hex('f4f2ed'), wallTop: hex('2b2f35'), sill: hex('ebe8e1'),
    door: hex('d6bf98'), glass: [0.6, 0.77, 0.9, 0.3],
    fabric: hex('b7c1cc'), cushion: hex('cbd3db'), linen: hex('f3f1ec'), pillow: hex('ffffff'),
    wood: hex('cdb592'), woodDark: hex('a88d69'), appliance: hex('eceeee'), dark: hex('3a3f46'), steel: hex('c3c8cc'),
    counter: hex('e4e0d8'), counterTop: hex('cbc5bb'), porcelain: hex('fbfbf9'), stone: hex('dbd5ca'), box: hex('dcd6cc'), ink: hex('2b2f35'),
    shirt: hex('7d93ab'), pants: hex('4f5b69'), skin: hex('ddd6cd'), shoes: hex('33383f'), hair: hex('5b534c'), chair: hex('3f454d'),
  };
  const floorColor = c => { const v = hex(c); return v[0] > .99 && v[1] > .99 && v[2] > .99 ? hex('f8f7f3') : v; };

  /* ---------- 2D helpers (plan coordinates) ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function cleanPoly(pts) {
    const out = [];
    for (const p of pts || []) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return [];
      const q = out[out.length - 1];
      if (!q || Math.abs(q.x - p.x) > .01 || Math.abs(q.y - p.y) > .01) out.push({x: +p.x, y: +p.y});
    }
    while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) <= .01 && Math.abs(out[0].y - out[out.length - 1].y) <= .01) out.pop();
    return out;
  }
  function area2(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.y - q.x * p.y; } return a / 2; }
  function inTri(p, a, b, c) {
    const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
    const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }
  /* ear clipping; falls back to a fan for shapes it can't untangle, so it always terminates */
  function triangulate(pts) {
    const n = pts.length; if (n < 3) return [];
    if (n === 3) return [[0, 1, 2]];
    const sg = area2(pts) > 0 ? 1 : -1, idx = Array.from({length: n}, (_, i) => i), out = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        const a = pts[i0], b = pts[i1], c = pts[i2];
        if (((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * sg <= 1e-9) continue;
        let blocked = false;
        for (const j of idx) { if (j !== i0 && j !== i1 && j !== i2 && inTri(pts[j], a, b, c)) { blocked = true; break; } }
        if (blocked) continue;
        out.push([i0, i1, i2]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) { for (let i = 1; i < idx.length - 1; i++) out.push([idx[0], idx[i], idx[i + 1]]); return out; }
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }
  const rect = (x0, y0, x1, y1) => [{x: x0, y: y0}, {x: x1, y: y0}, {x: x1, y: y1}, {x: x0, y: y1}];
  const ellipse = (cx, cy, rx, ry, seg) => Array.from({length: seg}, (_, i) => { const a = i / seg * Math.PI * 2; return {x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry}; });
  const rot = (p, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return {x: p.x * c - p.y * s, y: p.x * s + p.y * c}; };

  /* ---------- mesh building: interleaved x y z, nx ny nz, r g b a ---------- */
  class Mesh {
    constructor() { this.v = []; }
    vert(p, n, c) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], c.length > 3 ? c[3] : 1); }
    tri(a, b, c, n, col) { this.vert(a, n, col); this.vert(b, n, col); this.vert(c, n, col); }
    quad(a, b, c, d, n, col) { this.tri(a, b, c, n, col); this.tri(a, c, d, n, col); }
    get count() { return this.v.length / 10; }
  }
  /* extrude a plan polygon from height z0 to z1; normals point outward whichever way it winds */
  function prism(mesh, pts, z0, z1, col, topCol) {
    pts = cleanPoly(pts);
    if (pts.length < 3 || !isFinite(z0) || !isFinite(z1) || !(z1 > z0)) return false;
    const A = area2(pts); if (!(Math.abs(A) > 1e-4)) return false;
    const s = A > 0 ? 1 : -1, n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      mesh.quad([a.x, z0, a.y], [b.x, z0, b.y], [b.x, z1, b.y], [a.x, z1, a.y], [s * dy / L, 0, -s * dx / L], col);
    }
    for (const [i, j, k] of triangulate(pts)) {
      mesh.tri([pts[i].x, z1, pts[i].y], [pts[j].x, z1, pts[j].y], [pts[k].x, z1, pts[k].y], [0, 1, 0], topCol || col);
      if (z0 > .5) mesh.tri([pts[i].x, z0, pts[i].y], [pts[k].x, z0, pts[k].y], [pts[j].x, z0, pts[j].y], [0, -1, 0], col);
    }
    return true;
  }
  function flat(mesh, pts, z, col) {
    pts = cleanPoly(pts); if (pts.length < 3 || !(Math.abs(area2(pts)) > 1e-4)) return false;
    for (const [i, j, k] of triangulate(pts)) mesh.tri([pts[i].x, z, pts[i].y], [pts[j].x, z, pts[j].y], [pts[k].x, z, pts[k].y], [0, 1, 0], col);
    return true;
  }

  /* ---------- objects from the library, in their own coordinates (-y is the back) ---------- */
  function legs(P, x0, y0, x1, y1, z1, s, col) { const i = 3; for (const [x, y] of [[x0 + i, y0 + i], [x1 - i - s, y0 + i], [x0 + i, y1 - i - s], [x1 - i - s, y1 - i - s]]) P(rect(x, y, x + s, y + s), 0, z1, col); }
  function chair(P, x0, y0, x1, y1, backAtFront) {
    P(rect(x0, y0, x1, y1), 42, 46, C.woodDark); legs(P, x0, y0, x1, y1, 42, 3, C.woodDark);
    if (backAtFront) P(rect(x0, y0, x1, y0 + 4), 46, 88, C.woodDark); else P(rect(x0, y1 - 4, x1, y1), 46, 88, C.woodDark);
  }
  /* ---------- people, for scale ----------
   * Built standing up in their own coordinates (facing +y, the feet's direction), then fitted to the
   * object's footprint in the plan. Proportions are fractions of the person's height (H). */
  const BODY = {
    male: {H: 175, sh: 19, hip: 16, armW: 8.5, armD: 9.5, legW: 13, legD: 14.5, chD: 23, longHair: false},
    female: {H: 163, sh: 16.5, hip: 17, armW: 7.5, armD: 8.5, legW: 12.5, legD: 14, chD: 21, longHair: true},
  };
  function personParts(pose, style, height) {
    const B = BODY[style] || BODY.male, H = clamp(+height || B.H, 50, 250), k = H / B.H, out = [];
    const sh = B.sh * k, hip = B.hip * k, aw = B.armW * k, ad = B.armD * k, lw = B.legW * k, ld = B.legD * k, cd = B.chD * k, lx = hip * .52;
    const box = (x0, x1, y0, y1, z0, z1, c) => out.push({x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), c});
    const ell = (cx, cy, rx, ry, z0, z1, c) => out.push({e: 1, x0: cx - rx, x1: cx + rx, y0: cy - ry, y1: cy + ry, z0, z1, c});
    const limb = (x0, x1, ya, za, yb, zb, d, c, n = 6) => {   // a slanted limb, as a short stack of boxes
      for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 1) / n, y = ya + (yb - ya) * (t0 + t1) / 2; box(x0, x1, y - d / 2, y + d / 2, za + (zb - za) * t0, za + (zb - za) * t1, c); }
    };
    const both = fn => { fn(-1); fn(1); };
    const head = (cy, zn) => {   // zn: top of the shoulders
      const zh = zn + .05 * H;
      ell(0, cy - .004 * H, .034 * H, .034 * H, zn - .01 * H, zh + .01 * H, C.skin);
      ell(0, cy + .006 * H, .05 * H, .058 * H, zh, zh + .1 * H, C.skin);
      box(-.008 * H, .008 * H, cy + .058 * H, cy + .07 * H, zh + .035 * H, zh + .058 * H, C.skin);   // nose: shows which way they face
      ell(0, cy, .053 * H, .061 * H, zh + .072 * H, zh + .11 * H, C.hair);
      ell(0, cy - .004 * H, .04 * H, .047 * H, zh + .11 * H, zh + .13 * H, C.hair);
      if (B.longHair) ell(0, cy - .038 * H, .052 * H, .03 * H, zn - .045 * H, zh + .1 * H, C.hair);
    };
    const torso = (cy, zb) => {   // zb: crotch
      box(-hip, hip, cy - cd * .45, cy + cd * .42, zb - .01 * H, zb + .09 * H, C.pants);
      box(-sh * .84, sh * .84, cy - cd * .44, cy + cd * .44, zb + .09 * H, zb + .17 * H, C.shirt);
      box(-sh * .96, sh * .96, cy - cd * .5, cy + cd * .5, zb + .17 * H, zb + .32 * H, C.shirt);
      box(-sh, sh, cy - cd * .42, cy + cd * .38, zb + .32 * H, zb + .348 * H, C.shirt);
      return zb + .348 * H;
    };
    if (pose === 'standing') {
      both(s => {
        const cx = s * lx;
        box(cx - lw * .4, cx + lw * .4, -.03 * H, .12 * H, 0, .039 * H, C.shoes);
        box(cx - lw * .41, cx + lw * .41, -ld * .42, ld * .42, .039 * H, .285 * H, C.pants);
        box(cx - lw / 2, cx + lw / 2, -ld / 2, ld / 2, .285 * H, .47 * H, C.pants);
        box(s * sh, s * (sh + aw), -ad / 2, ad / 2, .63 * H, .813 * H, C.shirt);
        box(s * (sh + aw * .05), s * (sh + aw * .95), -ad * .45, ad * .45, .485 * H, .63 * H, C.shirt);
        box(s * (sh + aw * .1), s * (sh + aw * .9), -ad * .4 + .01 * H, ad * .4 + .01 * H, .4 * H, .485 * H, C.skin);
      });
      head(0, torso(0, .47 * H));
    } else if (pose === 'walking') {
      both(s => {   // left leg forward, right arm forward
        const cx = s * lx, ya = s < 0 ? .12 * H : -.11 * H;
        limb(cx - lw * .45, cx + lw * .45, 0, .47 * H, ya, .039 * H, ld * .9, C.pants);
        box(cx - lw * .4, cx + lw * .4, ya - .035 * H, ya + .115 * H, 0, .039 * H, C.shoes);
        const yh = s < 0 ? -.09 * H : .1 * H;
        limb(s * sh, s * (sh + aw), 0, .8 * H, yh, .485 * H, ad, C.shirt, 5);
        box(s * (sh + aw * .1), s * (sh + aw * .9), yh - ad * .4, yh + ad * .4, .4 * H, .485 * H, C.skin);
      });
      head(0, torso(0, .47 * H));
    } else {   // sitting, on a chair or in a wheelchair
      const wc = pose === 'wheelchair', zs = wc ? 48 : .255 * H, zf = wc ? 12 : 0, cy = -.055 * H;
      const knee = .215 * H, zk = Math.max(zs + .03 * H, zf + .27 * H);
      both(s => {
        const cx = s * lx;
        box(cx - lw / 2, cx + lw / 2, -.1 * H, knee, zs, zs + .085 * H, C.pants);
        box(cx - lw * .41, cx + lw * .41, knee - .075 * H, knee, zf + .039 * H, zk, C.pants);
        box(cx - lw * .4, cx + lw * .4, knee - .09 * H, knee + .06 * H, zf, zf + .039 * H, C.shoes);
      });
      const zt = torso(cy, zs + .01 * H), za = zs + .01 * H;
      both(s => {
        box(s * sh, s * (sh + aw), cy - ad / 2, cy + ad / 2, za + .17 * H, zt - .005 * H, C.shirt);
        box(s * sh * .8, s * (sh * .8 + aw * .9), cy - ad / 2, .12 * H, za + .12 * H, za + .17 * H, C.shirt);
        box(s * sh * .8, s * (sh * .8 + aw * .8), .12 * H, .17 * H, za + .115 * H, za + .165 * H, C.skin);
      });
      head(cy + .01 * H, zt);
      if (wc) {   // the chair: seat, back, armrests, big wheels, casters and footrests
        const sx = hip + 4, back = cy - cd / 2 - 2, front = .17 * H, wr = 30, wy = back + 24, foot0 = knee - .1 * H, foot1 = knee + .07 * H;
        box(-sx, sx, back, front, zs - 5, zs, C.chair);
        box(-sx, sx, back - 3, back, zs - 5, zs + 40, C.chair);
        both(s => {
          box(s * (sx - 2), s * (sx + 1), back - 11, back - 3, zs + 37, zs + 40, C.chair);
          box(s * sx, s * (sx + 3), back, front - 8, zs + 20, zs + 23, C.chair);
          box(s * sx, s * (sx + 3), front - 12, front - 9, zs, zs + 20, C.steel);
          const n = 10, x0 = s * (sx + 3.5), x1 = s * (sx + 6.5);
          for (let i = 0; i < n; i++) { const z0 = 2 * wr * i / n, z1 = 2 * wr * (i + 1) / n, zm = (z0 + z1) / 2 - wr, hc = Math.sqrt(Math.max(0, wr * wr - zm * zm)); box(x0, x1, wy - hc, wy + hc, z0, z1, C.ink); }
          box(s * (sx + 7.5), s * (sx + 8.5), wy - 2, wy + 2, wr - 1, wr + 1, C.steel);
          for (let i = 0; i < 4; i++) { const r = 7, z0 = 2 * r * i / 4, z1 = 2 * r * (i + 1) / 4, zm = (z0 + z1) / 2 - r, hc = Math.sqrt(r * r - zm * zm); box(s * (sx - 4), s * (sx - 1), front + 4 - hc, front + 4 + hc, z0, z1, C.ink); }
          limb(s * (sx - 4), s * (sx - 1), front, zs - 5, foot0 + 2, zf, 3, C.steel, 4);
          box(s * 1.5, s * (sx - 2), foot0, foot1, zf - 3, zf, C.chair);
        });
      }
    }
    return out;
  }
  function person(P, w, h, it, pose) {
    const parts = personParts(pose, it.style === 'female' ? 'female' : 'male', it.height);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of parts) { x0 = Math.min(x0, q.x0); x1 = Math.max(x1, q.x1); y0 = Math.min(y0, q.y0); y1 = Math.max(y1, q.y1); }
    const kx = w / (x1 - x0), ky = h / (y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;   // fit to the footprint drawn in the plan
    const X = x => (x - cx) * kx, Y = y => (y - cy) * ky;
    for (const q of parts) {
      if (q.e) P(ellipse(X((q.x0 + q.x1) / 2), Y((q.y0 + q.y1) / 2), (q.x1 - q.x0) / 2 * kx, (q.y1 - q.y0) / 2 * ky, 12), q.z0, q.z1, q.c);
      else P(rect(X(q.x0), Y(q.y0), X(q.x1), Y(q.y1)), q.z0, q.z1, q.c);
    }
  }
  const ITEM = {
    standing(P, w, h, it) { person(P, w, h, it, 'standing'); },
    walking(P, w, h, it) { person(P, w, h, it, 'walking'); },
    sitting(P, w, h, it) { person(P, w, h, it, 'sitting'); },
    wheelchair(P, w, h, it) { person(P, w, h, it, 'wheelchair'); },
    stairs(P, w, h, it, H) {
      const n = clamp(Math.round(it.steps || h / 25), 2, 60), st = h / n, rise = H / n;
      for (let i = 0; i < n; i++) P(rect(-w / 2, h / 2 - (i + 1) * st, w / 2, h / 2 - i * st), 0, (i + 1) * rise, C.stone);
    },
    spiral(P, w, h, it, H) {
      const r = Math.min(w, h) / 2, n = 12, rise = H / (n + 1);
      P(ellipse(0, 0, r * .09, r * .09, 12), 0, H, C.dark);
      for (let k = 0; k < n; k++) {
        const a0 = (-90 + k * 25) * Math.PI / 180, a1 = (-90 + (k + 1) * 25) * Math.PI / 180, pts = [{x: 0, y: 0}];
        for (let j = 0; j <= 4; j++) { const a = a0 + (a1 - a0) * j / 4; pts.push({x: Math.cos(a) * r, y: Math.sin(a) * r}); }
        P(pts, (k + 1) * rise - 4, (k + 1) * rise, C.stone);
      }
    },
    column(P, w, h, it, H) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, H, C.ink); },
    counter(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 86, C.counter); P(rect(-w / 2, -h / 2, w / 2, h / 2), 86, 90, C.counterTop); },
    ksink(P, w, h) {
      ITEM.counter(P, w, h);
      const m = Math.min(6, w * .06), bw = (w - 3 * m) / 2, by = -h / 2 + m + 5, bh = h - 2 * m - 5;
      P(rect(-w / 2 + m, by, -w / 2 + m + bw, by + bh), 90, 90.6, C.steel); P(rect(m / 2, by, m / 2 + bw, by + bh), 90, 90.6, C.steel);
    },
    stove(P, w, h) {
      P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 88, C.appliance); P(rect(-w / 2, -h / 2, w / 2, h / 2), 88, 91, C.dark);
      const k = Math.min(w, h);
      for (const [x, y, r] of [[-w / 4, -h / 2 + h * .3, k * .15], [w / 4, -h / 2 + h * .3, k * .11], [-w / 4, -h / 2 + h * .67, k * .11], [w / 4, -h / 2 + h * .67, k * .15]]) P(ellipse(x, y, r, r, 14), 91, 92, C.steel);
    },
    fridge(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 180, C.appliance); },
    washer(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 85, C.appliance); },
    toilet(P, w, h) { const th = h * .28, ry = (h - th) / 2; P(ellipse(0, -h / 2 + th + ry - 1, w * .42, ry, 18), 0, 40, C.porcelain); P(rect(-w / 2, -h / 2, w / 2, -h / 2 + th), 0, 78, C.porcelain); },
    vanity(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 82, C.wood); P(ellipse(0, h * .08, Math.min(w * .36, 28), h * .3, 18), 82, 86, C.porcelain); },
    bathtub(P, w, h) {
      const m = Math.min(7, h * .1);
      P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 10, C.porcelain);
      P(rect(-w / 2, -h / 2, w / 2, -h / 2 + m), 10, 55, C.porcelain); P(rect(-w / 2, h / 2 - m, w / 2, h / 2), 10, 55, C.porcelain);
      P(rect(-w / 2, -h / 2 + m, -w / 2 + m, h / 2 - m), 10, 55, C.porcelain); P(rect(w / 2 - m, -h / 2 + m, w / 2, h / 2 - m), 10, 55, C.porcelain);
    },
    shower(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 6, C.porcelain); },
    bed(P, w, h) {
      P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 30, C.fabric); P(rect(-w / 2 + 2, -h / 2 + 6, w / 2 - 2, h / 2 - 2), 30, 52, C.linen);
      P(rect(-w / 2, -h / 2, w / 2, -h / 2 + 6), 0, 100, C.wood);
      const m = Math.min(8, w * .06), ph = Math.min(40, h * .17), py = -h / 2 + 6 + m * .6;
      if (w >= 110) { const pw = (w - 3 * m) / 2; P(rect(-w / 2 + m, py, -w / 2 + m + pw, py + ph), 52, 62, C.pillow); P(rect(m / 2, py, m / 2 + pw, py + ph), 52, 62, C.pillow); }
      else P(rect(-w / 2 + m, py, w / 2 - m, py + ph), 52, 62, C.pillow);
    },
    sofa(P, w, h) {
      const b = Math.min(h * .3, 25), a = Math.min(w * .13, 22);
      P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 40, C.fabric); P(rect(-w / 2, -h / 2, w / 2, -h / 2 + b), 40, 80, C.fabric);
      P(rect(-w / 2, -h / 2 + b, -w / 2 + a, h / 2), 40, 60, C.fabric); P(rect(w / 2 - a, -h / 2 + b, w / 2, h / 2), 40, 60, C.fabric);
      P(rect(-w / 2 + a, -h / 2 + b, w / 2 - a, h / 2 - 2), 40, 46, C.cushion);
    },
    armchair(P, w, h) { ITEM.sofa(P, w, h); },
    table(P, w, h) {
      const c = Math.min(42, h * .28), ty = c * .55, n = Math.max(1, Math.floor((w - 20) / 60)), cw = Math.min(44, (w - 20) / n - 8);
      for (let i = 0; i < n; i++) { const cx = -w / 2 + (i + .5) * w / n; chair(P, cx - cw / 2, -h / 2, cx + cw / 2, -h / 2 + c, true); chair(P, cx - cw / 2, h / 2 - c, cx + cw / 2, h / 2, false); }
      const y0 = -h / 2 + ty, y1 = h / 2 - ty;
      P(rect(-w / 2, y0, w / 2, y1), 72, 76, C.wood); legs(P, -w / 2, y0, w / 2, y1, 72, 5, C.woodDark);
    },
    rtable(P, w, h) {
      const R0 = Math.min(w, h) / 2, c = Math.min(40, R0 * .42), rt = R0 - c * .55, n = Math.max(3, Math.min(8, Math.round(2 * Math.PI * rt / 60))), cw = Math.min(42, 2 * Math.PI * rt / n * .7);
      for (let i = 0; i < n; i++) { const a = i * 360 / n; chair((pts, z0, z1, col) => P(pts.map(p => rot(p, a)), z0, z1, col), -cw / 2, -R0, cw / 2, -R0 + c, true); }
      P(ellipse(0, 0, rt, rt, 28), 72, 76, C.wood); P(ellipse(0, 0, 7, 7, 12), 0, 72, C.woodDark); P(ellipse(0, 0, rt * .45, rt * .45, 18), 0, 3, C.woodDark);
    },
    desk(P, w, h) {
      const dh = h * .64, cw = Math.min(46, w * .4), ch = Math.min(44, h * .42), cy0 = -h / 2 + dh - ch * .35;
      P(rect(-w / 2, -h / 2, w / 2, -h / 2 + dh), 72, 76, C.wood);
      P(rect(-w / 2, -h / 2, -w / 2 + 3, -h / 2 + dh), 0, 72, C.wood); P(rect(w / 2 - 3, -h / 2, w / 2, -h / 2 + dh), 0, 72, C.wood);
      chair(P, -cw / 2, cy0, cw / 2, cy0 + ch, false);
    },
    wardrobe(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 200, C.wood); },
    box(P, w, h) { P(rect(-w / 2, -h / 2, w / 2, h / 2), 0, 45, C.box); },
  };

  /* ---------- the scene ---------- */
  function buildScene(model, o) {
    const t0 = performance.now();
    const defH = clamp(+model.defaultHeight || 250, 50, 2000);
    const solid = new Mesh(), glass = new Mesh(), lines = new Mesh(), labels = [];
    let skipped = 0, minH = Infinity, maxH = 0;
    const P0 = (pts, z0, z1, col, top) => { if (!prism(solid, pts, z0, z1, col, top)) skipped++; };
    const num = (v, d) => (v === null || v === undefined || !isFinite(+v)) ? d : +v;
    for (const w of model.walls || []) for (const part of w.parts || []) {
      const hh = clamp(num(part.h, defH), 50, 2000); minH = Math.min(minH, hh); maxH = Math.max(maxH, hh);
      P0(part.poly, 0, hh, C.wall, C.wallTop);
    }
    for (const op of model.openings || []) {
      const q = op.quad, c = op.center, u = op.u, n = op.n;
      if (!q || q.length !== 4 || !c || !u || !n || !(op.width > 0)) { skipped++; continue; }
      const wallH = clamp(num(op.wallH, defH), 50, 2000);
      if (op.type === 'window') {
        const sill = clamp(num(op.sill, 90), 0, wallH), top = clamp(num(op.head, sill + 120), sill, wallH);
        if (sill > .5) P0(q, 0, sill, C.wall, C.sill);
        if (top < wallH - .5) P0(q, top, wallH, C.wall, C.wallTop);
        if (top - sill > .5) {
          const W = op.width / 2 - 1.5, a = [c.x - u.x * W, sill, c.y - u.y * W], b = [c.x + u.x * W, sill, c.y + u.y * W];
          glass.quad(a, b, [b[0], top, b[2]], [a[0], top, a[2]], [n.x, 0, n.y], C.glass);
        }
      } else {
        const top = clamp(num(op.head, Math.min(210, wallH * .86)), 10, wallH);   // head height of doors and openings
        if (top < wallH - .5) P0(q, top, wallH, C.wall, C.wallTop);
        const W = op.width, t = (op.thickness || 10) / 2, fx = op.hinge ? -1 : 1, fy = op.swing ? -1 : 1;
        const map = p => ({x: c.x + u.x * p.x * fx + n.x * p.y * fy, y: c.y + u.y * p.x * fx + n.y * p.y * fy});
        const leaf = (x0, y0, x1, y1, col, mesh) => { if (!prism(mesh || solid, rect(x0, y0, x1, y1).map(map), 1, top - 1, col)) skipped++; };
        if (op.type === 'door') leaf(-W / 2, -t - W * .97, -W / 2 + 4, -t, C.door);
        else if (op.type === 'door2') { const r = W / 2 * .97; leaf(-W / 2, -t - r, -W / 2 + 4, -t, C.door); leaf(W / 2 - 4, -t - r, W / 2, -t, C.door); }
        else if (op.type === 'slide') { const pw = W * .56, ph = Math.max(2, t * .44); leaf(-W / 2, -ph - .5, -W / 2 + pw, -.5, C.glass, glass); leaf(W / 2 - pw, .5, W / 2, .5 + ph, C.glass, glass); }
      }
    }
    for (const r of model.rooms || []) {
      if (!flat(solid, r.pts, .6, floorColor(r.color))) { skipped++; continue; }
      if (r.label && isFinite(r.label.x) && isFinite(r.label.y)) labels.push({name: String(r.name || ''), x: r.label.x, y: r.label.y});
    }
    for (const it of model.items || []) {
      const f = ITEM[it.type];
      if (!f || !(it.w > 0 && it.h > 0 && isFinite(it.x) && isFinite(it.y))) { skipped++; continue; }
      if (!o.furniture && (it.cat === 2 || it.cat === 3)) continue;
      if (o.people === false && it.cat === 4) continue;
      const r = (+it.rot || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), fl = it.flip ? -1 : 1;
      const xf = p => ({x: it.x + p.x * fl * cs - p.y * sn, y: it.y + p.x * fl * sn + p.y * cs});
      try { f((pts, z0, z1, col, top) => P0(pts.map(xf), z0, z1, col, top), it.w, it.h, it, clamp(num(it.ceil, defH), 50, 2000)); } catch (e) { skipped++; }
    }
    // extent of what was built, then the ground and a 1 m (or 3 ft) grid around it
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < solid.v.length; i += 10) { const x = solid.v[i], z = solid.v[i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const empty = !isFinite(x0);
    if (empty) { x0 = -300; x1 = 300; z0 = -300; z1 = 300; }
    const size = Math.max(x1 - x0, z1 - z0, 100), pad = Math.max(300, size * .6);
    const gx0 = x0 - pad, gx1 = x1 + pad, gz0 = z0 - pad, gz1 = z1 + pad;
    solid.quad([gx0, 0, gz0], [gx1, 0, gz0], [gx1, 0, gz1], [gx0, 0, gz1], [0, 1, 0], C.ground);
    const step = o.units === 'ftin' || o.units === 'in' ? 91.44 : 100;
    for (let x = Math.ceil(gx0 / step) * step; x <= gx1; x += step) { lines.vert([x, .3, gz0], [0, 1, 0], C.grid); lines.vert([x, .3, gz1], [0, 1, 0], C.grid); }
    for (let z = Math.ceil(gz0 / step) * step; z <= gz1; z += step) { lines.vert([gx0, .3, z], [0, 1, 0], C.grid); lines.vert([gx1, .3, z], [0, 1, 0], C.grid); }
    const pack = m => { const a = new Float32Array(m.v); let bad = 0; for (let i = 0; i < a.length; i++) if (!isFinite(a[i])) { a[i] = 0; bad++; } return {data: a, count: m.count, bad}; };
    const S = pack(solid), G = pack(glass), L = pack(lines);
    const H = maxH || defH;
    return {solid: S, glass: G, lines: L, labels, empty, H, minH: isFinite(minH) ? minH : H, skipped, nonFinite: S.bad + G.bad + L.bad,
      box: {x0, x1, z0, z1, y0: 0, y1: H}, buildMs: performance.now() - t0};
  }

  /* ---------- matrices (column-major, like WebGL expects) ---------- */
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function lookAt(e, t, up) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2], l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
  }

  const VS = 'attribute vec3 aP;attribute vec3 aN;attribute vec4 aC;uniform mat4 uM;varying vec3 vN;varying vec4 vC;' +
    'void main(){vN=aN;vC=aC;gl_Position=uM*vec4(aP,1.0);}';
  const FS = 'precision mediump float;varying vec3 vN;varying vec4 vC;uniform vec3 uL;uniform float uFlat;uniform float uA;' +
    'void main(){vec3 n=normalize(vN);float d=max(dot(n,uL),0.0);float lit=mix(min(1.0,0.6+0.3*d+0.12*(0.5+0.5*n.y)+uA),1.0,uFlat);gl_FragColor=vec4(vC.rgb*lit,vC.a);}';
  const LIGHT = (() => { const v = [0.38, 0.86, 0.34], l = Math.hypot(...v); return v.map(x => x / l); })();
  const FOV = 45 * Math.PI / 180;
  const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  function create(host, model, options) {
    const o = Object.assign({furniture: true, people: true, labels: true, units: 'm'}, options || {});
    const canvas = document.createElement('canvas');
    canvas.className = 'v3dcanvas'; canvas.tabIndex = -1; canvas.setAttribute('aria-label', '3D preview of the floor plan');
    const labelBox = document.createElement('div'); labelBox.className = 'v3dlabels';
    const spot = document.createElement('div'); spot.className = 'v3dspot'; spot.hidden = true;   // where a click would walk to
    host.append(canvas, labelBox, spot);
    const attrs = {antialias: true, alpha: false, depth: true, preserveDrawingBuffer: false, premultipliedAlpha: true};
    let gl = null;
    try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e) { gl = null; }
    if (!gl) { canvas.remove(); labelBox.remove(); spot.remove(); const err = new Error('WebGL is not available in this browser.'); err.code = 'nowebgl'; throw err; }
    counters.created++; counters.contextsCreated++;

    let prog = null, loc = null, bufs = {}, scene = null, cam = null, destroyed = false, failed = false, lost = false, raf = 0;
    let labelEls = [], fitted = false, cssW = 0, cssH = 0, lastMVP = null, lastView = null;
    const ptrs = new Map(); let mode = null, pinch0 = null, press = null, lastTap = null, gesture = null;
    /* two ways to look: the overview orbits a point ('orbit'); walking puts your eyes 1.6 m above the floor ('walk') */
    let nav = 'orbit', walk = null, savedCam = null, fly = null, tween = null, loopRaf = 0, lastT = 0, inTick = false;
    let blockers = [], rooms2 = [];
    const keys = new Set();

    const fail = err => { if (failed || destroyed) return; failed = true; counters.errors++; try { console.warn('3D view stopped:', err); } catch (_) {} try { o.onError && o.onError(err); } catch (_) {} };
    const guard = fn => function () { if (destroyed || failed) return; try { return fn.apply(this, arguments); } catch (err) { fail(err); } };
    const tell = m => { try { o.onMode && o.onMode(m); } catch (_) {} };

    function shader(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('3D shader failed: ' + gl.getShaderInfoLog(s));
      return s;
    }
    function initGL() {
      const vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS);
      prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('3D program failed: ' + gl.getProgramInfoLog(prog));
      loc = {P: gl.getAttribLocation(prog, 'aP'), N: gl.getAttribLocation(prog, 'aN'), C: gl.getAttribLocation(prog, 'aC'),
        M: gl.getUniformLocation(prog, 'uM'), L: gl.getUniformLocation(prog, 'uL'), F: gl.getUniformLocation(prog, 'uFlat'), A: gl.getUniformLocation(prog, 'uA')};
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    }
    function freeBuffers() { for (const k in bufs) { if (bufs[k] && !lost) gl.deleteBuffer(bufs[k]); } bufs = {}; }
    function upload() {
      freeBuffers();
      for (const k of ['solid', 'glass', 'lines']) {
        if (!scene[k].count) continue;
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, scene[k].data, gl.STATIC_DRAW); bufs[k] = b;
      }
    }
    const measure = (() => { const c = document.createElement('canvas').getContext('2d'); if (c) c.font = '650 12.5px ' + FONT; return t => (c ? c.measureText(t).width : t.length * 7.4) + 16; })();
    function setLabels() {
      labelBox.textContent = ''; labelEls = [];
      for (const l of scene.labels) { const el = document.createElement('div'); el.className = 'v3dlabel'; el.textContent = l.name; labelBox.append(el); labelEls.push(el); l.w = measure(l.name); l.vis = null; }
      labelBox.style.display = o.labels ? '' : 'none';
    }
    /* what you can't walk through: walls, and windows (doorways and openings stay open) */
    function buildBlockers() {
      blockers = []; rooms2 = [];
      const addPoly = pts => {
        const q = (pts || []).filter(p => p && isFinite(p.x) && isFinite(p.y)).map(p => ({x: +p.x, y: +p.y})); if (q.length < 3) return;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of q) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
        blockers.push({q, x0, x1, y0, y1});
      };
      for (const w of model.walls || []) for (const part of w.parts || []) addPoly(part.poly);
      for (const op of model.openings || []) if (op.type === 'window') addPoly(op.quad);
      for (const r of model.rooms || []) {
        const pts = (r.pts || []).filter(p => p && isFinite(p.x) && isFinite(p.y)); if (pts.length < 3) continue;
        rooms2.push({pts, area: Math.abs(area2(pts)), label: r.label && isFinite(r.label.x) && isFinite(r.label.y) ? r.label : null});
      }
    }
    function rebuild(m) {
      model = m; scene = buildScene(model, o); if (!lost) upload(); setLabels(); buildBlockers();
      if (!fitted && !scene.empty) fit();
      requestDraw();
    }

    /* ----- small vector helpers ----- */
    const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm3 = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const lookDir = (yaw, pitch) => [-Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)];

    /* ----- cameras ----- */
    const EYE = 160, BODY = 28, WALK_FOV_H = 80 * Math.PI / 180, WALK_AMB = .14;
    function radius() { const b = scene.box; return .5 * Math.hypot(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0) || 300; }
    function limits() { const r = Math.max(radius(), 80); return {min: 30, max: r * 12 + 600, r}; }
    const eyeOf = c => { const k = Math.cos(c.pitch); return [c.t[0] + c.dist * k * Math.sin(c.yaw), c.t[1] + c.dist * Math.sin(c.pitch), c.t[2] + c.dist * k * Math.cos(c.yaw)]; };
    const eye = () => eyeOf(cam);
    const aspect = () => Math.max(.3, (cssW || 800) / (cssH || 600));
    const walkFov = () => clamp(2 * Math.atan(Math.tan(WALK_FOV_H / 2) / aspect()), 50 * Math.PI / 180, 75 * Math.PI / 180);
    const orbitView = (c = cam) => ({e: eyeOf(c), t: c.t.slice(), fov: FOV, amb: 0});
    const walkView = (w = walk) => { const d = lookDir(w.yaw, w.pitch), e = [w.x, w.h, w.z]; return {e, t: [e[0] + d[0] * 100, e[1] + d[1] * 100, e[2] + d[2] * 100], fov: walkFov(), amb: WALK_AMB}; };
    const viewNow = () => fly ? fly.cur : nav === 'walk' && walk ? walkView() : orbitView();
    /* frame the whole model: the closest distance at which all eight corners of its box fit on screen */
    function fitCam(yaw = .62, pitch = .78) {
      const b = scene.box, t = [(b.x0 + b.x1) / 2, b.y1 * .18, (b.z0 + b.z1) / 2], ty = Math.tan(FOV / 2), tx = ty * aspect(), corners = [];
      for (const x of [b.x0, b.x1]) for (const y of [0, b.y1]) for (const z of [b.z0, b.z1]) corners.push([x, y, z]);
      const fits = d => {
        const e = eyeOf({yaw, pitch, dist: d, t}), f = norm3(sub3(t, e)), r = norm3(cross3(f, [0, 1, 0])), u = cross3(r, f);
        return corners.every(p => { const v = sub3(p, e), z = dot3(v, f); return z > 5 && Math.abs(dot3(v, r) / z) <= tx * .9 && Math.abs(dot3(v, u) / z) <= ty * .8; });
      };
      let lo = 20, hi = Math.max(radius(), 80) * 40;
      for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
      return {yaw, pitch, dist: hi, t};
    }
    function fit(yaw, pitch) { cam = fitCam(yaw, pitch); fitted = !scene.empty; requestDraw(); }
    function clampTarget() {
      const b = scene.box, L = limits();
      cam.t[0] = clamp(cam.t[0], b.x0 - L.r, b.x1 + L.r); cam.t[2] = clamp(cam.t[2], b.z0 - L.r, b.z1 + L.r); cam.t[1] = clamp(cam.t[1], 0, b.y1);
    }
    /* the ray through a point on screen, and where it meets a level plane */
    function rayAt(sx, sy, v = lastView || viewNow()) {
      const e = v.e, f = norm3(sub3(v.t, e)), r = norm3(cross3(f, [0, 1, 0])), u = cross3(r, f), ty = Math.tan(v.fov / 2), tx = ty * aspect();
      const nx = (sx / (cssW || 1)) * 2 - 1, ny = 1 - (sy / (cssH || 1)) * 2;
      return {o: e, d: norm3([f[0] + r[0] * nx * tx + u[0] * ny * ty, f[1] + r[1] * nx * tx + u[1] * ny * ty, f[2] + r[2] * nx * tx + u[2] * ny * ty])};
    }
    function planeAt(sx, sy, y = 0, v) {
      if (!isFinite(sx) || !isFinite(sy)) return null;
      const ray = rayAt(sx, sy, v); if (Math.abs(ray.d[1]) < 1e-5) return null;
      const t = (y - ray.o[1]) / ray.d[1]; return t > 0 ? [ray.o[0] + ray.d[0] * t, y, ray.o[2] + ray.d[2] * t] : null;
    }

    function resize() {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight), dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = w; cssH = h;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    }
    function draw() {
      if (destroyed || lost || !scene || !cam) return;
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(C.bg[0], C.bg[1], C.bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const v = viewNow(), r = limits().r, close = nav === 'walk' || !!fly;
      const near = close ? 4 : clamp(cam.dist * .02, 1, 200), far = (close ? 0 : cam.dist) + r * 8 + 5000;
      const mvp = mul(perspective(v.fov, cssW / cssH, near, far), lookAt(v.e, v.t, [0, 1, 0])); lastMVP = mvp; lastView = v;
      gl.useProgram(prog); gl.uniformMatrix4fv(loc.M, false, mvp); gl.uniform3fv(loc.L, LIGHT); gl.uniform1f(loc.A, v.amb || 0);   // rooms are lit a little brighter from inside
      const bind = b => {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.enableVertexAttribArray(loc.P); gl.vertexAttribPointer(loc.P, 3, gl.FLOAT, false, 40, 0);
        gl.enableVertexAttribArray(loc.N); gl.vertexAttribPointer(loc.N, 3, gl.FLOAT, false, 40, 12);
        gl.enableVertexAttribArray(loc.C); gl.vertexAttribPointer(loc.C, 4, gl.FLOAT, false, 40, 24);
      };
      gl.disable(gl.BLEND); gl.depthMask(true);
      if (bufs.solid) { gl.uniform1f(loc.F, 0); bind(bufs.solid); gl.drawArrays(gl.TRIANGLES, 0, scene.solid.count); }
      if (bufs.lines) { gl.uniform1f(loc.F, 1); bind(bufs.lines); gl.drawArrays(gl.LINES, 0, scene.lines.count); }
      if (bufs.glass) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        gl.uniform1f(loc.F, 0); bind(bufs.glass); gl.drawArrays(gl.TRIANGLES, 0, scene.glass.count);
        gl.depthMask(true); gl.disable(gl.BLEND);
      }
      placeLabels();
    }
    function project(x, y, z) {
      const m = lastMVP; if (!m) return null;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-6) return null;
      return {x: (cx / cw * .5 + .5) * cssW, y: (1 - (cy / cw * .5 + .5)) * cssH};
    }
    function toScreen(x, y, z) {
      const p = project(x, y, z); if (!p) return null;
      return p.x < -40 || p.y < -20 || p.x > cssW + 40 || p.y > cssH + 20 ? null : p;
    }
    /* room names: hide any that would overlap one already shown (greedy, with a coarse grid to keep it fast) */
    function placeLabels() {
      if (!o.labels) return;
      const cell = 80, grid = new Map(), key = (i, j) => i + ',' + j;
      const cells = r => { const out = []; for (let i = Math.floor(r[0] / cell); i <= Math.floor(r[2] / cell); i++) for (let j = Math.floor(r[1] / cell); j <= Math.floor(r[3] / cell); j++) out.push(key(i, j)); return out; };
      scene.labels.forEach((l, i) => {
        const el = labelEls[i]; if (!el) return;
        const p = toScreen(l.x, 4, l.y); l.vis = null;
        if (!p) { el.style.display = 'none'; return; }
        const r = [p.x - l.w / 2 - 3, p.y - 12, p.x + l.w / 2 + 3, p.y + 12], ks = cells(r);
        const clash = ks.some(k => (grid.get(k) || []).some(q => q[0] < r[2] && q[2] > r[0] && q[1] < r[3] && q[3] > r[1]));
        if (clash) { el.style.display = 'none'; return; }
        ks.forEach(k => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(r); });
        l.vis = p; el.style.display = ''; el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -50%)`;
      });
    }
    function requestDraw() { if (!raf && !destroyed && !inTick) raf = requestAnimationFrame(guard(() => { raf = 0; draw(); })); }

    /* ----- animation: one short tween at a time, plus walking while keys are held ----- */
    function kick() { if (!loopRaf && !destroyed) { lastT = performance.now(); loopRaf = requestAnimationFrame(guard(tick)); } }
    function startTween(ms, step, done) { tween = {t0: performance.now(), ms: Math.max(1, ms), step, done}; kick(); }
    function settle() {   // in the overview, any new input jumps a glide (zoom, reset, leaving Walk) to its end
      const tw = tween; if (!tw || nav !== 'orbit') return;
      tween = null; inTick = true; try { tw.step(1); tw.done && tw.done(); } finally { inTick = false; } requestDraw();
    }
    function tick(t) {
      loopRaf = 0; const now = t || performance.now(), dt = clamp((now - lastT) / 1000, 0, .05); lastT = now;
      let more = false; inTick = true;
      try {
        if (tween) {
          const tw = tween, k = clamp((now - tw.t0) / tw.ms, 0, 1), ease = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          tw.step(ease);
          if (k >= 1) { if (tween === tw) tween = null; tw.done && tw.done(); } else more = true;
        }
        if (keys.size && keyMove(dt)) more = true;
      } finally { inTick = false; }
      draw();
      if ((more || tween) && !loopRaf) loopRaf = requestAnimationFrame(guard(tick));
    }
    function flyTo(from, to, ms, done) {   // glide the eye and the point looked at, e.g. between the overview and walking
      fly = {cur: from};
      startTween(ms, k => { const L = (a, b) => a + (b - a) * k; fly = {cur: {e: from.e.map((v, i) => L(v, to.e[i])), t: from.t.map((v, i) => L(v, to.t[i])), fov: L(from.fov, to.fov), amb: L(from.amb || 0, to.amb || 0)}}; },
        () => { fly = null; done && done(); requestDraw(); });
    }

    /* ----- overview: orbit, zoom toward the pointer, drag the ground ----- */
    function orbit(dx, dy) { cam.yaw -= dx * .0085; cam.pitch = clamp(cam.pitch + dy * .0085, .06, 1.55); requestDraw(); }
    function zoomAt(k, sx, sy) {   // the point under (sx, sy) stays where it is on screen
      const L = limits(), nd = clamp(cam.dist * k, L.min, L.max), kk = nd / cam.dist; if (!isFinite(kk) || Math.abs(kk - 1) < 1e-5) return;
      const p = sx == null ? null : planeAt(sx, sy, cam.t[1], orbitView());
      if (p && Math.hypot(p[0] - cam.t[0], p[2] - cam.t[2]) < L.r * 3) { cam.t[0] = p[0] + (cam.t[0] - p[0]) * kk; cam.t[2] = p[2] + (cam.t[2] - p[2]) * kk; }
      cam.dist = nd; clampTarget(); requestDraw();
    }
    function zoomToward(sx, sy, k = .45) {   // double-click or double-tap: glide in on that spot
      const from = {t: cam.t.slice(), dist: cam.dist}; zoomAt(k, sx, sy);
      const to = {t: cam.t.slice(), dist: cam.dist}; cam.t = from.t.slice(); cam.dist = from.dist;
      startTween(380, e => { cam.t = from.t.map((v, i) => v + (to.t[i] - v) * e); cam.dist = from.dist * Math.pow(to.dist / from.dist, e); });
    }
    function panDrag(p0, p1) {   // the ground under p0 follows the pointer to p1
      const v = orbitView(), L = limits(), a = planeAt(p0.x, p0.y, cam.t[1], v), b = planeAt(p1.x, p1.y, cam.t[1], v);
      if (a && b && Math.hypot(a[0] - b[0], a[2] - b[2]) < L.r) { cam.t[0] += a[0] - b[0]; cam.t[2] += a[2] - b[2]; }
      else {   // near the horizon: move by screen distance instead
        const s = 2 * cam.dist * Math.tan(FOV / 2) / Math.max(1, cssH), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), dx = p1.x - p0.x, dy = p1.y - p0.y;
        cam.t[0] -= (cy * dx + sy * dy) * s; cam.t[2] -= (-sy * dx + cy * dy) * s;
      }
      clampTarget(); requestDraw();
    }

    /* ----- walking: tap the floor to go there, drag to look, keys to move; walls and windows stop you ----- */
    function collides(x, z, r = BODY) {
      for (const b of blockers) {
        if (x < b.x0 - r || x > b.x1 + r || z < b.y0 - r || z > b.y1 + r) continue;
        const q = b.q; let inside = false;
        for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
          const a = q[i], c = q[j];
          if ((a.y > z) !== (c.y > z) && x < (c.x - a.x) * (z - a.y) / (c.y - a.y) + a.x) inside = !inside;
          const ex = c.x - a.x, ez = c.y - a.y, L2 = ex * ex + ez * ez, t = L2 ? clamp(((x - a.x) * ex + (z - a.y) * ez) / L2, 0, 1) : 0;
          const dx = x - (a.x + ex * t), dz = z - (a.y + ez * t); if (dx * dx + dz * dz < r * r) return true;
        }
        if (inside) return true;
      }
      return false;
    }
    const inRoom = (x, z) => rooms2.some(r => { let ins = false; const q = r.pts; for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i].y > z) !== (q[j].y > z) && x < (q[j].x - q[i].x) * (z - q[i].y) / (q[j].y - q[i].y) + q[i].x) ins = !ins; return ins; });
    function freeSpot(p) {   // nearest place you could stand
      if (!collides(p.x, p.z)) return p;
      for (let rr = 10; rr <= 200; rr += 10) for (let a = 0; a < 16; a++) { const x = p.x + rr * Math.cos(a * Math.PI / 8), z = p.z + rr * Math.sin(a * Math.PI / 8); if (!collides(x, z)) return {x, z}; }
      return p;
    }
    function stepWalk(dx, dz) {   // move in small steps so you can't pass through a thin wall; slide along walls you hit
      if (!walk) return false;
      const b = scene.box, pad = 600, len = Math.hypot(dx, dz), n = Math.max(1, Math.ceil(len / 6)), sx = dx / n, sz = dz / n;
      const stuck = collides(walk.x, walk.z);
      const go = (x, z) => { x = clamp(x, b.x0 - pad, b.x1 + pad); z = clamp(z, b.z0 - pad, b.z1 + pad); if (stuck || !collides(x, z)) { walk.x = x; walk.z = z; return true; } return false; };
      let moved = false;
      for (let i = 0; i < n; i++) {
        if (go(walk.x + sx, walk.z + sz) || (Math.abs(sx) > .01 && go(walk.x + sx, walk.z)) || (Math.abs(sz) > .01 && go(walk.x, walk.z + sz))) moved = true; else break;
      }
      requestDraw(); return moved;
    }
    function stepForward(cm) { if (!walk) return; const f = lookDir(walk.yaw, 0); stepWalk(f[0] * cm, f[2] * cm); }
    function look(dx, dy) { const k = walkFov() / Math.max(1, cssH); walk.yaw += dx * k; walk.pitch = clamp(walk.pitch - dy * k, -1.25, 1.25); requestDraw(); }
    function walkToward(sx, sy) {
      if (!walk) return;
      const ray = rayAt(sx, sy, walkView()), g = planeAt(sx, sy, 0, walkView());
      let tx, tz;
      if (g && Math.hypot(g[0] - walk.x, g[2] - walk.z) < 3000) { tx = g[0]; tz = g[2]; }
      else { const hl = Math.hypot(ray.d[0], ray.d[2]) || 1; tx = walk.x + ray.d[0] / hl * 400; tz = walk.z + ray.d[2] / hl * 400; }
      const dx = tx - walk.x, dz = tz - walk.z, L = Math.hypot(dx, dz); if (L < 5) return;
      let reach = 0;
      for (let s = 4; s <= L + .01; s += 4) { if (collides(walk.x + dx * s / L, walk.z + dz * s / L)) break; reach = Math.min(s, L); }
      if (reach >= L - 4 && !collides(tx, tz)) reach = L;
      if (reach < 6) return;
      const x0 = walk.x, z0 = walk.z, x1 = x0 + dx * reach / L, z1 = z0 + dz * reach / L;
      startTween(clamp(reach / 280 * 1000, 250, 1700), e => { walk.x = x0 + (x1 - x0) * e; walk.z = z0 + (z1 - z0) * e; });
    }
    function keyMove(dt) {
      if (nav !== 'walk' || !walk || fly) return false;
      const K = k => keys.has(k);
      const f = (K('w') || K('arrowup') ? 1 : 0) - (K('s') || K('arrowdown') ? 1 : 0), s = (K('d') ? 1 : 0) - (K('a') ? 1 : 0);
      const turn = (K('arrowleft') || K('q') ? 1 : 0) - (K('arrowright') || K('e') ? 1 : 0);
      if (turn) walk.yaw += turn * 1.7 * dt;
      if (f || s) {
        const sp = (K('shift') ? 320 : 150) * dt, fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw), l = Math.hypot(f, s);
        stepWalk((fx * f - fz * s) / l * sp, (fz * f + fx * s) / l * sp);
      }
      return !!(f || s || turn);
    }
    function updateSpot(sx, sy) {
      if (nav !== 'walk' || fly || ptrs.size || !walk || !lastMVP) { spot.hidden = true; return; }
      const p = planeAt(sx, sy, 0, walkView()); if (!p || Math.hypot(p[0] - walk.x, p[2] - walk.z) > 2500) { spot.hidden = true; return; }
      const c = project(p[0], .5, p[2]), f = lookDir(walk.yaw, 0), q = project(p[0] - f[2] * BODY * 1.3, .5, p[2] + f[0] * BODY * 1.3);
      if (!c || !q) { spot.hidden = true; return; }
      const r = clamp(Math.hypot(q.x - c.x, q.y - c.y), 6, 90), squash = clamp(Math.abs(rayAt(sx, sy, walkView()).d[1]), .12, 1);
      spot.style.width = spot.style.height = Math.round(2 * r) + 'px';
      spot.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px) translate(-50%, -50%) scale(1, ${squash.toFixed(3)})`;
      spot.hidden = false;
    }
    function enterWalk() {
      if (nav === 'walk' || !scene || scene.empty || fly) return false;
      const from = viewNow();
      savedCam = {yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, t: cam.t.slice()};
      // stand where the middle of the screen meets the floor if that's in a room, otherwise in the biggest room
      const c = planeAt(cssW / 2, cssH / 2, 0, orbitView());
      let at = c && inRoom(c[0], c[2]) ? {x: c[0], z: c[2]} : null;
      if (!at) { const big = rooms2.slice().sort((a, b) => b.area - a.area)[0]; if (big && big.label) at = {x: big.label.x, z: big.label.y}; }
      if (!at) { const b = scene.box; at = {x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2}; }
      at = freeSpot(at);
      walk = {x: at.x, z: at.z, h: Math.min(EYE, Math.max(60, (scene.minH || 250) - 25)), yaw: cam.yaw, pitch: .05};
      nav = 'walk'; tell('walk');
      flyTo(from, walkView(), 750);
      return true;
    }
    function exitWalk(how) {   // back to the overview you left, the whole plan ('fit'), or the view from above ('top')
      if (nav !== 'walk') return false;
      const from = viewNow(), target = how === 'top' ? fitCam(0, 1.55) : how === 'fit' || !savedCam ? fitCam() : savedCam;
      keys.clear(); spot.hidden = true; nav = 'orbit'; cam = target; tell('orbit');
      flyTo(from, orbitView(target), 650);
      return true;
    }
    function setMode(m) { return m === 'walk' ? enterWalk() : exitWalk(); }

    /* ----- input ----- */
    const at = e => { const r = canvas.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
    const onDown = guard(e => {
      canvas.focus({preventScroll: true});
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      const p = at(e); ptrs.set(e.pointerId, p); spot.hidden = true;
      settle();
      if (ptrs.size === 1) {
        press = {id: e.pointerId, x: p.x, y: p.y, t: performance.now(), moved: 0, type: e.pointerType, button: e.button};
        mode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'drag';
      } else if (ptrs.size === 2) {
        press = null; const [a, b] = [...ptrs.values()]; mode = 'pinch';
        pinch0 = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, dist: cam.dist, mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}};
      }
      e.preventDefault();
    });
    const onMove = guard(e => {
      const p = at(e);
      if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse') updateSpot(p.x, p.y); return; }
      const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, p);
      if (press && press.id === e.pointerId) press.moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
      if (fly) return;
      if (mode === 'drag' || (mode === 'pan' && nav === 'walk')) { if (nav === 'walk') look(p.x - prev.x, p.y - prev.y); else orbit(p.x - prev.x, p.y - prev.y); }
      else if (mode === 'pan') panDrag(prev, p);
      else if (mode === 'pinch' && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
        if (nav === 'walk') { stepForward((d - pinch0.d) * 1.5); pinch0.d = d; }
        else { zoomAt(pinch0.dist * pinch0.d / d / cam.dist, mid.x, mid.y); panDrag(pinch0.mid, mid); }
        pinch0.mid = mid;
      }
    });
    function tap(x, y) {
      const now = performance.now(), dbl = !!lastTap && now - lastTap.t < 400 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30;
      lastTap = dbl ? null : {t: now, x, y};
      if (nav === 'walk') walkToward(x, y); else if (dbl) zoomToward(x, y);
    }
    const onUp = guard(e => {
      const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
      const pr = press;
      if (pr && pr.id === e.pointerId && e.type === 'pointerup' && !pr.button && pr.moved < 8 && performance.now() - pr.t < 600 && p && !fly) tap(p.x, p.y);
      if (!ptrs.size) { mode = null; press = null; } else if (ptrs.size === 1) { mode = 'drag'; press = null; }
    });
    const onLeave = () => { spot.hidden = true; };
    const onWheel = guard(e => {
      e.preventDefault(); settle(); if (fly) return;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1), p = at(e);
      if (nav === 'walk') { stepForward(clamp(-dy * (e.ctrlKey ? 2 : .5), -60, 60)); updateSpot(p.x, p.y); return; }
      zoomAt(Math.exp(dy * (e.ctrlKey ? .01 : .0012)), p.x, p.y);
    });
    /* Safari on a Mac sends trackpad pinches as gesture events (other browsers send ctrl + wheel, handled above) */
    const onGestureStart = guard(e => { e.preventDefault(); gesture = ptrs.size ? null : {scale: e.scale || 1}; });
    const onGestureChange = guard(e => {
      e.preventDefault(); settle(); if (!gesture || ptrs.size || fly) return;
      const s = e.scale || 1, r = s / (gesture.scale || 1); gesture.scale = s; if (!isFinite(r) || r <= 0) return;
      const p = at(e), x = isFinite(p.x) ? p.x : cssW / 2, y = isFinite(p.y) ? p.y : cssH / 2;
      if (nav === 'walk') stepForward(clamp((r - 1) * 400, -60, 60)); else zoomAt(1 / r, x, y);
    });
    const onGestureEnd = e => { e.preventDefault(); gesture = null; };
    const onMenu = e => e.preventDefault();
    const MOVE = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);
    const onKey = guard(e => {
      if (o.isBlocked && o.isBlocked(e)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'escape') { e.preventDefault(); if (nav === 'walk') exitWalk(); else if (o.onClose) o.onClose(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      settle(); if (fly) return;
      if (nav === 'walk') {
        if (MOVE.has(k)) { keys.add(k); kick(); if (k !== 'shift') e.preventDefault(); }
        else if (k === '0') { e.preventDefault(); exitWalk('fit'); }
        return;
      }
      const c = {x: cssW / 2, y: cssH / 2}, S = 70; let used = true;
      if (k === 'arrowleft') orbit(-14, 0); else if (k === 'arrowright') orbit(14, 0);
      else if (k === 'arrowup') orbit(0, -10); else if (k === 'arrowdown') orbit(0, 10);
      else if (k === 'w') panDrag(c, {x: c.x, y: c.y + S}); else if (k === 's') panDrag(c, {x: c.x, y: c.y - S});
      else if (k === 'a') panDrag(c, {x: c.x + S, y: c.y}); else if (k === 'd') panDrag(c, {x: c.x - S, y: c.y});
      else if (k === '+' || k === '=') zoomAt(.85); else if (k === '-' || k === '_') zoomAt(1 / .85);
      else if (k === '0') fit();
      else used = false;
      if (used) e.preventDefault();
    });
    const onKeyUp = e => { keys.delete((e.key || '').toLowerCase()); };
    const onBlur = () => keys.clear();
    const onLost = e => { e.preventDefault(); lost = true; bufs = {}; prog = null; try { o.onLost && o.onLost(); } catch (_) {} };
    const onRestored = guard(() => { lost = false; initGL(); upload(); try { o.onRestored && o.onRestored(); } catch (_) {} requestDraw(); });

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, {passive: false});
    canvas.addEventListener('gesturestart', onGestureStart, {passive: false});
    canvas.addEventListener('gesturechange', onGestureChange, {passive: false});
    canvas.addEventListener('gestureend', onGestureEnd, {passive: false});
    canvas.addEventListener('contextmenu', onMenu);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(guard(() => requestDraw())) : null;
    const onResize = guard(() => requestDraw());
    if (ro) ro.observe(host); else window.addEventListener('resize', onResize);

    function restore(v) {   // the view someone had last time this drawing was open in 3D
      if (!v || !v.cam || !Array.isArray(v.cam.t) || ![v.cam.yaw, v.cam.pitch, v.cam.dist, ...v.cam.t].every(isFinite)) return;
      const L = limits();
      cam = {yaw: v.cam.yaw, pitch: clamp(v.cam.pitch, .06, 1.55), dist: clamp(v.cam.dist, L.min, L.max), t: v.cam.t.slice(0, 3)}; clampTarget();
      savedCam = v.saved && Array.isArray(v.saved.t) ? {yaw: v.saved.yaw, pitch: v.saved.pitch, dist: v.saved.dist, t: v.saved.t.slice(0, 3)} : null;
      if (v.nav === 'walk' && v.walk && [v.walk.x, v.walk.z, v.walk.yaw, v.walk.pitch].every(isFinite) && !scene.empty) {
        const p = freeSpot({x: v.walk.x, z: v.walk.z});
        walk = {x: p.x, z: p.z, h: Math.min(EYE, Math.max(60, (scene.minH || 250) - 25)), yaw: v.walk.yaw, pitch: clamp(v.walk.pitch, -1.25, 1.25)}; nav = 'walk';
      }
      requestDraw();
    }
    try { initGL(); resize(); rebuild(model); if (!cam) fit(); if (o.view) restore(o.view); }
    catch (err) { destroyInternal(); throw err; }

    function destroyInternal() {
      if (destroyed) return; destroyed = true;
      if (raf) cancelAnimationFrame(raf); raf = 0;
      if (loopRaf) cancelAnimationFrame(loopRaf); loopRaf = 0; tween = null; fly = null; keys.clear();
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onMenu);
      canvas.removeEventListener('gesturestart', onGestureStart); canvas.removeEventListener('gesturechange', onGestureChange); canvas.removeEventListener('gestureend', onGestureEnd);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      try { if (!lost) { freeBuffers(); if (prog) gl.deleteProgram(prog); } const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (_) {}
      canvas.width = 1; canvas.height = 1; canvas.remove(); labelBox.remove(); spot.remove();
      counters.destroyed++; counters.contextsReleased++;
    }

    return {
      update(m) { if (!destroyed) rebuild(m); },
      setOptions(p) { if (destroyed) return; Object.assign(o, p || {}); rebuild(model); },
      resetView() { if (destroyed) return; if (!exitWalk('fit')) { const from = viewNow(); cam = fitCam(); flyTo(from, orbitView(), 450); } },
      topView() { if (destroyed) return; if (!exitWalk('top')) { const from = viewNow(); cam = fitCam(0, 1.55); flyTo(from, orbitView(), 450); } },
      setMode(m) { return destroyed ? false : guard(setMode)(m); },
      get mode() { return nav; },
      getView() { return cam ? {nav, cam: {yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, t: cam.t.slice()}, saved: savedCam ? {yaw: savedCam.yaw, pitch: savedCam.pitch, dist: savedCam.dist, t: savedCam.t.slice()} : null, walk: walk ? Object.assign({}, walk) : null} : null; },
      /* PNG data URL of the current view, room names included; synchronous so a tap can share it */
      snapshot() {
        draw();
        const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
        const g = out.getContext('2d'); g.drawImage(canvas, 0, 0);
        if (o.labels) {
          const k = canvas.width / cssW; g.font = `650 ${Math.round(12.5 * k)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          for (const l of scene.labels) {
            const p = l.vis; if (!p) continue;   // the same names that are visible on screen
            const w = g.measureText(l.name).width + 14 * k, hh = 20 * k, x = p.x * k, y = p.y * k;
            g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(x - w / 2, y - hh / 2, w, hh); g.fillStyle = '#24272b'; g.fillText(l.name, x, y + k);
          }
        }
        return out.toDataURL('image/png');
      },
      destroy() { destroyInternal(); },
      get camera() { return cam ? {yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.t.slice(), mode: nav, walk: walk ? Object.assign({}, walk) : null} : null; },
      get destroyed() { return destroyed; },
      /* for tests and troubleshooting */
      stats() {
        return {triangles: scene.solid.count / 3, glassTriangles: scene.glass.count / 3, gridLines: scene.lines.count / 2, labels: scene.labels.length,
          skipped: scene.skipped, nonFinite: scene.nonFinite, empty: scene.empty, wallHeight: scene.H, heights: {min: scene.minH, max: scene.H}, box: Object.assign({}, scene.box),
          buildMs: Math.round(scene.buildMs * 10) / 10, canvas: [canvas.width, canvas.height], lost, mode: nav, blockers: blockers.length, busy: !!(tween || fly || keys.size)};
      },
      debug: {
        project(x, y, z) { draw(); return project(x, y, z); },
        groundAt(sx, sy, y = 0) { return planeAt(sx, sy, y, viewNow()); },
        collides(x, z) { return collides(x, z); },
        inRoom(x, z) { return inRoom(x, z); },
        place(w) { if (walk && w) { Object.assign(walk, w); draw(); } return walk ? Object.assign({}, walk) : null; },
        get busy() { return !!(tween || fly || keys.size); },
      },
      renderNow() { draw(); },
      pixels() {
        draw();
        const W = canvas.width, H = canvas.height, px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const bg = C.bg.map(v => Math.round(v * 255)); let changed = 0, dark = 0, light = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i], g = px[i + 1], b = px[i + 2];
          if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) changed++;
          const y = .3 * r + .59 * g + .11 * b; if (y < 70) dark++; else if (y > 238) light++;
        }
        const n = W * H; return {w: W, h: H, changed: changed / n, dark: dark / n, light: light / n};
      },
    };
  }

  window.FP3D = {api: API, create, counters, internals: {triangulate, prism, flat, buildScene, Mesh, area2, personParts}};
})();
