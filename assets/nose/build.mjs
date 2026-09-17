// Builds assets/nose/{concepts/a,b,c.svg, expressions.json, frames/*.svg, favicon.svg, contact-sheet.html}.
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
const strokes = (list, extra = "") => list.map((s) => `<path${extra}${s.opacity ? ` opacity="${s.opacity}"` : ""} d="${expand(s)}"/>`).join("\n        ");

// ---- the drawings ------------------------------------------------------------------------------
const W = {
  thinTaper: [[0, 0.9], [0.5, 2.6], [1, 0.9]],
  wisp: [[0, 1], [0.5, 2.8], [1, 1]],
  shine: [[0, 0.5], [0.5, 1.3], [1, 0.5]],
};
const ACCENT = "var(--nose-accent, #e4572e)";

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
};

function conceptSvg(key) {
  const s = SPEC[key];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Sniff Test nose">
  <title>${s.title}</title>
  <!--
    Hand-drawn: each contour is a hand-placed centreline with a width profile, expanded into a
    tapered outline with a little tremor (assets/nose/build.mjs holds the drawing). No raster, no
    image generation. Ink is currentColor so the mark sits on any ground; the one accent is the CSS
    variable nose-accent. Every rig part carries id + data-part (use data-part when several copies
    share a page). Transforms are applied by consumers per assets/nose/expressions.json.
  -->
  <g id="stage" data-part="stage" stroke-linecap="round" stroke-linejoin="round">
    <g id="nose" data-part="nose" fill="currentColor" stroke="none">
      <g id="construction" data-part="construction" opacity="0.16" fill="none" stroke="currentColor" stroke-width="1.4">
        ${s.construction.join("\n        ")}
      </g>
      <g id="bridge" data-part="bridge">
        ${strokes(s.bridge)}
        <g id="wrinkle" data-part="wrinkle" opacity="0">
          ${strokes(s.wrinkle)}
        </g>
      </g>
      <g id="tip" data-part="tip">
        ${strokes(s.tip)}
      </g>
      <g id="nostril-r" data-part="nostril-r">
        ${strokes(s.nostrilR)}
        ${s.nostrilRShape ?? ""}
      </g>
      <g id="nostril-l" data-part="nostril-l">
        ${strokes(s.nostrilL)}
        ${s.nostrilLShape ?? ""}
      </g>
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
  a: { name: "Snoot", file: "concepts/a-snoot.svg", blurb: SPEC.a.blurb },
  b: { name: "Bulb", file: "concepts/b-bulb.svg", blurb: SPEC.b.blurb },
  c: { name: "Beak", file: "concepts/c-beak.svg", blurb: SPEC.c.blurb },
  d: { name: "Blot", file: "concepts/d-blot.svg", blurb: "Solid ink silhouette, knock-out nostril. Woodcut weight; wins at 16 px, loses the pen line." },
};
for (const k of ["a", "b", "c"]) writeFileSync(join(ROOT, CONCEPTS[k].file), conceptSvg(k));
const RECOMMENDED = "a";

// ---- expression manifest --------------------------------------------------------------------------
const PARTS = ["nose", "bridge", "tip", "nostril-l", "nostril-r", "wrinkle", "construction", "scent", "stink", "mark-ok", "mark-flick"];
const ID = { tx: 0, ty: 0, r: 0, sx: 1, sy: 1, o: 1 };
const PIVOTS = {
  a: { nose: [60, 12], bridge: [43, 40], tip: [33, 66], "nostril-r": [54, 70], "nostril-l": [15, 76], wrinkle: [50, 28], construction: [33, 60], scent: [10, 80], stink: [10, 80], "mark-ok": [18, 30], "mark-flick": [72, 18] },
  b: { nose: [50, 28], bridge: [50, 48], tip: [50, 66], "nostril-l": [34, 71], "nostril-r": [66, 71], wrinkle: [50, 37], construction: [50, 50], scent: [50, 85], stink: [50, 85], "mark-ok": [50, 25], "mark-flick": [82, 16] },
  c: { nose: [66, 8], bridge: [25, 51], tip: [18, 64], "nostril-r": [50, 62], "nostril-l": [7, 65], wrinkle: [49, 28], construction: [30, 40], scent: [14, 86], stink: [14, 86], "mark-ok": [20, 36], "mark-flick": [80, 18] },
  d: { nose: [58, 8], bridge: [46, 42], tip: [34, 66], "nostril-r": [54, 76], "nostril-l": [16, 76], wrinkle: [50, 28], construction: [33, 60], scent: [10, 80], stink: [10, 80], "mark-ok": [18, 30], "mark-flick": [72, 18] },
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
  for (const p of PARTS) out[p] = { ...ID, o: REST_OPACITY[p] ?? 1, ...(BASE[expr][p] ?? {}), ...(OVERRIDES[concept]?.[expr]?.[p] ?? {}) };
  return out;
}
const manifest = {
  version: 1,
  viewBox: [0, 0, 100, 100],
  recommended: RECOMMENDED,
  transform: "translate(tx ty) translate(px py) rotate(r) scale(sx sy) translate(-px -py); opacity = o. Lerp every field between two states to tween.",
  parts: PARTS,
  expressions: EXPRESSIONS,
  timing: TIMING,
  concepts: {},
};
for (const [key, c] of Object.entries(CONCEPTS)) {
  manifest.concepts[key] = { name: c.name, file: c.file, pivots: PIVOTS[key], expressions: {} };
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

// ---- frames of the recommended concept --------------------------------------------------------------
mkdirSync(join(ROOT, "frames"), { recursive: true });
EXPRESSIONS.forEach((e, i) => {
  let frame = bake(src[RECOMMENDED], RECOMMENDED, e);
  frame = boil(frame, 17 + i * 31);
  frame = frame.replace(/<title>[^<]*<\/title>/, `<title>Sniff Test nose, frame: ${e}</title>`);
  frame = frame.replace(/<!--[\s\S]*?-->\n?/, `<!-- Baked frame "${e}" of concept ${RECOMMENDED.toUpperCase()}: manifest transforms applied, outlines re-wobbled for line boil. -->\n`);
  writeFileSync(join(ROOT, "frames", `${RECOMMENDED}-${String(i + 1).padStart(2, "0")}-${e}.svg`), frame);
});

// ---- favicon cut: construction marks dropped, weight up, filled to the box -------------------------
{
  const s = SPEC[RECOMMENDED];
  const heavier = (list, k) => list.map((st) => ({ ...st, w: st.w.map(([u, w]) => [u, w * k + 0.6]) }));
  const fav = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Sniff Test">
  <title>Sniff Test favicon</title>
  <!-- Favicon cut of the recommended concept: the same strokes, heavier, no construction marks, filled to the box. -->
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

// ---- the contact sheet ------------------------------------------------------------------------------
const frames = EXPRESSIONS.map((e, i) => readFileSync(join(ROOT, "frames", `${RECOMMENDED}-${String(i + 1).padStart(2, "0")}-${e}.svg`), "utf8"));
const favicon = readFileSync(join(ROOT, "favicon.svg"), "utf8");
const stripXml = (s) => s.replace(/^\s*<\?xml[^>]*>\s*/, "").replace(/<!--[\s\S]*?-->\n?/g, "");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sniff Test nose, contact sheet</title>
<meta name="description" content="Four hand-drawn nose concepts, six expressions, three sizes, two grounds. Pick a letter.">
<style>
  :root { --ink:#141414; --ground:#ffffff; --ground-2:#f2f3f5; --line:#d9dbe0; --muted:#6b6f78; --nose-accent:#e4572e; --dark-ground:#141414; --dark-ink:#f2f2f2; --dark-line:#2e3036; }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--ground); color:var(--ink); font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width:1500px; margin:0 auto; padding:32px 24px 96px; }
  h1 { font-size:28px; margin:0 0 4px; letter-spacing:-0.01em; }
  h2 { font-size:18px; margin:48px 0 12px; padding-top:20px; border-top:1px solid var(--line); }
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
  .ground.light { background:var(--ground); color:var(--ink); }
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
  .tabs.light .tab { background:var(--ground); color:var(--ink); }
  .tabs.dark .tab { background:#3a3b40; color:var(--dark-ink); }
  .tab.inactive { opacity:0.55; background:transparent !important; }
  .tab svg { width:16px; height:16px; display:block; }
  .favs { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .note { font-size:12px; color:var(--muted); margin-top:6px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ink:#f2f2f2; --ground:#141414; --ground-2:#1c1d20; --line:#2e3036; --muted:#a2a6ae; } }
  :root[data-theme="dark"] { --ink:#f2f2f2; --ground:#141414; --ground-2:#1c1d20; --line:#2e3036; --muted:#a2a6ae; }
  @media (max-width:760px) { .pair, .motion, .favs { grid-template-columns:1fr; } .grid { grid-template-columns:90px 1fr; } .grid .ground.dark { grid-column:2; } .grid .hdr.dark { display:none; } main { padding:20px 16px 64px; } }
</style>
</head>
<body>
<main>
  <h1>Sniff Test nose, contact sheet</h1>
  <p>Four hand-drawn concepts, then the recommended one in every expression at 16, 64 and 400 px on light and dark, then rig versus frames in motion. <b>Pick a concept with a letter (A, B, C, D) and a motion style with a letter (R rig, F frames).</b> Ink is the current text colour; the only accent is one warm red on the scent and stink lines.</p>

  <h2>1. Concepts</h2>
  <p>Each at rest and in recoil, light and dark, with the 16, 32 and 64 px reads underneath. Recommended: <b>A, Snoot</b>. Wildcard: <b>D, Blot</b> for the strongest favicon.</p>
  <div class="concepts" id="concepts"></div>

  <h2>2. Expressions at 16, 64 and 400 px</h2>
  <p>Six named states, each a set of per-part transforms in the expressions manifest: rest, sniff, approve, wrinkle, recoil, twitch. Switch the concept to see the same rig on another drawing.</p>
  <div class="toolbar" id="conceptSwitch"></div>
  <div class="grid" id="grid"></div>

  <h2>3. Motion: rig versus frames</h2>
  <p><b>R</b> tweens the one rigged SVG between states (what the serve page and the reel would do). <b>F</b> jump-cuts through six baked frames whose lines were redrawn with a little boil, the way a hand-drawn cycle looks. Same beat schedule on both.</p>
  <div class="motion">
    <div class="card"><header><span class="letter">R</span><span class="name">Rig, tweened</span><span class="tag" id="rigCap"></span></header>
      <div class="pair"><div class="ground light"><div class="stage" id="rigLight"></div><div class="cap" data-cap></div></div><div class="ground dark"><div class="stage" id="rigDark"></div><div class="cap" data-cap></div></div></div></div>
    <div class="card"><header><span class="letter">F</span><span class="name">Frames, jump-cut with boil</span><span class="tag">concept A only</span></header>
      <div class="pair"><div class="ground light"><div class="stage" id="frLight"></div><div class="cap" data-cap></div></div><div class="ground dark"><div class="stage" id="frDark"></div><div class="cap" data-cap></div></div></div></div>
  </div>

  <h2>4. In a browser tab</h2>
  <p>The rig itself at 16 px beside a favicon cut of the same strokes (construction marks dropped, weight up, filled to the box).</p>
  <div class="favs" id="favs"></div>
  <div class="note">Self-contained file: every SVG is inline, nothing loads from the network.</div>
</main>
<script>
const MANIFEST = ${JSON.stringify(manifest)};
const SRC = ${JSON.stringify(Object.fromEntries(Object.entries(src).map(([k, v]) => [k, stripXml(v)])))};
const BLURB = ${JSON.stringify(Object.fromEntries(Object.entries(CONCEPTS).map(([k, c]) => [k, c.blurb])))};
const FRAMES = ${JSON.stringify(frames.map(stripXml))};
const FAVICON = ${JSON.stringify(stripXml(favicon))};
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
function posed(concept, expr, size) {
  const svg = instance(SRC[concept], size);
  apply(svg, concept, MANIFEST.concepts[concept].expressions[expr]);
  return svg;
}
function cell(svg, label) {
  const c = document.createElement("div"); c.className = "cell";
  c.appendChild(svg);
  const s = document.createElement("small"); s.textContent = label; c.appendChild(s);
  return c;
}

// 1. concepts
{
  const host = document.getElementById("concepts");
  for (const [k, c] of Object.entries(MANIFEST.concepts)) {
    const card = document.createElement("div"); card.className = "card";
    card.innerHTML = '<header><span class="letter">' + k.toUpperCase() + '</span><span class="name">' + c.name + '</span><span class="tag">' + (k === MANIFEST.recommended ? "recommended" : "") + '</span></header><p>' + BLURB[k] + '</p>';
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
let current = MANIFEST.recommended;
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
  for (const k of Object.keys(MANIFEST.concepts)) {
    const b = document.createElement("button");
    b.textContent = k.toUpperCase() + " " + MANIFEST.concepts[k].name;
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
  for (const id of ["frLight", "frDark"]) {
    const host = document.getElementById(id); host.innerHTML = "";
    frameEls[id] = FRAMES.map((f) => { const s = instance(f, 240); host.appendChild(s); return s; });
  }
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

// 4. favicon strips
{
  const host = document.getElementById("favs");
  for (const g of ["light", "dark"]) {
    const card = document.createElement("div"); card.className = "card";
    const tabs = document.createElement("div"); tabs.className = "tabs " + g;
    const mk = (svg, text, inactive) => { const t = document.createElement("div"); t.className = "tab" + (inactive ? " inactive" : ""); t.appendChild(svg); const s = document.createElement("span"); s.textContent = text; t.appendChild(s); return t; };
    tabs.appendChild(mk(posed(MANIFEST.recommended, "rest", 16), "Sniff Test, rig at 16"));
    tabs.appendChild(mk(instance(FAVICON, 16), "Sniff Test, favicon cut", true));
    tabs.appendChild(mk(posed(MANIFEST.recommended, "recoil", 16), "recoil at 16", true));
    card.appendChild(tabs);
    const gr = document.createElement("div"); gr.className = "ground " + g;
    const row = document.createElement("div"); row.className = "row";
    row.appendChild(cell(posed(MANIFEST.recommended, "rest", 32), "rig 32"));
    row.appendChild(cell(instance(FAVICON, 32), "favicon 32"));
    row.appendChild(cell(instance(FAVICON, 64), "favicon 64"));
    row.appendChild(cell(instance(FAVICON, 128), "favicon 128"));
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
console.log("wrote concepts a/b/c, expressions.json, frames/, favicon.svg, contact-sheet.html");
