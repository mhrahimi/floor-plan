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
  const API = 2;
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
  const ITEM = {
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
      if (!o.furniture && it.cat >= 2) continue;
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
  const FS = 'precision mediump float;varying vec3 vN;varying vec4 vC;uniform vec3 uL;uniform float uFlat;' +
    'void main(){vec3 n=normalize(vN);float d=max(dot(n,uL),0.0);float lit=mix(0.6+0.3*d+0.12*(0.5+0.5*n.y),1.0,uFlat);gl_FragColor=vec4(vC.rgb*lit,vC.a);}';
  const LIGHT = (() => { const v = [0.38, 0.86, 0.34], l = Math.hypot(...v); return v.map(x => x / l); })();
  const FOV = 45 * Math.PI / 180;
  const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  function create(host, model, options) {
    const o = Object.assign({furniture: true, labels: true, units: 'm'}, options || {});
    const canvas = document.createElement('canvas');
    canvas.className = 'v3dcanvas'; canvas.tabIndex = -1; canvas.setAttribute('aria-label', '3D preview of the floor plan');
    const labelBox = document.createElement('div'); labelBox.className = 'v3dlabels';
    host.append(canvas, labelBox);
    const attrs = {antialias: true, alpha: false, depth: true, preserveDrawingBuffer: false, premultipliedAlpha: true};
    let gl = null;
    try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e) { gl = null; }
    if (!gl) { canvas.remove(); labelBox.remove(); const err = new Error('WebGL is not available in this browser.'); err.code = 'nowebgl'; throw err; }
    counters.created++; counters.contextsCreated++;

    let prog = null, loc = null, bufs = {}, scene = null, cam = null, destroyed = false, failed = false, lost = false, raf = 0;
    let labelEls = [], fitted = false, cssW = 0, cssH = 0, lastMVP = null;
    const ptrs = new Map(); let mode = null, pinch0 = null;

    const fail = err => { if (failed || destroyed) return; failed = true; counters.errors++; try { console.warn('3D view stopped:', err); } catch (_) {} try { o.onError && o.onError(err); } catch (_) {} };
    const guard = fn => function () { if (destroyed || failed) return; try { return fn.apply(this, arguments); } catch (err) { fail(err); } };

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
        M: gl.getUniformLocation(prog, 'uM'), L: gl.getUniformLocation(prog, 'uL'), F: gl.getUniformLocation(prog, 'uFlat')};
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
    function rebuild(m) {
      model = m; scene = buildScene(model, o); if (!lost) upload(); setLabels();
      if (!fitted && !scene.empty) fit();
      requestDraw();
    }
    function radius() { const b = scene.box; return .5 * Math.hypot(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0) || 300; }
    function fit(yaw = .62, pitch = .78) {
      const b = scene.box, r = Math.max(radius(), 80), aspect = Math.max(.3, (cssW || 800) / (cssH || 600));
      const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * aspect));
      cam = {yaw, pitch, dist: r / Math.sin(half) * 1.04, t: [(b.x0 + b.x1) / 2, b.y1 * .18, (b.z0 + b.z1) / 2]};
      fitted = !scene.empty; requestDraw();
    }
    function limits() { const r = Math.max(radius(), 80); return {min: Math.max(40, r * .12), max: r * 12 + 600, r}; }
    function eye() { const c = Math.cos(cam.pitch); return [cam.t[0] + cam.dist * c * Math.sin(cam.yaw), cam.t[1] + cam.dist * Math.sin(cam.pitch), cam.t[2] + cam.dist * c * Math.cos(cam.yaw)]; }
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
      const r = limits().r, e = eye(), near = clamp(cam.dist * .02, 1, 200), far = cam.dist + r * 8 + 5000;
      const mvp = mul(perspective(FOV, cssW / cssH, near, far), lookAt(e, cam.t, [0, 1, 0])); lastMVP = mvp;
      gl.useProgram(prog); gl.uniformMatrix4fv(loc.M, false, mvp); gl.uniform3fv(loc.L, LIGHT);
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
    function toScreen(x, y, z) {
      const m = lastMVP; if (!m) return null;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-6) return null;
      const sx = (cx / cw * .5 + .5) * cssW, sy = (1 - (cy / cw * .5 + .5)) * cssH;
      return sx < -40 || sy < -20 || sx > cssW + 40 || sy > cssH + 20 ? null : {x: sx, y: sy};
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
    function requestDraw() { if (!raf && !destroyed) raf = requestAnimationFrame(guard(() => { raf = 0; draw(); })); }

    /* ----- camera controls ----- */
    function orbit(dx, dy) { cam.yaw -= dx * .0085; cam.pitch = clamp(cam.pitch + dy * .0085, .06, 1.55); requestDraw(); }
    function zoom(k) { const L = limits(); cam.dist = clamp(cam.dist * k, L.min, L.max); requestDraw(); }
    function pan(dx, dy) {
      const s = 2 * cam.dist * Math.tan(FOV / 2) / Math.max(1, cssH), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      cam.t[0] -= (cy * dx - sy * dy) * s; cam.t[2] -= (-sy * dx - cy * dy) * s;
      const b = scene.box, L = limits();
      cam.t[0] = clamp(cam.t[0], b.x0 - L.r, b.x1 + L.r); cam.t[2] = clamp(cam.t[2], b.z0 - L.r, b.z1 + L.r);
      requestDraw();
    }
    const at = e => { const r = canvas.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
    const onDown = guard(e => {
      canvas.focus({preventScroll: true});
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      ptrs.set(e.pointerId, at(e));
      if (ptrs.size === 1) mode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'orbit';
      else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; mode = 'pinch'; pinch0 = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, dist: cam.dist, mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}}; }
      e.preventDefault();
    });
    const onMove = guard(e => {
      const prev = ptrs.get(e.pointerId); if (!prev) return;
      const p = at(e); ptrs.set(e.pointerId, p);
      if (mode === 'orbit') orbit(p.x - prev.x, p.y - prev.y);
      else if (mode === 'pan') pan(p.x - prev.x, p.y - prev.y);
      else if (mode === 'pinch' && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
        const L = limits(); cam.dist = clamp(pinch0.dist * pinch0.d / d, L.min, L.max);
        pan(mid.x - pinch0.mid.x, mid.y - pinch0.mid.y); pinch0.mid = mid;
      }
    });
    const onUp = guard(e => {
      ptrs.delete(e.pointerId);
      if (!ptrs.size) mode = null; else if (ptrs.size === 1) mode = 'orbit';
    });
    const onWheel = guard(e => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoom(Math.exp(dy * (e.ctrlKey ? .01 : .0012)));
    });
    const onMenu = e => e.preventDefault();
    const onKey = guard(e => {
      if (o.isBlocked && o.isBlocked(e)) return;
      const k = e.key; let used = true;
      if (k === 'ArrowLeft') orbit(-14, 0); else if (k === 'ArrowRight') orbit(14, 0);
      else if (k === 'ArrowUp') orbit(0, -10); else if (k === 'ArrowDown') orbit(0, 10);
      else if (k === '+' || k === '=') zoom(.85); else if (k === '-' || k === '_') zoom(1 / .85);
      else if (k === '0') fit(); else if (k === 'Escape') { o.onClose && o.onClose(); }
      else used = false;
      if (used) e.preventDefault();
    });
    const onLost = e => { e.preventDefault(); lost = true; bufs = {}; prog = null; try { o.onLost && o.onLost(); } catch (_) {} };
    const onRestored = guard(() => { lost = false; initGL(); upload(); try { o.onRestored && o.onRestored(); } catch (_) {} requestDraw(); });

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, {passive: false});
    canvas.addEventListener('contextmenu', onMenu);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    window.addEventListener('keydown', onKey);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(guard(() => requestDraw())) : null;
    const onResize = guard(() => requestDraw());
    if (ro) ro.observe(host); else window.addEventListener('resize', onResize);

    try { initGL(); resize(); rebuild(model); if (!cam) fit(); }
    catch (err) { destroyInternal(); throw err; }

    function destroyInternal() {
      if (destroyed) return; destroyed = true;
      if (raf) cancelAnimationFrame(raf); raf = 0;
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onMenu);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      try { if (!lost) { freeBuffers(); if (prog) gl.deleteProgram(prog); } const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (_) {}
      canvas.width = 1; canvas.height = 1; canvas.remove(); labelBox.remove();
      counters.destroyed++; counters.contextsReleased++;
    }

    return {
      update(m) { if (!destroyed) rebuild(m); },
      setOptions(p) { if (destroyed) return; Object.assign(o, p || {}); rebuild(model); },
      resetView() { if (!destroyed) fit(); },
      topView() { if (!destroyed) fit(0, 1.55); },
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
      get camera() { return cam ? {yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.t.slice()} : null; },
      get destroyed() { return destroyed; },
      /* for tests and troubleshooting */
      stats() {
        return {triangles: scene.solid.count / 3, glassTriangles: scene.glass.count / 3, gridLines: scene.lines.count / 2, labels: scene.labels.length,
          skipped: scene.skipped, nonFinite: scene.nonFinite, empty: scene.empty, wallHeight: scene.H, heights: {min: scene.minH, max: scene.H}, box: Object.assign({}, scene.box),
          buildMs: Math.round(scene.buildMs * 10) / 10, canvas: [canvas.width, canvas.height], lost};
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

  window.FP3D = {api: API, create, counters, internals: {triangulate, prism, flat, buildScene, Mesh, area2}};
})();
