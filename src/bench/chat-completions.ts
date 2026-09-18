/**
 * Reading a Chat Completions reply, once, for the two adapters that speak it.
 *
 * OpenRouter mirrors OpenAI's Chat Completions API, so the envelope that comes
 * back is the same in both: a `choices` list whose first entry carries the
 * message and the stop word, and a `usage` object whose completion count
 * already includes whatever the model spent thinking. The requests are not the
 * same and stay apart, because each provider takes a different set of knobs and
 * a shared request builder would end up a switch statement over providers.
 *
 * The reading is here rather than copied because a quiet disagreement between
 * the two copies would not look like a bug. It would look like two rows of one
 * table whose tokens were counted differently, which is the one thing a
 * comparison cannot survive.
 */

import { asRecord, countOf } from "./adapter.ts";

export function firstChoice(root: Record<string, unknown> | null): Record<string, unknown> | null {
  const choices = root?.["choices"];
  return Array.isArray(choices) ? asRecord(choices[0]) : null;
}

/** The answer's text, whether the model sent a string or the parts array. */
export function chatText(root: Record<string, unknown> | null): string {
  const message = asRecord(firstChoice(root)?.["message"]);
  const content = message?.["content"];
  if (typeof content === "string") return content;

  // Some models answer with the parts array the Chat Completions spec allows.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = asRecord(part)?.["text"];
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

/**
 * What the call is billed for, which is not always what it wrote.
 *
 * Both providers document `completion_tokens` as covering the reasoning tokens
 * as well as the visible answer, so the usual case is that number on its own. A
 * provider that reported the reasoning alongside rather than inside would
 * otherwise have a deep call priced as if it had only written its answer, so
 * reasoning that plainly is not inside the total is added to it. Undercounting
 * here would make the cheapest-looking row the one that thought the hardest.
 */
export function billedOutput(
  usage: Record<string, unknown> | null,
  details: Record<string, unknown> | null,
): number {
  const completion = countOf(usage?.["completion_tokens"]);
  const reasoning = countOf(details?.["reasoning_tokens"]);
  return reasoning > completion ? completion + reasoning : completion;
}
