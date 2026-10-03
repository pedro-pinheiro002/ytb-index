/**
 * TimeAnchor detection for YouTube comments.
 *
 * This is the algorithm locked in wayfinder #7 and specified by issue #15:
 * two families of timestamp syntaxes are recognised and normalised to absolute
 * seconds:
 *
 *  1. `h:mm:ss` — matched permissively anywhere in the text.
 *  2. `mm:ss` — only matched when anchored by a sentinel word/phrase, so that a
 *     bare `5:32` (which may be a ratio, score, etc.) is never treated as a
 *     timestamp.
 *
 * The function is pure: no `Date`, no `fs`, no network, no globals. Regexes are
 * re-created per call from `RegExp` sources so `lastIndex` state never leaks
 * between invocations.
 *
 * The snake_case field names (`raw_text`, `char_position`) mirror the
 * `time_anchors` DB columns and the build-spec wording.
 */

export type Anchor = {
  seconds: number;
  raw_text: string;
  char_position: number;
};

const HMS_MAX_SECONDS = 24 * 3600;

/** `h:mm:ss` — permissive; matched anywhere. */
const HMS_S_RE = /\b(\d{1,3}):([0-5]\d):([0-5]\d)\b/g;

/**
 * `mm:ss` — sentinel-anchored. Each pattern captures the timestamp in group 1.
 * Groups are only used to locate the timestamp within `match[0]`.
 */
const MMSS_PATTERNS = [
  /\b(?:at|@)\s+(\d{1,3}:[0-5]\d)\b/gi,
  /\b(?:jump|skip|go|fast[\s_-]?forward)\s+(?:to|until)\s+(\d{1,3}:[0-5]\d)\b/gi,
  /\b(\d{1,3}:[0-5]\d)\s+(?:mark|onwards?|forward)\b/gi,
  /\b(\d{1,3}:[0-5]\d)\s+is\s+(?:the\s+)?(?:best|key|real|important|funniest|weirdest|peak|main|part|moment|scene|climax|punchline|joke|highlight|where|when)\b/gi,
  /\b(?:from|by)\s+(\d{1,3}:[0-5]\d)\b/gi,
  /\b(\d{1,3}:[0-5]\d)\s+to\s+\d{1,3}:[0-5]\d\b/gi,
];

function parseHmsS(match: RegExpExecArray): Anchor | null {
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  if (minutes >= 60 || seconds >= 60) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  if (total > HMS_MAX_SECONDS) return null;
  return { seconds: total, raw_text: match[0], char_position: match.index };
}

function parseMmss(match: RegExpExecArray): Anchor {
  const ts = match[1]!;
  const colonAt = ts.indexOf(':');
  const minutes = Number.parseInt(ts.slice(0, colonAt), 10);
  const seconds = Number.parseInt(ts.slice(colonAt + 1), 10);
  return {
    seconds: minutes * 60 + seconds,
    raw_text: ts,
    char_position: match.index + match[0].indexOf(ts),
  };
}

export function detectAnchors(text: string): Anchor[] {
  const out: Anchor[] = [];

  const hmsRe = new RegExp(HMS_S_RE.source, HMS_S_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = hmsRe.exec(text))) {
    const a = parseHmsS(m);
    if (a) out.push(a);
  }

  for (const p of MMSS_PATTERNS) {
    const re = new RegExp(p.source, p.flags);
    while ((m = re.exec(text))) out.push(parseMmss(m));
  }

  const bySeconds = new Map<number, Anchor>();
  for (const a of out) {
    const existing = bySeconds.get(a.seconds);
    if (!existing || existing.char_position > a.char_position) bySeconds.set(a.seconds, a);
  }

  return [...bySeconds.values()].sort((a, b) => a.char_position - b.char_position);
}
