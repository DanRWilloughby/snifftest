/**
 * A strict subset YAML reader.
 *
 * Sniff Test ships with zero runtime dependencies and has to run under `npx` on
 * Node, which has no built-in YAML parser, so rulesets are read by this file.
 * The subset is deliberately small and every construct outside it fails loudly
 * with a file and line number rather than parsing into something surprising.
 *
 * Supported: block mappings and sequences, plain and quoted scalars, literal
 * and folded block scalars with chomping, one-line flow mappings and sequences,
 * comments, and a single optional leading `---`.
 *
 * Not supported: anchors, aliases, tags, merge keys, complex keys, multiple
 * documents, tab indentation, duplicate keys, explicit block scalar indentation
 * indicators, any flow collection that spans a line break, the key `__proto__`,
 * and flow collections nested past `MAX_FLOW_DEPTH`.
 *
 * Mapping keys are always strings and are never type-coerced, so a ruleset can
 * write `criteria:` with `true:` and `false:` beneath it.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, reason: string) {
    super(`${file}:${line}: ${reason}`);
    this.name = "YamlError";
    this.file = file;
    this.line = line;
  }
}

interface SourceLine {
  /** 1-based line number in the source. */
  readonly num: number;
  /** Count of leading spaces. */
  readonly indent: number;
  /** The line with its indentation removed; comments are still attached. */
  readonly text: string;
  /** The line exactly as it appeared, used for block scalar bodies. */
  readonly raw: string;
}

/**
 * How deep one line of flow collections may nest.
 *
 * `readFlow` calls itself for every `[` or `{`, so a line of fifty thousand of
 * them used to exhaust the stack, and a stack overflow reaches the caller as
 * "could not finish" rather than as a named line of a named file. A ruleset
 * arrives from a repository somebody else wrote, so which of those two a run
 * gets is not its choice to make. Sixteen is far past anything a person writes
 * in a ruleset and far short of anything that troubles the stack.
 */
const MAX_FLOW_DEPTH = 16;

/**
 * The one mapping key that is an instruction rather than a name.
 *
 * Assigning it on a plain object runs the prototype setter instead of creating
 * an own property, so the value becomes configuration that no own-key walk sees
 * and no unknown-key warning mentions. Refused by name, the way a merge key is.
 */
const PROTOTYPE_KEY = "__proto__";

const BLOCK_SCALAR_HEADER = /^[|>]/;
const INTEGER = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/;

/** Parse a YAML document written in the supported subset. */
export function parseYaml(source: string, file = "<input>"): YamlValue {
  return new Parser(source, file).parseDocument();
}

class Parser {
  private readonly lines: SourceLine[];
  private index = 0;

  constructor(source: string, private readonly file: string) {
    this.lines = this.scan(source);
  }

  // --- scanning -----------------------------------------------------------

  private scan(source: string): SourceLine[] {
    const raws = source.replace(/\r\n?/g, "\n").split("\n");
    const lines: SourceLine[] = [];
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i] ?? "";
      const num = i + 1;
      let indent = 0;
      while (indent < raw.length) {
        const ch = raw[indent];
        if (ch === " ") {
          indent++;
          continue;
        }
        if (ch === "\t") {
          throw new YamlError(this.file, num, "tabs are not allowed in indentation, use spaces");
        }
        break;
      }
      lines.push({ num, indent, text: raw.slice(indent), raw });
    }
    return lines;
  }

  private fail(line: SourceLine, reason: string): never {
    throw new YamlError(this.file, line.num, reason);
  }

  // --- line cursor --------------------------------------------------------

  /** The next line carrying structure, skipping blanks and whole-line comments. */
  private peek(): SourceLine | null {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined) break;
      const trimmed = line.text.trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) return line;
      this.index++;
    }
    return null;
  }

  /** The structural content of a line: indentation and comments removed. */
  private content(line: SourceLine): string {
    return stripComment(line.text).trim();
  }

  private guard(line: SourceLine, text: string): void {
    if (text === "---" || text === "...") {
      this.fail(line, "multiple documents are not supported");
    }
    if (text === "?" || text.startsWith("? ")) {
      this.fail(line, "complex mapping keys are not supported");
    }
  }

  // --- document -----------------------------------------------------------

  parseDocument(): YamlValue {
    const first = this.peek();
    if (first === null) return null;
    if (this.content(first) === "---") this.index++;

    const start = this.peek();
    if (start === null) return null;
    if (start.indent !== 0) this.fail(start, "unexpected indentation at the start of the document");

    const value = this.parseNode(0);
    const trailing = this.peek();
    if (trailing !== null) {
      const text = this.content(trailing);
      this.guard(trailing, text);
      this.fail(trailing, "unexpected content after the end of the document");
    }
    return value;
  }

  private parseNode(minIndent: number): YamlValue {
    const line = this.peek();
    if (line === null || line.indent < minIndent) return null;
    const text = this.content(line);
    this.guard(line, text);
    return isSequenceItem(text) ? this.parseSequence(line.indent) : this.parseMapping(line.indent);
  }

  // --- mappings -----------------------------------------------------------

  private parseMapping(indent: number): YamlValue {
    const result: { [key: string]: YamlValue } = {};
    const seen = new Set<string>();

    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) break;
      if (line.indent > indent) this.fail(line, "unexpected indentation");

      const text = this.content(line);
      this.guard(line, text);
      if (isSequenceItem(text)) this.fail(line, "expected a mapping key, found a list item");

      const { key, rest } = this.splitKey(line, text);
      if (key === "<<") this.fail(line, "merge keys are not supported");
      if (key === PROTOTYPE_KEY) this.fail(line, `the key "${PROTOTYPE_KEY}" is not supported`);
      if (key === "") this.fail(line, "a mapping key may not be empty");
      if (seen.has(key)) this.fail(line, `duplicate key "${key}"`);
      seen.add(key);

      this.index++;
      result[key] = this.parseValue(line, rest, indent);
    }

    return result;
  }

  private splitKey(line: SourceLine, text: string): { key: string; rest: string } {
    const quote = text[0];
    if (quote === '"' || quote === "'") {
      const { value, end } = this.readQuoted(line, text, 0);
      const after = text.slice(end);
      if (!after.startsWith(":")) this.fail(line, 'expected ":" after a quoted mapping key');
      const rest = after.slice(1);
      if (rest !== "" && !rest.startsWith(" ")) {
        this.fail(line, 'expected a space after ":"');
      }
      return { key: value, rest: rest.trim() };
    }

    const at = topLevelColon(text);
    if (at === -1) this.fail(line, 'expected "key: value"');
    return { key: text.slice(0, at).trimEnd(), rest: text.slice(at + 1).trim() };
  }

  private parseValue(keyLine: SourceLine, rest: string, keyIndent: number): YamlValue {
    if (rest === "") {
      const next = this.peek();
      if (next === null) return null;
      if (next.indent > keyIndent) return this.parseNode(keyIndent + 1);
      if (next.indent === keyIndent && isSequenceItem(this.content(next))) {
        return this.parseSequence(keyIndent);
      }
      return null;
    }
    if (BLOCK_SCALAR_HEADER.test(rest)) return this.readBlockScalar(keyLine, rest, keyIndent);
    return this.parseScalarOrFlow(keyLine, rest);
  }

  // --- sequences ----------------------------------------------------------

  private parseSequence(indent: number): YamlValue {
    const items: YamlValue[] = [];

    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) break;
      if (line.indent > indent) this.fail(line, "unexpected indentation");

      const text = this.content(line);
      this.guard(line, text);
      if (!isSequenceItem(text)) break;

      const afterDash = text.slice(1);
      const lead = afterDash.length - afterDash.trimStart().length;
      const rest = afterDash.trim();

      if (rest === "") {
        this.index++;
        items.push(this.parseNode(indent + 1));
        continue;
      }
      if (BLOCK_SCALAR_HEADER.test(rest)) {
        this.index++;
        items.push(this.readBlockScalar(line, rest, indent));
        continue;
      }
      if (topLevelColon(rest) !== -1) {
        // `- id: colon_heavy` opens a mapping whose first key sits on the dash
        // line. Rewrite the line as a plain mapping line at the content column
        // and let parseMapping pick up the sibling keys below it.
        const contentIndent = indent + 1 + lead;
        this.lines[this.index] = { num: line.num, indent: contentIndent, text: rest, raw: line.raw };
        items.push(this.parseMapping(contentIndent));
        continue;
      }

      this.index++;
      items.push(this.parseScalarOrFlow(line, rest));
    }

    return items;
  }

  // --- block scalars ------------------------------------------------------

  private readBlockScalar(headerLine: SourceLine, header: string, parentIndent: number): string {
    const style = header[0];
    const chomp = header.slice(1);
    if (chomp !== "" && chomp !== "-" && chomp !== "+") {
      this.fail(headerLine, "block scalar indentation indicators are not supported");
    }

    const collected: SourceLine[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line === undefined) break;
      const blank = line.text.trim() === "";
      if (!blank && line.indent <= parentIndent) break;
      collected.push(line);
      this.index++;
    }

    const firstBody = collected.find((line) => line.text.trim() !== "");
    if (firstBody === undefined) return chomp === "+" ? "\n".repeat(collected.length) : "";
    const bodyIndent = firstBody.indent;

    const body = collected.map((line) =>
      line.text.trim() === "" ? "" : line.raw.slice(bodyIndent),
    );
    let trailingBlanks = 0;
    while (body.length > 0 && body[body.length - 1] === "") {
      body.pop();
      trailingBlanks++;
    }

    const joined = style === ">" ? fold(body) : body.join("\n");
    if (chomp === "-") return joined;
    if (chomp === "+") return joined + "\n".repeat(1 + trailingBlanks);
    return joined === "" ? "" : joined + "\n";
  }

  // --- scalars and flow ---------------------------------------------------

  private parseScalarOrFlow(line: SourceLine, text: string): YamlValue {
    if (text === "") return null;
    const head = text[0];
    if (head === "&") this.fail(line, "anchors are not supported");
    if (head === "*") this.fail(line, "aliases are not supported");
    if (head === "!") this.fail(line, "tags are not supported");

    if (head === "[" || head === "{") {
      const { value, end } = this.readFlow(line, text, 0);
      if (text.slice(end).trim() !== "") {
        this.fail(line, "unexpected content after a flow collection");
      }
      return value;
    }

    const quote = text[0];
    if (quote === '"' || quote === "'") {
      const { value, end } = this.readQuoted(line, text, 0);
      if (text.slice(end).trim() !== "") {
        this.fail(line, "unexpected content after a quoted scalar");
      }
      return value;
    }

    return plainScalar(text);
  }

  private readFlow(
    line: SourceLine,
    text: string,
    start: number,
    depth = 0,
  ): { value: YamlValue; end: number } {
    if (depth > MAX_FLOW_DEPTH) {
      this.fail(line, `flow collections are nested more than ${MAX_FLOW_DEPTH} deep`);
    }
    const open = text[start];
    const isSeq = open === "[";
    const close = isSeq ? "]" : "}";
    const kindName = isSeq ? "flow sequences" : "flow mappings";
    const unterminated = `${kindName} must be written on one line`;

    let pos = start + 1;
    const seq: YamlValue[] = [];
    const map: { [key: string]: YamlValue } = {};
    let first = true;

    for (;;) {
      pos = skipSpaces(text, pos);
      if (pos >= text.length) this.fail(line, unterminated);
      if (text[pos] === close) return { value: isSeq ? seq : map, end: pos + 1 };

      if (!first) {
        if (text[pos] !== ",") this.fail(line, `expected "," or "${close}" in a flow collection`);
        pos = skipSpaces(text, pos + 1);
        if (pos >= text.length) this.fail(line, unterminated);
        if (text[pos] === close) return { value: isSeq ? seq : map, end: pos + 1 };
      }
      first = false;

      if (isSeq) {
        const entry = this.readFlowValue(line, text, pos, close, unterminated, depth);
        seq.push(entry.value);
        pos = entry.end;
        continue;
      }

      const keyRead = this.readFlowKey(line, text, pos, unterminated);
      pos = skipSpaces(text, keyRead.end);
      if (pos >= text.length) this.fail(line, unterminated);
      if (text[pos] !== ":") this.fail(line, 'expected ":" in a flow mapping');
      pos = skipSpaces(text, pos + 1);
      if (pos >= text.length) this.fail(line, unterminated);
      const entry = this.readFlowValue(line, text, pos, close, unterminated, depth);
      if (keyRead.key === PROTOTYPE_KEY) {
        this.fail(line, `the key "${PROTOTYPE_KEY}" is not supported`);
      }
      if (Object.hasOwn(map, keyRead.key)) this.fail(line, `duplicate key "${keyRead.key}"`);
      map[keyRead.key] = entry.value;
      pos = entry.end;
    }
  }

  private readFlowKey(
    line: SourceLine,
    text: string,
    start: number,
    unterminated: string,
  ): { key: string; end: number } {
    const quote = text[start];
    if (quote === '"' || quote === "'") {
      const read = this.readQuoted(line, text, start);
      return { key: read.value, end: read.end };
    }
    let pos = start;
    while (pos < text.length && text[pos] !== ":" && text[pos] !== ",") pos++;
    if (pos >= text.length) this.fail(line, unterminated);
    const key = text.slice(start, pos).trim();
    if (key === "") this.fail(line, "a flow mapping key may not be empty");
    return { key, end: pos };
  }

  private readFlowValue(
    line: SourceLine,
    text: string,
    start: number,
    close: string,
    unterminated: string,
    depth: number,
  ): { value: YamlValue; end: number } {
    const head = text[start];
    if (head === "&") this.fail(line, "anchors are not supported");
    if (head === "*") this.fail(line, "aliases are not supported");
    if (head === "!") this.fail(line, "tags are not supported");
    if (head === "[" || head === "{") return this.readFlow(line, text, start, depth + 1);
    if (head === '"' || head === "'") {
      const read = this.readQuoted(line, text, start);
      return { value: read.value, end: read.end };
    }
    let pos = start;
    while (pos < text.length && text[pos] !== "," && text[pos] !== close) pos++;
    if (pos >= text.length) this.fail(line, unterminated);
    return { value: plainScalar(text.slice(start, pos).trim()), end: pos };
  }

  private readQuoted(
    line: SourceLine,
    text: string,
    start: number,
  ): { value: string; end: number } {
    const quote = text[start];
    let pos = start + 1;
    let out = "";

    if (quote === "'") {
      while (pos < text.length) {
        if (text[pos] === "'") {
          if (text[pos + 1] === "'") {
            out += "'";
            pos += 2;
            continue;
          }
          return { value: out, end: pos + 1 };
        }
        out += text[pos];
        pos++;
      }
      this.fail(line, "unterminated quoted scalar");
    }

    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '"') return { value: out, end: pos + 1 };
      if (ch === "\\") {
        const next = text[pos + 1];
        if (next === undefined) this.fail(line, "unterminated quoted scalar");
        if (next === "u") {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail(line, "invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 6;
          continue;
        }
        out += unescapeChar(next);
        pos += 2;
        continue;
      }
      out += ch;
      pos++;
    }
    this.fail(line, "unterminated quoted scalar");
  }
}

// --- helpers --------------------------------------------------------------

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function skipSpaces(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && text[i] === " ") i++;
  return i;
}

function unescapeChar(ch: string): string {
  switch (ch) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "0":
      return "\0";
    default:
      return ch;
  }
}

/** Index of the `:` that separates a block mapping key from its value, or -1. */
function topLevelColon(text: string): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === ":" && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === " ") return i;
    }
  }
  return -1;
}

/** Remove a trailing `# comment`, respecting quoted scalars. */
function stripComment(text: string): string {
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === " ")) return text.slice(0, i);
  }
  return text;
}

function fold(lines: readonly string[]): string {
  let out = "";
  let breaks = 0;
  let started = false;

  for (const line of lines) {
    if (line.trim() === "") {
      if (started) breaks++;
      continue;
    }
    if (!started) {
      out = line;
      started = true;
      continue;
    }
    out += breaks > 0 ? "\n".repeat(breaks) : " ";
    out += line;
    breaks = 0;
  }
  return out;
}

function plainScalar(text: string): YamlValue {
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") {
    return null;
  }
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (INTEGER.test(text) || FLOAT.test(text)) return Number(text);
  return text;
}
