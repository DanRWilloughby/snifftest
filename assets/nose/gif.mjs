// Tweens the locked nose rig (concept E) through rest -> sniff -> rest -> approve -> rest
// and writes one SVG per frame on a white card, ink fixed to dark so it reads on any
// README theme. Rasterising and the GIF assembly happen in the shell after this.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [noseDir, outDir] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(noseDir, "expressions.json"), "utf8"));
const concept = manifest.concepts[manifest.locked.concept];
const svg = readFileSync(join(noseDir, concept.file), "utf8");
const FPS = 24;

// beats: [expression, holdMs, easeIntoMs]
const beats = [
  ["rest", 420, 0],
  ["sniff", 380, 220],
  ["rest", 260, 320],
  ["sniff", 300, 180],
  ["rest", 200, 260],
  ["approve", 760, 360],
  ["rest", 520, 340],
];

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

function stateAt(msIn) {
  let ms = msIn;
  let prev = concept.expressions[beats[0][0]];
  for (const [name, hold, easeMs] of beats) {
    const target = concept.expressions[name];
    if (ms < easeMs) {
      const t = ease(ms / easeMs);
      const out = {};
      for (const part of Object.keys(target)) {
        out[part] = {};
        for (const k of Object.keys(target[part])) out[part][k] = lerp(prev[part][k], target[part][k], t);
      }
      return out;
    }
    ms -= easeMs;
    if (ms < hold) return target;
    ms -= hold;
    prev = target;
  }
  return prev;
}

const total = beats.reduce((n, [, h, e]) => n + h + e, 0);
const frames = Math.round((total / 1000) * FPS);
mkdirSync(outDir, { recursive: true });

function render(state) {
  let out = svg;
  for (const [part, s] of Object.entries(state)) {
    const [px, py] = concept.pivots[part] ?? [50, 50];
    const transform = `translate(${s.tx} ${s.ty}) translate(${px} ${py}) rotate(${s.r}) scale(${s.sx} ${s.sy}) translate(${-px} ${-py})`;
    const re = new RegExp(`<g([^>]*\\sdata-part="${part}"[^>]*)>`);
    out = out.replace(re, (m, attrs) => {
      const cleaned = attrs.replace(/\s(transform|opacity|style)="[^"]*"/g, "");
      return `<g${cleaned} transform="${transform}" style="opacity:${s.o}">`;
    });
  }
  // White card behind everything, ink fixed dark, accent warm red.
  out = out.replace(
    /<svg([^>]*)>/,
    `<svg$1 style="color:#17181A;--nose-accent:#e4572e"><rect x="0" y="0" width="100" height="100" fill="#ffffff"/>`,
  );
  out = out.replace(/var\(--nose-accent, #e4572e\)/g, "#e4572e");
  return out;
}

for (let i = 0; i < frames; i++) {
  const ms = (i / FPS) * 1000;
  writeFileSync(join(outDir, `f-${String(i).padStart(3, "0")}.svg`), render(stateAt(ms)));
}
console.log(`${frames} frames at ${FPS} fps, ${total} ms loop`);
