# The Sniff Test nose

The mascot is a nose. One rigged SVG, six named expressions, a favicon cut, and a set of
baked frames. Everything here is hand-placed vector: no raster, no image model, no traced
source, no fonts, no dependencies.

## Locked

The mark is **concept E**, the pencil profile, at a slightly heavier weight than it was first
drawn, and it moves by **the rig**: one SVG tweened between expression states, not the baked
frames. The manifest says so in `locked: { "concept": "e", "motion": "rig" }`. A consumer reads
`expressions.json`, takes `concepts[locked.concept]` for the SVG `file`, the `pivots` and the six
`expressions`, inlines that file, and lerps every field between two states (see The rig below).
The tab icon is `favicon-sketch.svg`. Everything else in this directory is history, not chosen.

## Files

| Path | What it is |
| --- | --- |
| `concepts/e-sketch.svg` | **The locked mark.** Pencil profile: brow into bridge, round tip, wing, nostril, lip hint, hatching. |
| `concepts/f-sketch-3q.svg` | Round 2 wildcard, not chosen. Pencil three-quarter view, both wings and nostrils, philtrum below. |
| `concepts/a-snoot.svg` | Round 1 pick, not chosen. Profile nose, ink line. |
| `concepts/b-bulb.svg` | Round 1, not chosen. Front-on bulb, two nostrils. Strongest silhouette at 16 px. |
| `concepts/c-beak.svg` | Round 1, not chosen. Long pointed profile. |
| `concepts/d-blot.svg` | Round 1 wildcard, not chosen. Solid ink silhouette with knock-out nostril (mask). |
| `expressions.json` | The rig manifest: `locked`, parts, pivots, six expressions per concept, beat timing, `round` and `frames` per concept. |
| `frames/e-01-rest.svg` … `e-06-twitch.svg`, `frames/a-*.svg` | E and A baked one state per file with a little line boil. The alternative to tweening, not chosen. |
| `favicon-sketch.svg` | **The tab icon.** E's main contours only, weight up so the pencil line survives 16 px. |
| `nose.gif` | **The README image.** The rig tweened through rest, sniff, sniff, approve on a white card with the ink fixed dark, because a GitHub README does not pass its text colour into an `<img>` and the bare SVG vanished on the dark theme. The one raster in this directory, and it is generated. |
| `gif.mjs` | Writes the frames for `nose.gif` from `expressions.json` and the locked SVG: `node gif.mjs assets/nose <out>`, then `rsvg-convert` each frame at 480 px on white and `ffmpeg` with a 64-colour palette at 24 fps. |
| `favicon.svg` | Round 1 favicon, not chosen: A's strokes, heavier, filled to the box. |
| `contact-sheet.html` | Self-contained review page: E before and E locked at 16, 64 and 400 px on light and dark, the tab mock, the six expressions, the rig in motion, then round 1 and F as history. Open it in a browser. |
| `build.mjs` | Regenerates A, B, C, E, F, the manifest, frames, favicons and the contact sheet. `bun assets/nose/build.mjs assets/nose`. D is hand-authored and only read. |

## Round 2: the pencil sketch

Round 1 was an inked cartoon; the note was that the edges were too bold and the shape not
clearly enough a nose. Round 2 keeps the rig and redraws in pencil:

- The main contour is thin and drawn at partial opacity, so it reads as graphite rather than ink
  on both grounds. As first drawn it was about 1.3 units at its heaviest on a 100-unit canvas, at
  80 percent. The lock (`E_LOCK` in `build.mjs`) is a weight pass over the same centrelines: main
  contours 1.5 times as wide (about 1.95 units) at 90 percent, hatching and thin strokes 1.25
  times as wide, nostril fill a touch darker. Concept A's line is 9.2 units, so E stays a sketch.
- Two fainter passes shadow each contour, offset by under a unit: the searching line of a
  quick sketch. Construction marks (a circle for the tip, a guide for the bridge) sit at 0.16.
  The lock leaves both alone.
- Hatching (short bowed strokes, 0.625 wide once locked) shades under the tip and beside the bridge; the
  nostril is a soft fill with hatch inside it, not a solid blob.
- The anatomy is explicit: brow into bridge, round tip, ala (wing), nostril, and a lip hint
  below the columella in a static `lip` group inside `nose`, so the silhouette reads as a nose
  on a face rather than a hook or a shell.

A pencil line does not survive 16 px, so `favicon-sketch.svg` is the same centrelines with the
weight up and only the main contours. Use it for the tab icon and the rig for everything else.

## How the drawing works

Each stroke is a hand-placed centreline (`M` plus absolute cubic `C` segments) and a width
profile, for example `[[0, 2.2], [0.35, 4.6], [1, 5.6]]` meaning thin at the start, thick at
the end. `build.mjs` samples the centreline, offsets each side by half the width, adds a
deterministic tremor (integer hash, no randomness, so every build is byte-identical), and
closes the outline with cubic round caps. The result is a filled `currentColor` path that
reads as an ink line: tapered, slightly wobbly, heavier where a pen would press.

Colour is `currentColor` for the ink and `var(--nose-accent, #e4572e)` for the one accent
(scent wisps, stink lines, tick and flick marks). Set `color` on the host element for the
ink and the CSS variable for the accent. The nose sits on white and on near-black; never
on a cream ground.

## The rig

Every concept carries the same part tree, each part a `<g>` with `id` and `data-part`:

```
stage
  nose                 whole head; rotate/translate this for the big moves
    construction       pencil circle and guide line, opacity 0.16 at rest
    bridge             the line down from the brow
      wrinkle          three slashes across the bridge, opacity 0 at rest
    tip                the bulb
    nostril-r          near wing and nostril
    nostril-l          far nostril
  scent                accent wisps, opacity 0 at rest
  stink                accent zigzags, opacity 0 at rest
  marks
    mark-ok            two accent sparkles
    mark-flick         two accent dashes
```

Use `[data-part="…"]` rather than `id` when you inline more than one copy on a page, and
rename the mask id `cut` in concept D per instance.

Each expression is a map of part name to `{ tx, ty, r, sx, sy, o }`. Apply it as

```
transform = translate(tx ty) translate(px py) rotate(r) scale(sx sy) translate(-px -py)
opacity   = o
```

where `[px, py]` is that part's pivot from `expressions.json`. Every expression lists every
part, so a tween is a field-by-field lerp between two states; there is nothing to special-case.

### Expressions

| Name | Reads as | What moves (concept A) |
| --- | --- | --- |
| `rest` | neutral | identity everywhere |
| `sniff` | sniffing | nose rotate -5°, lift 1.5; nostrils scale 1.2 to 1.25; scent wisps on and drift 4 |
| `approve` | approving | nose rotate -9°, lift 3; nostrils relax to 0.92; tick marks on |
| `wrinkle` | suspicious | nose rotate 4°, drop 1; bridge compress 0.9; wrinkles on; nostrils pinch 0.85 and rotate 8°; stink half on |
| `recoil` | recoiling | nose translate 9,-4, rotate 12°, scale 0.94; nostrils flare 1.25 to 1.3; wrinkles 0.7; stink on |
| `twitch` | a flick | nose rotate -4°; right nostril 1.18×1.1 rotate -6°; left nostril 0.9; flick marks on |

Concept B overrides the head moves so the front-on face lifts and drops without rotating;
F does the same with a small rotation. `timing` in the manifest gives a hold and ease per
state for a default loop.

### Rig or frames

The rig is one file and tweens smoothly between states; that is what a web page and a
programmatic video template want. The frames are the same drawing baked one state per file
with every coordinate nudged, so a jump-cut through them looks like a hand-drawn cycle.
The contact sheet shows both side by side. The rig is the pick: a page and a video template
tween between states, and baked frames cannot interpolate. The frames stay as history.

## Consumers

- Web page: inline the file named by `concepts[locked.concept].file` (`concepts/e-sketch.svg`), set the six states from `expressions.json`, tween
  with a lerp on a `requestAnimationFrame` loop or CSS transitions on `transform` and
  `opacity` (set `transform-box: fill-box; transform-origin` per part if you go the CSS route).
  Use `favicon-sketch.svg` as the tab icon.
- Video template: read the manifest, interpolate two states for the current frame, write
  `transform` and `opacity` per part.

## Credit and license

Drawn for the Sniff Test project by Dan Willoughby with Claude Code, as hand-placed
centreline coordinates and width profiles in `build.mjs` and hand-written paths in
`concepts/d-blot.svg`. No generative image model, no stock, no traced reference.

MIT, the same license as the rest of this repository. Attribution appreciated, not required.
