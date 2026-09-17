/**
 * Taking a credential we *know the value of* back out of a string that is about
 * to be shown to someone.
 *
 * Only one string in this tool is ever built out of something we did not write:
 * the failure body a provider sends back. That is exactly where a key can turn
 * up, because a service that rejects a request often quotes the request it
 * rejected. So the removal is exact rather than heuristic — we hold the value,
 * and we take it out.
 *
 * Prefixes count, not just the whole value. The gateway quotes at most a couple
 * of hundred characters of a failure body, so a rejection that echoes the key
 * can arrive with it cut in half, and half a credential is still a credential in
 * a scrollback or a screenshot. Sixteen characters is the floor: below that a
 * "fragment" is short enough to appear in ordinary prose, and redacting real
 * words would make the message useless without making anyone safer.
 *
 * Ported from Houston's `src/scrub.ts`, which has the same job.
 */

const MIN_SECRET_FRAGMENT = 16;

/** Below this a string is not a credential, and blanking it would eat prose. */
const MIN_SECRET_LENGTH = 8;

export const HIDDEN = "[key hidden]";

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;

  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;

    // Longest match first, so a copy is replaced at its full surviving length
    // rather than leaving a tail behind. Every shorter length is then tried as
    // well, without stopping at the first one that matched: one failure body
    // can quote the same key twice at two different truncations — once in full
    // and once cut off by the service's own logging cap — and stopping early
    // replaced the long copy and left the short one in the message.
    const floor = Math.min(secret.length, MIN_SECRET_FRAGMENT);
    for (let end = secret.length; end >= floor; end--) {
      const fragment = secret.slice(0, end);
      if (out.includes(fragment)) out = out.split(fragment).join(HIDDEN);
    }
  }

  return out;
}
