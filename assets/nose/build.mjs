// Builds assets/nose/{concepts/a,b,c,e,f.svg, expressions.json, frames/*.svg, favicon.svg,
// favicon-sketch.svg, contact-sheet.html}. Concept E is the locked mark; see E_LOCK below.
// The drawings are hand-placed centrelines with a width profile per stroke; this script expands
// them into tapered filled outlines with a little hand tremor. No dependencies, no raster.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
if (!ROOT) throw new Error("usage: bun nose-build.mjs <assets/nose dir>");

// ---- deterministic tremor (integer hash, no Math.random, so every build is byte-identical) -------
function hash(...seeds) {
  let h = 0x811c9dc5;
  for (const s of seeds) {
    const f = Math.imul(s | 0, 0x85ebca6b) ^ Math.imul(Math.round(s * 1024), 0xc2b2ae35);
    h = Math.imul(h ^ f, 0x27d4eb2d);
    h ^= h >>> 15;
  }
  return h >>> 0;
}
const jitter = (...s) => hash(...s) / 0x80000000 - 1;
const f2 = (n) => Number(n.toFixed(2)).toString();

// ---- stroke expander: centreline (M + absolute C segments) + width profile -> filled outline ----
function parseLine(d) {
  const nums = d.replace(/[MC]/g, " ").trim().split(/[\s,]+/).map(Number);
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  const segs = [];
  for (let i = 1; i + 2 < pts.length; i += 3) segs.push([pts[i - 1], pts[i], pts[i + 1], pts[i + 2]]);
  return segs;
}
const cub = (a, b, c, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
const dcub = (a, b, c, d, t) => { const u = 1 - t; return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c); };
function sample(segs, n) {
  const lens = segs.map(([p0, c1, c2, p1]) => Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + 0.5 * (Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(p1[0] - c2[0], p1[1] - c2[1])));
  const total = lens.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  segs.forEach(([p0, c1, c2, p1], si) => {
    const m = Math.max(3, Math.round((n * lens[si]) / total));
    for (let k = 0; k < m; k++) {
      const t = k / m;
      const x = cub(p0[0], c1[0], c2[0], p1[0], t), y = cub(p0[1], c1[1], c2[1], p1[1], t);
      let tx = dcub(p0[0], c1[0], c2[0], p1[0], t), ty = dcub(p0[1], c1[1], c2[1], p1[1], t);
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      out.push({ x, y, nx: -ty, ny: tx, u: (acc + (k / m) * lens[si]) / total });
    }
    acc += lens[si];
  });
  const [p0, c1, c2, p1] = segs[segs.length - 1];
  let tx = dcub(p0[0], c1[0], c2[0], p1[0], 1), ty = dcub(p0[1], c1[1], c2[1], p1[1], 1);
  const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
  out.push({ x: p1[0], y: p1[1], nx: -ty, ny: tx, u: 1 });
  return out;
}
function widthAt(profile, u) {
  for (let i = 1; i < profile.length; i++) {
    const [u0, w0] = profile[i - 1], [u1, w1] = profile[i];
    if (u <= u1) return w0 + ((w1 - w0) * (u - u0)) / Math.max(1e-6, u1 - u0);
  }
  return profile[profile.length - 1][1];
}
function catmull(points) {
  // open Catmull-Rom through points, as cubic Béziers (continuation, no leading M)
  let d = "";
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] ?? points[i + 1];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f2(c1[0])} ${f2(c1[1])} ${f2(c2[0])} ${f2(c2[1])} ${f2(p2[0])} ${f2(p2[1])}`;
  }
  return d;
}
function expand({ line, w, seed = 1, samples = 16, tremor = 0.3 }) {
  const pts = sample(parseLine(line), samples);
  const left = [], right = [];
  pts.forEach((p, i) => {
    const half = widthAt(w, p.u) / 2;
    const end = Math.min(1, Math.min(p.u, 1 - p.u) * 6); // calm the tremor at the tips
    const jl = jitter(seed, i, 1) * tremor * end, jr = jitter(seed, i, 2) * tremor * end;
    const slip = jitter(seed, i, 3) * tremor * 0.5 * end;
    left.push([p.x + p.nx * (half + jl) - p.ny * slip, p.y + p.ny * (half + jl) + p.nx * slip]);
    right.push([p.x - p.nx * (half + jr) - p.ny * slip, p.y - p.ny * (half + jr) + p.nx * slip]);
  });
  const l0 = left[0], lN = left[left.length - 1], rN = right[right.length - 1], r0 = right[0];
  const rightBack = right.slice().reverse();
  // Round caps as two cubics (no arc commands, so the frame boil can wobble every number safely).
  const K = 0.5523;
  const cap = (a, b, p, tx, ty, r) => {
    const apex = [p.x + tx * r, p.y + ty * r];
    const c1 = [a[0] + tx * r * K, a[1] + ty * r * K];
    const c2 = [apex[0] + (a[0] - p.x) * K, apex[1] + (a[1] - p.y) * K];
    const c3 = [apex[0] + (b[0] - p.x) * K, apex[1] + (b[1] - p.y) * K];
    const c4 = [b[0] + tx * r * K, b[1] + ty * r * K];
    return `C${f2(c1[0])} ${f2(c1[1])} ${f2(c2[0])} ${f2(c2[1])} ${f2(apex[0])} ${f2(apex[1])}C${f2(c3[0])} ${f2(c3[1])} ${f2(c4[0])} ${f2(c4[1])} ${f2(b[0])} ${f2(b[1])}`;
  };
  const pEnd = pts[pts.length - 1], pStart = pts[0];
  const endCap = cap(lN, rN, pEnd, pEnd.ny, -pEnd.nx, Math.max(0.2, widthAt(w, 1) / 2));
  const startCap = cap(r0, l0, pStart, -pStart.ny, pStart.nx, Math.max(0.2, widthAt(w, 0) / 2));
  return `M${f2(l0[0])} ${f2(l0[1])}${catmull(left)}${endCap}${catmull(rightBack)}${startCap}Z`;
}
const strokes = (list, extra = "") => list.map((s) => `<path${extra}${s.opacity ? ` opacity="${s.opacity}"` : ""}${s.shift ? ` transform="translate(${s.shift[0]} ${s.shift[1]})"` : ""} d="${expand(s)}"/>`).join("\n        ");

// Pencil hatching: short, slightly bowed parallel strokes with per-stroke jitter, as stroke paths.
function hatchSet({ pts, len, angle, seed, w = 0.5, o = 0.42 }) {
  const a = (angle * Math.PI) / 180;
  const d = pts.map(([x, y], i) => {
    const L = len * (1 + jitter(seed, i, 1) * 0.25);
    const x0 = x + jitter(seed, i, 2) * 0.4, y0 = y + jitter(seed, i, 3) * 0.4;
    const ex = Math.cos(a) * L, ey = Math.sin(a) * L;
    const bow = jitter(seed, i, 4) * 0.5;
    const cx = ex / 2 - Math.sin(a) * bow, cy = ey / 2 + Math.cos(a) * bow;
    return `M${f2(x0)} ${f2(y0)}q${f2(cx)} ${f2(cy)} ${f2(ex)} ${f2(ey)}`;
  });
  return `<g fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" opacity="${o}">${d.map((p) => `<path d="${p}"/>`).join("")}</g>`;
}

// ---- the drawings ------------------------------------------------------------------------------
const W = {
  thinTaper: [[0, 0.9], [0.5, 2.6], [1, 0.9]],
  wisp: [[0, 1], [0.5, 2.8], [1, 1]],
  shine: [[0, 0.5], [0.5, 1.3], [1, 0.5]],
  // round 2, pencil: a graphite line is thin and its pressure varies; ghosts are the searching passes
  ghost: [[0, 0.25], [0.5, 0.55], [1, 0.25]],
  pencilThin: [[0, 0.3], [0.5, 0.85], [1, 0.3]],
};
const ACCENT = "var(--nose-accent, #e4572e)";
// Construction lines sit at 0.16 on the ink concepts and a little stronger on the pencil ones,
// where the overlapping construction strokes are part of the look.
const CONSTRUCTION_REST = { e: 0.16, f: 0.16 };

const SPEC = {
  a: {
    name: "Snoot",
    title: "Sniff Test nose, concept A: Snoot",
    blurb: "Round profile nose, pen line. The classic cartoon snoot; the recoil reads because it is a profile.",
    construction: ['<path d="M33 48c10 0 18 8 18 18s-8 18-18 18-18-8-18-18 7-18 17-18"/>', '<path d="M62 10 44 38"/>'],
    bridge: [{ line: "M60 12 C56 16 52 22 50 28 C48 32 46 36 43 40", w: [[0, 2.2], [0.35, 4.6], [1, 5.6]], seed: 11 }],
    wrinkle: [
      { line: "M50 21 C52.5 19.8 55.5 18.6 58 17.5", w: W.thinTaper, seed: 21 },
      { line: "M48 28 C50.8 27 53.7 26 56.5 25", w: W.thinTaper, seed: 22 },
      { line: "M45.5 35 C48 34.2 50.8 33.3 53.5 32.5", w: W.thinTaper, seed: 23 },
    ],
    tip: [
      { line: "M43 40 C36 46 24 54 17 64 C12 72 18 82 30 83 C38 84 46 80 51 77", w: [[0, 5.4], [0.3, 8.4], [0.6, 9.2], [0.85, 7], [1, 4.2]], seed: 12, samples: 22 },
      { line: "M25.5 63 C23 66.5 22.5 70.5 24 74", w: W.shine, seed: 13, opacity: 0.3 },
    ],
    nostrilR: [
      { line: "M49 78 C57 76 64 70 64 62 C64 59.5 63.5 57.5 62 56", w: [[0, 3.2], [0.4, 5.6], [0.8, 3.5], [1, 1.2]], seed: 14 },
    ],
    nostrilRShape: '<path d="M56 67c-4.5-2.5-10 0.5-8.5 5 1.2 3.4 6 3.4 8 0.8 1.4-1.9 1.4-4.2 0.5-5.8z"/>',
    nostrilL: [{ line: "M16 72 C13 73.5 12.5 77.5 15 80", w: [[0, 1.4], [0.5, 3.4], [1, 1.4]], seed: 15 }],
    scent: [
      { line: "M4 96 C8 90 0 84 5 78 C9 72 2 66 7 60", w: W.wisp, seed: 31 },
      { line: "M11 100 C15 94 7 88 12 82 C16 76 9 70 14 64", w: W.wisp, seed: 32 },
      { line: "M18 100 C22 95 15 91 19 86", w: W.wisp, seed: 33 },
    ],
    stink: ['<path d="M4 96l4-7-4-7 4-7-4-7 4-7"/>', '<path d="M12 100l4-7-4-7 4-7-4-7 4-7"/>', '<path d="M20 98l3-6-3-6 3-6"/>'],
    ok: ['<path d="M14 30v11"/><path d="M8.5 35.5h11"/>', '<path d="M25 20v6"/><path d="M22 23h6"/>'],
    flick: ['<path d="M68 12l7-3"/><path d="M70 20l8-1"/>'],
  },
  b: {
    name: "Bulb",
    title: "Sniff Test nose, concept B: Bulb",
    blurb: "Front-on bulb, two nostrils. Symmetric, the strongest favicon silhouette; flares straight at you.",
    construction: ['<path d="M50 47c10 0 19 8 19 19s-9 19-19 19-19-8-19-19 8-19 18-19"/>', '<path d="M50 8v40"/>'],
    bridge: [
      { line: "M41 14 C39 24 36 36 32 47", w: [[0, 2.2], [0.5, 4.4], [1, 5]], seed: 41 },
      { line: "M59 14 C61 24 64 36 68 47", w: [[0, 2.2], [0.5, 4.4], [1, 5]], seed: 42 },
    ],
    wrinkle: [
      { line: "M42 30 C47 29.5 53 29 58 28.5", w: W.thinTaper, seed: 43 },
      { line: "M41 37 C47 36.7 53 36.3 59 36", w: W.thinTaper, seed: 44 },
      { line: "M40.5 44 C47 44.2 53 44.3 59.5 44.5", w: W.thinTaper, seed: 45 },
    ],
    tip: [
      { line: "M31 49 C25 57 24 69 32 76 C38 81 46 82 50 82 C54 82 62 81 68 76 C76 69 75 57 69 49", w: [[0, 4.5], [0.2, 7], [0.5, 9], [0.8, 7], [1, 4.5]], seed: 46, samples: 26 },
      { line: "M37 56 C35 59 35 62 36 65", w: W.shine, seed: 47, opacity: 0.3 },
    ],
    nostrilR: [{ line: "M72 62 C76 65 77 71 73 75", w: [[0, 1.5], [0.5, 4.6], [1, 1.5]], seed: 48 }],
    nostrilRShape: '<path d="M66 69c-3-1.5-7-0.5-8 2.5-0.8 2.5 2 4.5 5 4 3-0.5 6-2 6-4 0-1.2-1.5-2-3-2.5z"/>',
    nostrilL: [{ line: "M28 62 C24 65 23 71 27 75", w: [[0, 1.5], [0.5, 4.6], [1, 1.5]], seed: 49 }],
    nostrilLShape: '<path d="M34 69c3-1.5 7-0.5 8 2.5 0.8 2.5-2 4.5-5 4-3-0.5-6-2-6-4 0-1.2 1.5-2 3-2.5z"/>',
    scent: [
      { line: "M22 96 C24 89 30 90 32 83 C33 79 36 77 40 76", w: W.wisp, seed: 51 },
      { line: "M50 98 C49 93 51 89 50 84", w: W.wisp, seed: 52 },
      { line: "M78 96 C76 89 70 90 68 83 C67 79 64 77 60 76", w: W.wisp, seed: 53 },
    ],
    stink: ['<path d="M30 98l4-7-4-7 4-7"/>', '<path d="M50 100l4-7-4-7 4-7"/>', '<path d="M70 98l-4-7 4-7-4-7"/>'],
    ok: ['<path d="M16 22v12"/><path d="M10 28h12"/>', '<path d="M84 18v7"/><path d="M80.5 21.5h7"/>'],
    flick: ['<path d="M78 12l6-4"/><path d="M82 20l7-2"/>'],
  },
  c: {
    name: "Beak",
    title: "Sniff Test nose, concept C: Beak",
    blurb: "Long pointed profile. The most character; it pokes into the draft. Wedge silhouette at 16 px.",
    construction: ['<path d="M68 6 6 66"/>', '<path d="M14 56c4.5 0 8 3.5 8 8s-3.5 8-8 8-8-3.5-8-8 3-8 7.5-8"/>'],
    bridge: [{ line: "M66 8 C58 16 46 28 34 42 C31 45.5 28 48.5 25.5 51.5", w: [[0, 2], [0.4, 4.6], [1, 5.4]], seed: 61, samples: 20 }],
    wrinkle: [
      { line: "M50 22 C52.7 20.7 55.3 19.3 58 18", w: W.thinTaper, seed: 62 },
      { line: "M46 28 C49 26.8 52 25.7 55 24.5", w: W.thinTaper, seed: 63 },
      { line: "M42 34 C45 33 48 32 51 31", w: W.thinTaper, seed: 64 },
    ],
    tip: [
      { line: "M25.5 51.5 C19 56 10 61 6 66 C4 69 8 71 14 71.5 C22 72.5 34 71 44 69.5", w: [[0, 5.2], [0.3, 7.6], [0.55, 8], [0.8, 6], [1, 3.8]], seed: 65, samples: 22 },
      { line: "M17 58 C14 60 12 62.5 11 65", w: W.shine, seed: 66, opacity: 0.3 },
    ],
    nostrilR: [{ line: "M43 70 C50 68.5 56 63 56 56 C56 54 55.4 52.2 54.4 50.6", w: [[0, 3], [0.4, 5.2], [0.8, 3], [1, 1.2]], seed: 67 }],
    nostrilRShape: '<path d="M50 59.5c-4-2.2-9 0.3-7.5 4.4 1 3 5.4 3 7.2 0.7 1.2-1.6 1.2-3.6 0.3-5.1z"/>',
    nostrilL: [{ line: "M9 62 C6.5 62.5 5 64.5 5.5 67", w: [[0, 1.2], [0.5, 3], [1, 1.2]], seed: 68 }],
    scent: [
      { line: "M6 98 C10 93 2 88 7 83 C10 79 5 75 8 71", w: W.wisp, seed: 71 },
      { line: "M16 100 C20 95 12 90 17 85 C20 81 15 77 18 73", w: W.wisp, seed: 72 },
      { line: "M26 98 C30 93 22 88 27 83", w: W.wisp, seed: 73 },
    ],
    stink: ['<path d="M6 98l4-7-4-7 4-7"/>', '<path d="M16 100l4-7-4-7 4-7"/>', '<path d="M26 98l4-7-4-7"/>'],
    ok: ['<path d="M16 34v12"/><path d="M10 40h12"/>', '<path d="M28 27v8"/><path d="M24 31h8"/>'],
    flick: ['<path d="M76 14l7-3"/><path d="M78 22l8-1"/>'],
  },
  // ---- round 2: pencil sketch, unmistakably a nose ----
  e: {
    name: "Sketch",
    title: "Sniff Test nose, concept E: Sketch, profile",
    blurb: "Round 2. Pencil profile: brow into bridge, round tip, wing, nostril and a hint of the lip below. A quick sketchbook line, graphite not ink; the searching passes and the hatching are part of it.",
    round: 2,
    pencil: true,
    construction: [
      '<path d="M30 57c7.2 0 13 5.8 13 13s-5.8 13-13 13-13-5.8-13-13 5.6-13 12.6-13"/>',
      '<path d="M59 15 37 55"/>',
    ],
    bridge: [
      { line: "M59 15 C56.5 19 54.5 23 53.5 27 C51.5 35 46 44 39 52", w: [[0, 0.35], [0.25, 0.9], [0.55, 1.25], [0.85, 1], [1, 0.55]], seed: 101, samples: 24, opacity: 0.8, main: true },
      { line: "M55 24 C52.5 32 47 42 41 50", w: W.ghost, seed: 102, opacity: 0.3, tremor: 0.6, shift: [0.9, -0.3] },
      { line: "M59 15 C56.5 19 54.5 23 53.5 27 C51.5 35 46 44 39 52", w: W.ghost, seed: 103, opacity: 0.22, tremor: 0.7, shift: [-0.7, 0.6] },
    ],
    hatchBridge: { pts: [[54.8, 30], [52.4, 34], [50.1, 38], [47.8, 42]], len: 4, angle: 160, seed: 7 },
    wrinkle: [
      { line: "M49.5 28 C52 26.6 54.5 25.2 57 24", w: W.pencilThin, seed: 111, opacity: 0.8 },
      { line: "M47 35 C49.5 33.8 52 32.6 54.5 31.5", w: W.pencilThin, seed: 112, opacity: 0.8 },
      { line: "M44.5 42 C47 41 49.5 40 52 39", w: W.pencilThin, seed: 113, opacity: 0.8 },
    ],
    tip: [
      { line: "M39 52 C32 57 24 63 21.5 70 C19.5 76.5 24 82 31 82.5 C37 83 43 81 48 79", w: [[0, 0.5], [0.3, 1.05], [0.55, 1.3], [0.8, 1.15], [1, 0.5]], seed: 121, samples: 26, opacity: 0.8, main: true },
      { line: "M38 53.5 C31 58.5 23.5 64.5 21.5 71", w: W.ghost, seed: 122, opacity: 0.28, tremor: 0.6, shift: [-0.8, 0.2] },
      { line: "M25 80 C30 83.5 38 83 46 80.5", w: W.ghost, seed: 123, opacity: 0.3, tremor: 0.5, shift: [0.3, 1] },
    ],
    hatchTip: { pts: [[26, 82], [29, 83.8], [32, 84.5], [35, 84.4], [38, 84], [41, 83.2], [44, 82.2]], len: 4.5, angle: 62, seed: 8 },
    nostrilR: [
      { line: "M46 60 C54 59 60.5 65 60 71.5 C59.5 75.5 55.5 79 50 79", w: [[0, 0.4], [0.4, 1.1], [0.8, 0.95], [1, 0.4]], seed: 131, samples: 20, opacity: 0.8, main: true },
    ],
    nostrilRShape: '<path opacity="0.42" d="M39.5 77.2c2-1.7 5.6-2 8-0.5 1.3 0.8 0.6 2.1-0.9 2.3-2.5 0.3-5.7 0-7.1-1.8z"/>',
    hatchNostril: { pts: [[41, 76.5], [43.5, 76.2], [46, 76.4]], len: 2.2, angle: 70, seed: 9, w: 0.45, o: 0.5 },
    nostrilL: [{ line: "M27 74 C25.5 76 25.5 78.5 27 80.5", w: W.pencilThin, seed: 141, opacity: 0.4 }],
    lip: [{ line: "M48 79.5 C49 83 49.5 87 48 91 C47 93.5 45 95 42.5 96.5", w: [[0, 0.35], [0.4, 0.8], [1, 0.4]], seed: 151, opacity: 0.55 }],
    scent: [
      { line: "M4 96 C8 90 0 84 5 78 C9 72 2 66 7 60", w: W.wisp, seed: 31 },
      { line: "M11 100 C15 94 7 88 12 82 C16 76 9 70 14 64", w: W.wisp, seed: 32 },
      { line: "M18 100 C22 95 15 91 19 86", w: W.wisp, seed: 33 },
    ],
    stink: ['<path d="M4 96l4-7-4-7 4-7-4-7 4-7"/>', '<path d="M12 100l4-7-4-7 4-7-4-7 4-7"/>', '<path d="M20 98l3-6-3-6 3-6"/>'],
    ok: ['<path d="M14 30v11"/><path d="M8.5 35.5h11"/>', '<path d="M25 20v6"/><path d="M22 23h6"/>'],
    flick: ['<path d="M68 12l7-3"/><path d="M70 20l8-1"/>'],
  },
  f: {
    name: "Sketch ¾",
    title: "Sniff Test nose, concept F: Sketch, three-quarter",
    blurb: "Round 2 wildcard. Pencil three-quarter view: one bridge line, round tip, both wings and nostrils, philtrum and lip line below. Reads front-on at small sizes.",
    round: 2,
    pencil: true,
    construction: [
      '<path d="M47 50c7.7 0 14 6.3 14 14s-6.3 14-14 14-14-6.3-14-14 6-14 13.4-14"/>',
      '<path d="M53 8 44 46"/>',
    ],
    bridge: [
      { line: "M53 8 C51 18 48 32 44 46", w: [[0, 0.35], [0.3, 0.9], [0.6, 1.25], [1, 0.7]], seed: 201, samples: 22, opacity: 0.8 },
      { line: "M61 14 C61 26 60 36 58 46", w: W.ghost, seed: 202, opacity: 0.2, tremor: 0.4 },
      { line: "M53 8 C51 18 48 32 44 46", w: W.ghost, seed: 203, opacity: 0.22, tremor: 0.7, shift: [-0.8, 0.4] },
    ],
    hatchBridge: { pts: [[46, 24], [45.2, 29], [44.4, 34]], len: 3, angle: 20, seed: 17 },
    wrinkle: [
      { line: "M43 24 C46 23 49 22.5 52 22.5", w: W.pencilThin, seed: 211, opacity: 0.8 },
      { line: "M42 31 C45 30 48 29.5 51 29.5", w: W.pencilThin, seed: 212, opacity: 0.8 },
      { line: "M41 38 C44 37 47 36.5 50 36.5", w: W.pencilThin, seed: 213, opacity: 0.8 },
    ],
    tip: [
      { line: "M44 46 C36 51 31.5 59 33.5 68 C35.5 77 43 81.5 51 81.5 C57 81.5 61 78 62 73", w: [[0, 0.5], [0.3, 1.05], [0.55, 1.3], [0.8, 1.15], [1, 0.5]], seed: 221, samples: 28, opacity: 0.8 },
      { line: "M43 47.5 C35.5 52.5 31.5 60 33 68", w: W.ghost, seed: 222, opacity: 0.28, tremor: 0.6, shift: [-0.7, 0.3] },
      { line: "M37 79 C43 82.5 50 83.5 57 81.5", w: W.ghost, seed: 223, opacity: 0.3, tremor: 0.5, shift: [0, 1] },
    ],
    hatchTip: { pts: [[37, 83.5], [40, 84.5], [43, 85], [46, 85.2], [49, 85], [52, 84.4], [55, 83.4]], len: 4, angle: 70, seed: 18 },
    nostrilL: [{ line: "M35 62 C29.5 64 27 70.5 30.5 76.5", w: [[0, 0.4], [0.5, 1.15], [1, 0.45]], seed: 231, opacity: 0.85 }],
    nostrilLShape: '<path opacity="0.42" d="M34.5 77.5c1.2-1.5 4-1.8 5.6-0.5 0.9 0.7 0.4 1.9-0.8 2.1-2 0.3-4.2 0-4.8-1.6z"/>',
    nostrilR: [
      { line: "M58.5 60 C66 59 71.5 65.5 70.5 72 C69.8 76.5 65 80 59.5 79.5", w: [[0, 0.4], [0.4, 1.2], [0.8, 1], [1, 0.4]], seed: 241, samples: 20, opacity: 0.85 },
      { line: "M61.5 58 C67.5 55.5 73.5 59 75.5 65", w: W.ghost, seed: 242, opacity: 0.28, tremor: 0.3 },
    ],
    nostrilRShape: '<path opacity="0.42" d="M51.5 78c2-2.1 6.8-2.5 9.5-0.5 1.3 1 0.5 2.6-1.4 2.8-3.3 0.4-7 0-8.1-2.3z"/>',
    hatchNostril: { pts: [[64, 71], [66, 74], [67, 77]], len: 3, angle: 125, seed: 19 },
    lip: [
      { line: "M46.5 83 C46 86.5 46 89.5 46.5 92.5", w: [[0, 0.3], [0.5, 0.7], [1, 0.35]], seed: 251, opacity: 0.45 },
      { line: "M53.5 83 C54 86.5 54 89.5 53.5 92.5", w: [[0, 0.3], [0.5, 0.7], [1, 0.35]], seed: 252, opacity: 0.45 },
      { line: "M38 95.5 C44 93.5 51 93.5 60 95.5", w: [[0, 0.3], [0.5, 0.8], [1, 0.35]], seed: 253, opacity: 0.5 },
    ],
    scent: [
      { line: "M8 96 C12 90 4 84 9 78 C13 72 6 66 11 60", w: W.wisp, seed: 34 },
      { line: "M15 100 C19 94 11 88 16 82 C20 76 13 70 18 64", w: W.wisp, seed: 35 },
      { line: "M22 100 C26 95 19 91 23 86", w: W.wisp, seed: 36 },
    ],
    stink: ['<path d="M8 96l4-7-4-7 4-7-4-7 4-7"/>', '<path d="M16 100l4-7-4-7 4-7-4-7 4-7"/>', '<path d="M24 98l3-6-3-6 3-6"/>'],
    ok: ['<path d="M14 30v11"/><path d="M8.5 35.5h11"/>', '<path d="M25 20v6"/><path d="M22 23h6"/>'],
    flick: ['<path d="M74 12l7-3"/><path d="M76 20l8-1"/>'],
  },
};

// ---- the lock: E is the mark, at a heavier pencil weight ------------------------------------------
// Ruling on round 2: "E sketch is fine maybe a bit heavier weight but not as heavy as snoot."
// SPEC.e above stays as drawn for round 2; the lock is a weight pass over the same centrelines, so
// the before and after on the contact sheet differ in weight and nothing else. Main contours
// (`main: true`) take `contour` and the higher opacity; thin strokes and hatching take `fine`; the
// ghost passes and construction marks are left alone so the line still reads as graphite, not ink.
// Settled by eye at 64 and 400 px on white and near-black: 1.35 did not register at 64 px, 1.85 read
// as an inked outline on the wing. At 1.5 the heaviest point of the contour is 1.95 units against
// concept A's 9.2.
const E_LOCK = { contour: 1.5, fine: 1.25, contourOpacity: 0.9, nostrilFill: 0.46 };
function lockWeight(spec, { contour, fine, contourOpacity, nostrilFill }) {
  const scale = (w, k) => w.map(([u, v]) => [u, Number((v * k).toFixed(3))]);
  const stroke = (st) => (st.w === W.ghost ? st : st.main ? { ...st, w: scale(st.w, contour), opacity: contourOpacity } : { ...st, w: scale(st.w, fine) });
  const out = { ...spec };
  for (const k of ["bridge", "wrinkle", "tip", "nostrilR", "nostrilL", "lip"]) out[k] = spec[k].map(stroke);
  for (const k of ["hatchBridge", "hatchTip", "hatchNostril"]) out[k] = { ...spec[k], w: Number(((spec[k].w ?? 0.5) * fine).toFixed(3)) };
  out.nostrilRShape = spec.nostrilRShape.replace(/opacity="[^"]*"/, `opacity="${nostrilFill}"`);
  return out;
}
const E_BEFORE = SPEC.e; // round 2 weights as shipped at dd662bc; only the contact sheet still draws it
SPEC.e = lockWeight(E_BEFORE, E_LOCK);

function conceptSvg(key, s = SPEC[key]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Sniff Test nose">
  <title>${s.title}</title>
  <!--
    Hand-drawn: each contour is a hand-placed centreline with a width profile, expanded into a
    tapered outline with a little tremor (assets/nose/build.mjs holds the drawing). No raster, no
    image generation. Ink is currentColor so the mark sits on any ground; the one accent is the CSS
    variable nose-accent. Every rig part carries id + data-part (use data-part when several copies
    share a page). Transforms are applied by consumers per assets/nose/expressions.json.${s.pencil ? `
    Round 2, pencil: thin main contour at partial opacity, two fainter searching passes, hatching
    for the shadow under the tip and beside the bridge, and a lip hint (group "lip", static, inside
    "nose") so the silhouette reads as a nose on a face.` : ""}
  -->
  <g id="stage" data-part="stage" stroke-linecap="round" stroke-linejoin="round">
    <g id="nose" data-part="nose" fill="currentColor" stroke="none">
      <g id="construction" data-part="construction" opacity="${CONSTRUCTION_REST[key] ?? 0.16}" fill="none" stroke="currentColor" stroke-width="${s.pencil ? 0.7 : 1.4}">
        ${s.construction.join("\n        ")}
      </g>
      <g id="bridge" data-part="bridge">
        ${strokes(s.bridge)}
        ${s.hatchBridge ? hatchSet(s.hatchBridge) : ""}
        <g id="wrinkle" data-part="wrinkle" opacity="0">
          ${strokes(s.wrinkle)}
        </g>
      </g>
      <g id="tip" data-part="tip">
        ${strokes(s.tip)}
        ${s.hatchTip ? hatchSet(s.hatchTip) : ""}
      </g>
      <g id="nostril-r" data-part="nostril-r">
        ${strokes(s.nostrilR)}
        ${s.nostrilRShape ?? ""}
        ${s.hatchNostril ? hatchSet(s.hatchNostril) : ""}
      </g>
      <g id="nostril-l" data-part="nostril-l">
        ${strokes(s.nostrilL)}
        ${s.nostrilLShape ?? ""}
      </g>${s.lip ? `
      <g id="lip" data-part="lip">
        ${strokes(s.lip)}
      </g>` : ""}
    </g>
    <g id="scent" data-part="scent" fill="${ACCENT}" stroke="none" opacity="0">
      ${strokes(s.scent)}
    </g>
    <g id="stink" data-part="stink" fill="none" stroke="${ACCENT}" stroke-width="2.6" opacity="0">
      ${s.stink.join("\n      ")}
    </g>
    <g id="marks" data-part="marks" fill="none" stroke="${ACCENT}" stroke-width="2.8">
      <g id="mark-ok" data-part="mark-ok" opacity="0">
        ${s.ok.join("\n        ")}
      </g>
      <g id="mark-flick" data-part="mark-flick" opacity="0">
        ${s.flick.join("\n        ")}
      </g>
    </g>
  </g>
</svg>
`;
}

mkdirSync(join(ROOT, "concepts"), { recursive: true });
const CONCEPTS = {
  a: { name: "Snoot", file: "concepts/a-snoot.svg", blurb: SPEC.a.blurb, round: 1 },
  b: { name: "Bulb", file: "concepts/b-bulb.svg", blurb: SPEC.b.blurb, round: 1 },
  c: { name: "Beak", file: "concepts/c-beak.svg", blurb: SPEC.c.blurb, round: 1 },
  d: { name: "Blot", file: "concepts/d-blot.svg", blurb: "Solid ink silhouette, knock-out nostril. Woodcut weight; wins at 16 px, loses the pen line.", round: 1 },
  e: { name: "Sketch", file: "concepts/e-sketch.svg", blurb: SPEC.e.blurb, round: 2 },
  f: { name: "Sketch ¾", file: "concepts/f-sketch-3q.svg", blurb: SPEC.f.blurb, round: 2 },
};
for (const k of ["a", "b", "c", "e", "f"]) writeFileSync(join(ROOT, CONCEPTS[k].file), conceptSvg(k));
const RECOMMENDED = "e";
const LOCKED = { concept: "e", motion: "rig" }; // the pick: concept E, tweened rig (not the baked frames)
const FRAMED = ["a", "e"]; // concepts that get a baked frame set

// ---- expression manifest --------------------------------------------------------------------------
const PARTS = ["nose", "bridge", "tip", "nostril-l", "nostril-r", "wrinkle", "construction", "scent", "stink", "mark-ok", "mark-flick"];
const ID = { tx: 0, ty: 0, r: 0, sx: 1, sy: 1, o: 1 };
const PIVOTS = {
  a: { nose: [60, 12], bridge: [43, 40], tip: [33, 66], "nostril-r": [54, 70], "nostril-l": [15, 76], wrinkle: [50, 28], construction: [33, 60], scent: [10, 80], stink: [10, 80], "mark-ok": [18, 30], "mark-flick": [72, 18] },
  b: { nose: [50, 28], bridge: [50, 48], tip: [50, 66], "nostril-l": [34, 71], "nostril-r": [66, 71], wrinkle: [50, 37], construction: [50, 50], scent: [50, 85], stink: [50, 85], "mark-ok": [50, 25], "mark-flick": [82, 16] },
  c: { nose: [66, 8], bridge: [25, 51], tip: [18, 64], "nostril-r": [50, 62], "nostril-l": [7, 65], wrinkle: [49, 28], construction: [30, 40], scent: [14, 86], stink: [14, 86], "mark-ok": [20, 36], "mark-flick": [80, 18] },
  d: { nose: [58, 8], bridge: [46, 42], tip: [34, 66], "nostril-r": [54, 76], "nostril-l": [16, 76], wrinkle: [50, 28], construction: [33, 60], scent: [10, 80], stink: [10, 80], "mark-ok": [18, 30], "mark-flick": [72, 18] },
  e: { nose: [59, 15], bridge: [39, 52], tip: [30, 70], "nostril-r": [53, 70], "nostril-l": [26, 77], wrinkle: [50, 35], construction: [35, 55], scent: [10, 80], stink: [10, 80], "mark-ok": [18, 30], "mark-flick": [72, 18] },
  f: { nose: [52, 8], bridge: [44, 46], tip: [47, 64], "nostril-l": [32, 71], "nostril-r": [64, 70], wrinkle: [47, 30], construction: [48, 60], scent: [14, 80], stink: [14, 80], "mark-ok": [18, 30], "mark-flick": [78, 16] },
};
const BASE = {
  rest: {},
  sniff: { nose: { r: -5, ty: -1.5 }, bridge: { sy: 0.97 }, "nostril-r": { sx: 1.25, sy: 1.25 }, "nostril-l": { sx: 1.2, sy: 1.2 }, scent: { o: 1, tx: 4 } },
  approve: { nose: { r: -9, ty: -3 }, "nostril-r": { sx: 0.92, sy: 0.92 }, "nostril-l": { sx: 0.92, sy: 0.92 }, "mark-ok": { o: 1 } },
  wrinkle: { nose: { r: 4, ty: 1 }, bridge: { sy: 0.9, tx: 0.5 }, wrinkle: { o: 1 }, tip: { sy: 0.96 }, "nostril-r": { sx: 0.85, sy: 0.8, r: 8 }, "nostril-l": { sx: 0.85, sy: 0.85 }, stink: { o: 0.5 } },
  recoil: { nose: { tx: 9, ty: -4, r: 12, sx: 0.94, sy: 0.94 }, bridge: { sy: 0.94 }, wrinkle: { o: 0.7 }, "nostril-r": { sx: 1.3, sy: 1.3 }, "nostril-l": { sx: 1.25, sy: 1.25 }, stink: { o: 1 } },
  twitch: { nose: { r: -4, tx: 1 }, bridge: { tx: 1 }, "nostril-r": { sx: 1.18, sy: 1.1, r: -6 }, "nostril-l": { sx: 0.9, sy: 0.9 }, "mark-flick": { o: 1 } },
};
const OVERRIDES = {
  b: {
    sniff: { nose: { r: 0, ty: -2, sy: 1.04 } },
    approve: { nose: { r: 0, ty: -3 } },
    wrinkle: { nose: { r: 0, ty: 1 }, "nostril-r": { sx: 0.85, sy: 0.8, r: -8 }, "nostril-l": { sx: 0.85, sy: 0.8, r: 8 } },
    recoil: { nose: { tx: 0, ty: -7, r: 0, sx: 0.88, sy: 0.88 } },
  },
  f: {
    sniff: { nose: { r: -2, ty: -2, sy: 1.03 } },
    approve: { nose: { r: -4, ty: -3 } },
    wrinkle: { nose: { r: 2, ty: 1 }, "nostril-l": { sx: 0.85, sy: 0.8, r: 8 }, "nostril-r": { sx: 0.85, sy: 0.8, r: -8 } },
    recoil: { nose: { tx: 5, ty: -6, r: 6, sx: 0.9, sy: 0.9 } },
  },
};
const REST_OPACITY = { wrinkle: 0, scent: 0, stink: 0, "mark-ok": 0, "mark-flick": 0, construction: 0.16 };
const EXPRESSIONS = Object.keys(BASE);
const TIMING = {
  rest: { holdMs: 500, easeMs: 320 },
  sniff: { holdMs: 380, easeMs: 220 },
  approve: { holdMs: 700, easeMs: 360 },
  wrinkle: { holdMs: 600, easeMs: 260 },
  recoil: { holdMs: 650, easeMs: 180 },
  twitch: { holdMs: 260, easeMs: 90 },
};
function fullState(concept, expr) {
  const out = {};
  for (const p of PARTS) {
    const rest = p === "construction" ? (CONSTRUCTION_REST[concept] ?? REST_OPACITY.construction) : (REST_OPACITY[p] ?? 1);
    out[p] = { ...ID, o: rest, ...(BASE[expr][p] ?? {}), ...(OVERRIDES[concept]?.[expr]?.[p] ?? {}) };
  }
  return out;
}
const manifest = {
  version: 1,
  viewBox: [0, 0, 100, 100],
  recommended: RECOMMENDED,
  locked: LOCKED,
  transform: "translate(tx ty) translate(px py) rotate(r) scale(sx sy) translate(-px -py); opacity = o. Lerp every field between two states to tween.",
  parts: PARTS,
  expressions: EXPRESSIONS,
  timing: TIMING,
  concepts: {},
};
for (const [key, c] of Object.entries(CONCEPTS)) {
  manifest.concepts[key] = { name: c.name, file: c.file, round: c.round, frames: FRAMED.includes(key), pivots: PIVOTS[key], expressions: {} };
  for (const e of EXPRESSIONS) manifest.concepts[key].expressions[e] = fullState(key, e);
}
writeFileSync(join(ROOT, "expressions.json"), JSON.stringify(manifest, null, 2) + "\n");

// ---- baking helpers ---------------------------------------------------------------------------------
function transformFor(state, pivot) {
  const [px, py] = pivot;
  return `translate(${f2(state.tx)} ${f2(state.ty)}) translate(${f2(px)} ${f2(py)}) rotate(${f2(state.r)}) scale(${f2(state.sx)} ${f2(state.sy)}) translate(${f2(-px)} ${f2(-py)})`;
}
function setPartAttrs(svg, part, attrs) {
  const re = new RegExp(`<g([^>]*?)data-part="${part}"([^>]*)>`);
  return svg.replace(re, (m, pre, post) => {
    let tag = `<g${pre}data-part="${part}"${post}`;
    for (const [k, v] of Object.entries(attrs)) {
      const kre = new RegExp(`\\s${k}="[^"]*"`);
      tag = kre.test(tag) ? tag.replace(kre, ` ${k}="${v}"`) : tag + ` ${k}="${v}"`;
    }
    return tag + ">";
  });
}
function bake(svg, concept, expr) {
  const st = manifest.concepts[concept].expressions[expr];
  let out = svg;
  for (const p of PARTS) {
    if (!out.includes(`data-part="${p}"`)) continue;
    out = setPartAttrs(out, p, { transform: transformFor(st[p], PIVOTS[concept][p]), opacity: f2(st[p].o) });
  }
  return out;
}
function boil(svg, frameSeed, amplitude = 0.4) {
  let pathIndex = 0;
  return svg.replace(/ d="([^"]*)"/g, (m, d) => {
    pathIndex += 1;
    let n = 0;
    const wobbled = d.replace(/-?\d*\.?\d+/g, (num) => {
      n += 1;
      return f2(Number(num) + jitter(frameSeed, pathIndex, n) * amplitude);
    });
    return ` d="${wobbled}"`;
  });
}

const src = {};
for (const [k, c] of Object.entries(CONCEPTS)) src[k] = readFileSync(join(ROOT, c.file), "utf8");

// ---- frames of the recommended concepts (round 1 A, round 2 E) ---------------------------------------
mkdirSync(join(ROOT, "frames"), { recursive: true });
for (const rc of FRAMED) {
  EXPRESSIONS.forEach((e, i) => {
    let frame = bake(src[rc], rc, e);
    frame = boil(frame, 17 + i * 31, SPEC[rc].pencil ? 0.3 : 0.4);
    frame = frame.replace(/<title>[^<]*<\/title>/, `<title>Sniff Test nose, frame: ${e}</title>`);
    frame = frame.replace(/<!--[\s\S]*?-->\n?/, `<!-- Baked frame "${e}" of concept ${rc.toUpperCase()}: manifest transforms applied, outlines re-wobbled for line boil. -->\n`);
    writeFileSync(join(ROOT, "frames", `${rc}-${String(i + 1).padStart(2, "0")}-${e}.svg`), frame);
  });
}

// ---- favicon cuts: construction marks dropped, weight up, filled to the box -------------------------
{
  const s = SPEC.a;
  const heavier = (list, k) => list.map((st) => ({ ...st, w: st.w.map(([u, w]) => [u, w * k + 0.6]) }));
  const fav = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Sniff Test">
  <title>Sniff Test favicon</title>
  <!-- Favicon cut of concept A (round 1): the same strokes, heavier, no construction marks, filled to the box. -->
  <g transform="translate(50 50) scale(1.24) translate(-40 -47)" fill="currentColor">
    ${strokes(heavier(s.bridge, 1.3))}
    ${strokes(heavier(s.tip, 1.25))}
    ${strokes(heavier(s.nostrilR, 1.3))}
    ${s.nostrilRShape ?? ""}
    ${strokes(heavier(s.nostrilL, 1.3))}
  </g>
</svg>
`;
  writeFileSync(join(ROOT, "favicon.svg"), fav);
}
// The pencil line is too thin to survive 16 px, so the favicon cut keeps only the main contours (no
// ghosts, hatching or lip) and puts the weight up. Still the same centrelines. It reads its widths
// from the spec it is given, so the locked E carries its weight factor into the 16 px cut.
function faviconSketchSvg(s) {
  const heavy = (list) => list.slice(0, 1).map((st) => ({ ...st, opacity: undefined, shift: undefined, tremor: 0.25, w: st.w.map(([u, w]) => [u, w * 5 + 1.8]) }));
  const fav = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Sniff Test">
  <title>Sniff Test favicon, sketch cut</title>
  <!-- Favicon cut of concept E, the locked mark: main contours only, weight up so the pencil line survives 16 px, filled to the box. -->
  <g transform="translate(50 50) scale(1.22) translate(-41 -48)" fill="currentColor">
    ${strokes(heavy(s.bridge))}
    ${strokes(heavy(s.tip))}
    ${strokes(heavy(s.nostrilR))}
    ${s.nostrilRShape.replace(/opacity="[^"]*"/, 'opacity="1"')}
  </g>
</svg>
`;
  return fav;
}
writeFileSync(join(ROOT, "favicon-sketch.svg"), faviconSketchSvg(SPEC.e));

// ---- the contact sheet ------------------------------------------------------------------------------
const stripXml = (s) => s.replace(/^\s*<\?xml[^>]*>\s*/, "").replace(/<!--[\s\S]*?-->\n?/g, "");
const frameSets = {};
for (const rc of FRAMED) frameSets[rc] = EXPRESSIONS.map((e, i) => stripXml(readFileSync(join(ROOT, "frames", `${rc}-${String(i + 1).padStart(2, "0")}-${e}.svg`), "utf8")));
const favicon = readFileSync(join(ROOT, "favicon.svg"), "utf8");
const faviconSketch = readFileSync(join(ROOT, "favicon-sketch.svg"), "utf8");
// The round 2 weights are drawn only here, in memory, for the before-and-after on the sheet.
const eBefore = conceptSvg("e", E_BEFORE);
const faviconSketchBefore = faviconSketchSvg(E_BEFORE);
const pct = (o) => Math.round(o * 100);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sniff Test nose, contact sheet</title>
<meta name="description" content="The locked Sniff Test nose: concept E at its final pencil weight, six expressions, three sizes, two grounds, with the concepts not chosen kept below as history.">
<style>
  :root { --ink:#141414; --ground:#ffffff; --ground-2:#f2f3f5; --line:#d9dbe0; --muted:#6b6f78; --nose-accent:#e4572e; --light-ground:#ffffff; --light-ink:#141414; --dark-ground:#141414; --dark-ink:#f2f2f2; --dark-line:#2e3036; }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--ground); color:var(--ink); font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width:1500px; margin:0 auto; padding:32px 24px 96px; }
  h1 { font-size:28px; margin:0 0 4px; letter-spacing:-0.01em; }
  h2 { font-size:18px; margin:48px 0 12px; padding-top:20px; border-top:1px solid var(--line); }
  h3 { font-size:15px; margin:30px 0 8px; }
  .history { margin-top:72px; padding-top:8px; border-top:3px solid var(--line); }
  .history > h2:first-child { border-top:0; margin-top:16px; }
  .pill { display:inline-block; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); vertical-align:middle; margin-left:8px; }
  .pill.on { background:var(--ink); color:var(--ground); border-color:var(--ink); }
  .ceiling { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .ceiling .ground { flex-direction:row; align-items:flex-end; justify-content:center; gap:26px; flex-wrap:wrap; }
  p { max-width:70ch; margin:0 0 10px; color:var(--muted); }
  p b { color:var(--ink); }
  .concepts { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:18px; }
  .card { border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--ground); }
  .card header { display:flex; align-items:baseline; gap:10px; padding:12px 14px 6px; }
  .card header .letter { font-size:24px; font-weight:800; }
  .card header .name { font-weight:600; }
  .card header .tag { margin-left:auto; font-size:12px; color:var(--muted); }
  .card p { padding:0 14px 10px; font-size:13px; }
  .pair { display:grid; grid-template-columns:1fr 1fr; }
  .concepts .card .pair { grid-template-columns:1fr; }
  .ground { display:flex; flex-direction:column; align-items:center; gap:8px; padding:14px 10px 16px; }
  /* The review grounds are fixed, not themed: "light" stays white when the page itself is in dark mode. */
  .ground.light { background:var(--light-ground); color:var(--light-ink); }
  .ground.dark { background:var(--dark-ground); color:var(--dark-ink); }
  .ground .row { display:flex; gap:10px; align-items:flex-end; }
  .ground .cell { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .ground .cell small { font-size:11px; opacity:0.6; }
  .ground svg { display:block; overflow:visible; }
  .toolbar { display:flex; gap:8px; align-items:center; margin:8px 0 14px; flex-wrap:wrap; }
  .toolbar button { font:inherit; font-weight:700; padding:6px 12px; border:1px solid var(--line); background:var(--ground); color:var(--ink); border-radius:8px; cursor:pointer; }
  .toolbar button[aria-pressed="true"] { background:var(--ink); color:var(--ground); border-color:var(--ink); }
  .grid { display:grid; grid-template-columns:110px 1fr 1fr; gap:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .grid .hdr { padding:8px 12px; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); background:var(--ground-2); border-bottom:1px solid var(--line); }
  .grid .lbl { padding:12px; font-weight:600; border-bottom:1px solid var(--line); display:flex; flex-direction:column; gap:4px; }
  .grid .lbl small { font-weight:400; color:var(--muted); font-size:12px; }
  .grid .ground { flex-direction:row; align-items:flex-end; justify-content:flex-start; gap:22px; padding:14px 18px; border-bottom:1px solid var(--line); }
  .grid .ground.dark { border-bottom-color:var(--dark-line); }
  .motion { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .motion .card .pair .ground { min-height:300px; justify-content:center; }
  .stage { position:relative; width:240px; height:240px; }
  .stage svg { position:absolute; inset:0; width:240px; height:240px; }
  .cap { font-size:12px; opacity:0.7; min-height:1.3em; }
  .tabs { display:flex; gap:6px; padding:10px 10px 0; border-radius:10px 10px 0 0; }
  .tabs.light { background:#e6e7ea; }
  .tabs.dark { background:#26272b; }
  .tab { display:flex; align-items:center; gap:8px; padding:8px 14px; border-radius:8px 8px 0 0; font-size:13px; }
  .tabs.light .tab { background:var(--light-ground); color:var(--light-ink); }
  .tabs.dark .tab { background:#3a3b40; color:var(--dark-ink); }
  .tab.inactive { opacity:0.55; background:transparent !important; }
  .tab svg { width:16px; height:16px; display:block; }
  .favs { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .note { font-size:12px; color:var(--muted); margin-top:6px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ink:#f2f2f2; --ground:#141414; --ground-2:#1c1d20; --line:#2e3036; --muted:#a2a6ae; } }
  :root[data-theme="dark"] { --ink:#f2f2f2; --ground:#141414; --ground-2:#1c1d20; --line:#2e3036; --muted:#a2a6ae; }
  @media (max-width:760px) { .pair, .motion, .favs, .ceiling { grid-template-columns:1fr; } .grid { grid-template-columns:90px 1fr; } .grid .ground.dark { grid-column:2; } .grid .hdr.dark { display:none; } main { padding:20px 16px 64px; } }
</style>
</head>
<body>
<main>
  <h1>Sniff Test nose, contact sheet</h1>
  <p><b>Locked: concept E, the pencil sketch, a little heavier, moved by the rig.</b> The note on round 2 was that E is fine, maybe a bit heavier, but not as heavy as A. Section 1 is that weight pass, before beside after. The rig, its parts, pivots and six expressions are unchanged. Ink is the current text colour; the only accent is one warm red on the scent and stink lines.</p>

  <h2>1. The lock: E before, E locked</h2>
  <p>The same centrelines at two weights. Main contours are ${E_LOCK.contour} times as wide and go from ${pct(E_BEFORE.bridge[0].opacity)} to ${pct(E_LOCK.contourOpacity)} percent opacity; hatching and the thin strokes are ${E_LOCK.fine} times as wide; the faint searching passes and the construction marks are untouched, so the line still reads as graphite. Rest, sniff and recoil at 16, 64 and 400 px, light and dark.</p>
  <div class="grid" id="lock"></div>

  <h3>Against A, the weight ceiling</h3>
  <p>At its heaviest the locked contour is ${f2(Math.max(...SPEC.e.tip[0].w.map((p) => p[1])))} units wide on the 100-unit canvas; concept A is ${f2(Math.max(...SPEC.a.tip[0].w.map((p) => p[1])))}. Heavier than round 2, nowhere near the inked outline.</p>
  <div class="ceiling" id="ceiling"></div>

  <h3>In a browser tab</h3>
  <p>A pencil line does not survive 16 px, so the tab icon is its own cut: E's main contours only, weight up, filled to the box. It reads its widths from the locked drawing, so it took the same factor. The earlier cut and the rig itself at 16 px sit beside it as inactive tabs.</p>
  <div class="favs" id="favs"></div>

  <h2>2. The six expressions</h2>
  <p>Six named states, each a set of per-part transforms in the expressions manifest: rest, sniff, approve, wrinkle, recoil, twitch. Shown on the locked mark; the switch puts the same rig on a drawing that was not chosen.</p>
  <div class="toolbar" id="conceptSwitch"></div>
  <div class="grid" id="grid"></div>

  <h2>3. Motion: the rig</h2>
  <p><b>R, the rig, is the pick.</b> One SVG tweened between states field by field, which is what a web page and a video template need; baked frames cannot interpolate. <b>F</b>, the six baked frames jump-cut with a little line boil, stays here for comparison, on the same beat schedule.</p>
  <div class="motion">
    <div class="card"><header><span class="letter">R</span><span class="name">Rig, tweened<span class="pill on">locked</span></span><span class="tag" id="rigCap"></span></header>
      <div class="pair"><div class="ground light"><div class="stage" id="rigLight"></div><div class="cap" data-cap></div></div><div class="ground dark"><div class="stage" id="rigDark"></div><div class="cap" data-cap></div></div></div></div>
    <div class="card"><header><span class="letter">F</span><span class="name">Frames, jump-cut with boil<span class="pill">not chosen</span></span><span class="tag" id="frCap"></span></header>
      <div class="pair"><div class="ground light"><div class="stage" id="frLight"></div><div class="cap" data-cap></div></div><div class="ground dark"><div class="stage" id="frDark"></div><div class="cap" data-cap></div></div></div></div>
  </div>

  <div class="history">
  <h2>4. History: round 1 and F<span class="pill">not chosen</span></h2>
  <p>Kept for the record. A was the round 1 pick, an inked cartoon; the note was that its edges were too bold and the shape not clearly enough a nose. F was the round 2 wildcard, the pencil in three-quarter view. Same rig and states on all of them.</p>
  <div class="grid" id="compare"></div>

  <h3>The concepts not chosen</h3>
  <p>Each at rest and in recoil, light and dark, with the 16, 32 and 64 px reads underneath.</p>
  <div class="concepts" id="concepts"></div>
  </div>
  <div class="note">Self-contained file: every SVG is inline, nothing loads from the network.</div>
</main>
<script>
const MANIFEST = ${JSON.stringify(manifest)};
const SRC = ${JSON.stringify(Object.fromEntries(Object.entries(src).map(([k, v]) => [k, stripXml(v)])))};
const BLURB = ${JSON.stringify(Object.fromEntries(Object.entries(CONCEPTS).map(([k, c]) => [k, c.blurb])))};
const FRAMES = ${JSON.stringify(frameSets)};
const FAVICON = ${JSON.stringify(stripXml(favicon))};
const FAVICON_SKETCH = ${JSON.stringify(stripXml(faviconSketch))};
const E_BEFORE = ${JSON.stringify(stripXml(eBefore))};
const FAVICON_SKETCH_BEFORE = ${JSON.stringify(stripXml(faviconSketchBefore))};
const LOCKED = MANIFEST.locked.concept;
const COMPARE = ["a", "f"];
const ORDER = [LOCKED, "f", "a", "b", "c", "d"];
const HISTORY = ORDER.filter((k) => k !== LOCKED);
const EXPR = MANIFEST.expressions;
const PARTS = MANIFEST.parts;
let uid = 0;

function instance(svgText, size) {
  const id = "i" + (++uid);
  let s = svgText.replace(/id="cut"/g, 'id="cut-' + id + '"').replace(/url\\(#cut\\)/g, 'url(#cut-' + id + ')');
  s = s.replace(/ id="(?!cut-)[^"]*"/g, "");
  const wrap = document.createElement("div");
  wrap.innerHTML = s;
  const svg = wrap.firstElementChild;
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  return svg;
}
function tf(st, pv) {
  const f = (n) => Number(n.toFixed(3));
  return "translate(" + f(st.tx) + " " + f(st.ty) + ") translate(" + pv[0] + " " + pv[1] + ") rotate(" + f(st.r) + ") scale(" + f(st.sx) + " " + f(st.sy) + ") translate(" + (-pv[0]) + " " + (-pv[1]) + ")";
}
function apply(svg, concept, state) {
  const pv = MANIFEST.concepts[concept].pivots;
  for (const p of PARTS) {
    const el = svg.querySelector('[data-part="' + p + '"]');
    if (!el || !state[p]) continue;
    el.setAttribute("transform", tf(state[p], pv[p]));
    el.setAttribute("opacity", state[p].o);
  }
}
function posed(concept, expr, size, svgText = SRC[concept]) {
  const svg = instance(svgText, size);
  apply(svg, concept, MANIFEST.concepts[concept].expressions[expr]);
  return svg;
}
function cell(svg, label) {
  const c = document.createElement("div"); c.className = "cell";
  c.appendChild(svg);
  const s = document.createElement("small"); s.textContent = label; c.appendChild(s);
  return c;
}

// 1. the lock: E at the round 2 weights beside E locked
const threeSizes = (gr, k, e, text) => { for (const n of [16, 64, 400]) gr.appendChild(cell(posed(k, e, n, text), String(n))); };
{
  const grid = document.getElementById("lock");
  grid.innerHTML = '<div class="hdr">state, weight</div><div class="hdr">light, 16 / 64 / 400</div><div class="hdr dark">dark, 16 / 64 / 400</div>';
  for (const e of ["rest", "sniff", "recoil"]) {
    for (const [name, text] of [["before, round 2", E_BEFORE], ["locked", SRC[LOCKED]]]) {
      const lbl = document.createElement("div"); lbl.className = "lbl";
      lbl.innerHTML = e + '<small>E ' + name + '</small>';
      grid.appendChild(lbl);
      for (const g of ["light", "dark"]) {
        const gr = document.createElement("div"); gr.className = "ground " + g;
        threeSizes(gr, LOCKED, e, text);
        grid.appendChild(gr);
      }
    }
  }
  const ceiling = document.getElementById("ceiling");
  for (const g of ["light", "dark"]) {
    const gr = document.createElement("div"); gr.className = "ground " + g;
    gr.appendChild(cell(posed(LOCKED, "rest", 200, E_BEFORE), "E before"));
    gr.appendChild(cell(posed(LOCKED, "rest", 200), "E locked"));
    gr.appendChild(cell(posed("a", "rest", 200), "A, not chosen"));
    ceiling.appendChild(gr);
  }
}

// 4. history: round 1 pick and the round 2 wildcard
{
  const grid = document.getElementById("compare");
  grid.innerHTML = '<div class="hdr">state, concept</div><div class="hdr">light, 16 / 64 / 400</div><div class="hdr dark">dark, 16 / 64 / 400</div>';
  for (const e of ["rest", "sniff", "recoil"]) {
    for (const k of COMPARE) {
      const c = MANIFEST.concepts[k];
      const lbl = document.createElement("div"); lbl.className = "lbl";
      lbl.innerHTML = e + '<small>' + k.toUpperCase() + ' ' + c.name + ', round ' + c.round + ', not chosen</small>';
      grid.appendChild(lbl);
      for (const g of ["light", "dark"]) {
        const gr = document.createElement("div"); gr.className = "ground " + g;
        threeSizes(gr, k, e);
        grid.appendChild(gr);
      }
    }
  }
}

// 4. the concepts not chosen
{
  const host = document.getElementById("concepts");
  for (const k of HISTORY) {
    const c = MANIFEST.concepts[k];
    const tag = "round " + c.round + (k === "a" ? " pick" : (k === "f" ? " wildcard" : "")) + ", not chosen";
    const card = document.createElement("div"); card.className = "card";
    card.innerHTML = '<header><span class="letter">' + k.toUpperCase() + '</span><span class="name">' + c.name + '</span><span class="tag">' + tag + '</span></header><p>' + BLURB[k] + '</p>';
    const pair = document.createElement("div"); pair.className = "pair";
    for (const g of ["light", "dark"]) {
      const gr = document.createElement("div"); gr.className = "ground " + g;
      const row = document.createElement("div"); row.className = "row";
      row.appendChild(cell(posed(k, "rest", 150), "rest"));
      row.appendChild(cell(posed(k, "recoil", 150), "recoil"));
      gr.appendChild(row);
      const row2 = document.createElement("div"); row2.className = "row";
      row2.appendChild(cell(posed(k, "rest", 16), "16"));
      row2.appendChild(cell(posed(k, "rest", 32), "32"));
      row2.appendChild(cell(posed(k, "rest", 64), "64"));
      row2.appendChild(cell(posed(k, "sniff", 64), "sniff 64"));
      gr.appendChild(row2);
      pair.appendChild(gr);
    }
    card.appendChild(pair);
    host.appendChild(card);
  }
}

// 2. expression grid, switchable concept
let current = LOCKED;
function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = '<div class="hdr">state</div><div class="hdr">light, 16 / 64 / 400</div><div class="hdr dark">dark, 16 / 64 / 400</div>';
  for (const e of EXPR) {
    const lbl = document.createElement("div"); lbl.className = "lbl";
    const n = MANIFEST.concepts[current].expressions[e].nose;
    lbl.innerHTML = e + '<small>nose r ' + n.r + '° t ' + n.tx + ',' + n.ty + ' s ' + n.sx + '</small>';
    grid.appendChild(lbl);
    for (const g of ["light", "dark"]) {
      const gr = document.createElement("div"); gr.className = "ground " + g;
      gr.appendChild(cell(posed(current, e, 16), "16"));
      gr.appendChild(cell(posed(current, e, 64), "64"));
      gr.appendChild(cell(posed(current, e, 400), "400"));
      grid.appendChild(gr);
    }
  }
  document.getElementById("rigCap").textContent = "concept " + current.toUpperCase();
}
{
  const bar = document.getElementById("conceptSwitch");
  for (const k of ORDER) {
    const b = document.createElement("button");
    b.textContent = k.toUpperCase() + " " + MANIFEST.concepts[k].name + (k === LOCKED ? ", locked" : "");
    b.setAttribute("aria-pressed", String(k === current));
    b.onclick = () => { current = k; for (const x of bar.children) x.setAttribute("aria-pressed", String(x === b)); renderGrid(); resetMotion(); };
    bar.appendChild(b);
  }
  renderGrid();
}

// 3. motion
const SEQ = ["rest", "sniff", "rest", "approve", "rest", "sniff", "wrinkle", "recoil", "rest", "twitch", "rest"];
const rigs = {}; let frameEls = {};
function resetMotion() {
  for (const id of ["rigLight", "rigDark"]) {
    const host = document.getElementById(id); host.innerHTML = "";
    rigs[id] = instance(SRC[current], 240); host.appendChild(rigs[id]);
  }
  const fr = FRAMES[current];
  for (const id of ["frLight", "frDark"]) {
    const host = document.getElementById(id); host.innerHTML = "";
    frameEls[id] = fr ? fr.map((f) => { const s = instance(f, 240); host.appendChild(s); return s; }) : [];
  }
  document.getElementById("frCap").textContent = fr ? "concept " + current.toUpperCase() : "no frames baked for " + current.toUpperCase();
}
resetMotion();
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function mix(a, b, t) {
  const out = {};
  for (const p of PARTS) { out[p] = {}; for (const k of Object.keys(a[p])) out[p][k] = lerp(a[p][k], b[p][k], t); }
  return out;
}
let seqIndex = 0, segStart = performance.now();
function tick(now) {
  const from = SEQ[seqIndex], to = SEQ[(seqIndex + 1) % SEQ.length];
  const timing = MANIFEST.timing[to];
  const elapsed = now - segStart;
  const t = Math.min(1, elapsed / timing.easeMs);
  const ex = MANIFEST.concepts[current].expressions;
  const state = mix(ex[from], ex[to], ease(t));
  for (const id of ["rigLight", "rigDark"]) apply(rigs[id], current, state);
  const fi = EXPR.indexOf(t < 0.5 ? from : to);
  for (const id of ["frLight", "frDark"]) frameEls[id].forEach((s, i) => { s.style.visibility = i === fi ? "visible" : "hidden"; });
  for (const c of document.querySelectorAll("[data-cap]")) c.textContent = t < 1 ? from + " → " + to : to;
  if (elapsed >= timing.easeMs + timing.holdMs) { seqIndex = (seqIndex + 1) % SEQ.length; segStart = now; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 1, continued. favicon strips
{
  const host = document.getElementById("favs");
  for (const g of ["light", "dark"]) {
    const card = document.createElement("div"); card.className = "card";
    const tabs = document.createElement("div"); tabs.className = "tabs " + g;
    const mk = (svg, text, inactive) => { const t = document.createElement("div"); t.className = "tab" + (inactive ? " inactive" : ""); t.appendChild(svg); const s = document.createElement("span"); s.textContent = text; t.appendChild(s); return t; };
    tabs.appendChild(mk(instance(FAVICON_SKETCH, 16), "Sniff Test"));
    tabs.appendChild(mk(instance(FAVICON_SKETCH_BEFORE, 16), "cut before", true));
    tabs.appendChild(mk(posed(LOCKED, "rest", 16), "rig at 16", true));
    card.appendChild(tabs);
    const gr = document.createElement("div"); gr.className = "ground " + g;
    const row = document.createElement("div"); row.className = "row";
    row.appendChild(cell(instance(FAVICON_SKETCH, 16), "locked 16"));
    row.appendChild(cell(instance(FAVICON_SKETCH, 32), "32"));
    row.appendChild(cell(instance(FAVICON_SKETCH, 64), "64"));
    row.appendChild(cell(instance(FAVICON_SKETCH, 128), "128"));
    row.appendChild(cell(instance(FAVICON_SKETCH_BEFORE, 32), "before 32"));
    row.appendChild(cell(instance(FAVICON_SKETCH_BEFORE, 64), "before 64"));
    row.appendChild(cell(instance(FAVICON, 64), "round 1 cut, not chosen"));
    gr.appendChild(row);
    card.appendChild(gr);
    host.appendChild(card);
  }
}
</script>
</body>
</html>
`;
writeFileSync(join(ROOT, "contact-sheet.html"), html);
console.log("wrote concepts a/b/c/e/f (E locked), expressions.json, frames/ (a, e), favicon.svg, favicon-sketch.svg, contact-sheet.html");
