/**
 * Putting the page together.
 *
 * The page is one HTML file with its style and script inline, the nose inlined
 * as SVG, and nothing else: no font, no script, no image from anywhere. The
 * bundler carries all three files into the one published script as text, so
 * there is no asset directory to find at run time and no path to get wrong.
 *
 * The nose is A9's locked rig, read from `assets/nose/` where A9 keeps it. Only
 * the locked concept's pivots and expressions reach the browser.
 *
 * Everything the server tells the page travels as one JSON literal. It is
 * escaped so that no value in it, whatever it says, can close the script
 * element it sits in.
 */

// The `text` attribute makes each of these the file's contents as a string.
import noseSvg from "../../assets/nose/concepts/e-sketch.svg" with { type: "text" };
import faviconSource from "../../assets/nose/favicon-sketch.svg" with { type: "text" };
import manifest from "../../assets/nose/expressions.json";
import pageSource from "./page.html" with { type: "text" };

export interface PageConfig {
  readonly mode: "live" | "replay";
  /** Whether the judgment rules are in play. False means countable rules only. */
  readonly judged: boolean;
  readonly debounceMs: number;
  readonly threshold: number;
  /**
   * Replay only: hold each answer on the page clock for its recorded latency, so
   * the sniff lasts as long as the request really took and lands on the same
   * frame of a capture every time.
   */
  readonly holdForRecordedLatency: boolean;
  /** One plain sentence under the meter: what mode this is and what leaves the machine. */
  readonly modeLine: string;
  /** Where the meter's numbers come from: measured, replayed, or example numbers. */
  readonly meterLabel: string;
}

// SAFETY: bun-types declares `*.html` as an HTMLBundle, but the `type: "text"`
// import attribute above makes the runtime value the file's text.
const PAGE_HTML = pageSource as unknown as string;

/** The concept A9 locked. The manifest names it; a manifest that names nothing it holds is a broken build. */
const LOCKED = lockedConcept();

function lockedConcept(): (typeof manifest.concepts)[keyof typeof manifest.concepts] {
  for (const [name, concept] of Object.entries(manifest.concepts)) {
    if (name === manifest.locked.concept) return concept;
  }
  throw new Error(`assets/nose/expressions.json locks concept "${manifest.locked.concept}", which it does not define.`);
}

const RIG = {
  parts: manifest.parts,
  pivots: LOCKED.pivots,
  expressions: LOCKED.expressions,
  timing: manifest.timing,
};

export function renderPage(config: PageConfig, nonce: string): string {
  return PAGE_HTML.replaceAll("__NONCE__", escapeHtml(nonce))
    .replace("__MODE__", config.mode)
    // Function replacers, so a "$&" in a value is text and not a pattern.
    .replace("__MODE_LINE__", () => escapeHtml(config.modeLine))
    .replace("__METER_LABEL__", () => escapeHtml(config.meterLabel))
    .replace("<!--NOSE-->", () => decorativeNose())
    .replace("__RIG_JSON__", () => scriptSafeJson(RIG))
    .replace("__CONFIG_JSON__", () => scriptSafeJson(config));
}

export function faviconSvg(): string {
  return faviconSource;
}

/**
 * The rig as page furniture: the actor is decorative, so it loses its title,
 * its role and its label, and takes its size from the stylesheet.
 */
function decorativeNose(): string {
  return noseSvg
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replace(/<title>[\s\S]*?<\/title>\s*/, "")
    .replace(/<svg\b[^>]*>/, (tag: string) => {
      const viewBox = /viewBox="([^"]+)"/.exec(tag)?.[1] ?? "0 0 100 100";
      return `<svg class="nose" id="actor" viewBox="${viewBox}" aria-hidden="true" focusable="false">`;
    });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** JSON that is also safe inside a script element: no `<`, no line separators. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
