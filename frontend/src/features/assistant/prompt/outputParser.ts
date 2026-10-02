/**
 * Parses the v1 wire format the model is instructed to emit (spec
 * browser-ai.md §11.3): 5 header lines (order-independent), a `---`
 * separator, then the free-text body. Also exposes a streaming variant
 * (§15.3) that forwards only body text as it arrives, since the header lines
 * themselves are never shown to the user.
 *
 * Both `parseAssistantOutput()` and `StreamingParser.finish()` run the exact
 * same validation over the accumulated raw text (`parseRaw()` below) so the
 * two code paths cannot diverge.
 */

/** §11.3 wire format's 5 required header keys, in the order they appear in the spec example. */
export const HEADER_KEYS: readonly ['intent', 'route', 'slots', 'confidence', 'clarify'] = [
  'intent',
  'route',
  'slots',
  'confidence',
  'clarify',
]
type HeaderKey = (typeof HEADER_KEYS)[number]

export const HEADER_SEPARATOR = '---'
/** §11.3: "ヘッダが --- なしに 8 行を超えた... 場合はパース失敗". */
export const MAX_HEADER_LINES = 8

/**
 * Used when the model omits `confidence:` entirely. Deliberately just above
 * `ASSISTANT_CONFIG.thresholds.minConfidence` (0.5, §11.6) so a missing line
 * does not silently become a low-confidence rejection - confidence is only a
 * lower-bound sanity check (§11.6), never the primary gate, which is `clarify`
 * plus Playbook slot satisfaction.
 */
const DEFAULT_CONFIDENCE = 0.6

export type ParseFailureReason =
  | 'header_incomplete'
  | 'header_too_long'
  | 'unknown_header_key'
  | 'duplicate_header_key'
  | 'malformed_value'
  | 'missing_separator'
  | 'empty_body'

export interface DecisionHeader {
  intent: string
  route: string | null
  slots: Record<string, string>
  confidence: number
  clarify: boolean
}

export interface ParsedOutput {
  header: DecisionHeader
  body: string
  /**
   * `true` when no `HEADER_KEYS` line was found anywhere in the response (a
   * genuinely free-text reply, not a §11.3 wire-format decision) - `header`
   * is filled with `UNKNOWN`-mapping defaults (`intent: ''`, `route: null`,
   * `slots: {}`, `clarify: false`) and `body` is the whole trimmed response.
   * Absent (not `false`) on every ordinary successful parse, so existing
   * equality assertions on a normal `ParsedOutput` are unaffected.
   */
  headerless?: boolean
}

type ParseResult = { ok: true; value: ParsedOutput } | { ok: false; reason: ParseFailureReason }

function failure(reason: ParseFailureReason): ParseResult {
  return { ok: false, reason }
}

/**
 * Small local models frequently wrap a plain-text answer in a markdown code
 * fence (```` ``` ````, sometimes ```` ```text ````) even when not asked to.
 * If the whole trimmed response is fenced, strip the fence before parsing;
 * otherwise leave the text untouched (a fence that doesn't wrap the entire
 * response is left as literal body content).
 */
function stripWholeResponseCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return text
  const lines = trimmed.split('\n')
  if (lines.length < 2 || lines.at(-1)!.trim() !== '```') return text
  return lines.slice(1, -1).join('\n')
}

/**
 * Qwen3 thinking block.
 *
 * ⚠️ This is not a hypothetical: §15.4 mandates `extra_body: { enable_thinking:
 * false }`, and WebLLM implements that by **pushing the tokens of
 * `"<think>\n\n</think>\n\n"` into the response itself** (`llm_chat.ts`:
 * `appendEmptyThinkingReplyHeader`), so EVERY reply this app receives starts
 * with that literal block. Without stripping it the first header line reads
 * `<think>`, which is not a `key: value` pair - the parse failed with
 * `unknown_header_key` on every single turn and the user only ever saw §11.5's
 * fixed "案内先を判断できませんでした" message. Also covers the case where a
 * model emits a real, non-empty thinking block anyway.
 */
const THINKING_BLOCK_PATTERN = /^\s*<think>[\s\S]*?<\/think>\s*/

function stripThinkingBlock(text: string): string {
  return text.replace(THINKING_BLOCK_PATTERN, '')
}

/** Normalizes `\r\n` to `\n` and drops a single leading blank line, if present. */
function normalizeLineEndingsAndLeadingBlank(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== undefined && lines[0].trim() === '') lines.shift()
  return lines.join('\n')
}

/**
 * Small models routinely decorate the header lines they were asked for as a
 * markdown list or with bold emphasis (`- intent: X`, `**intent:** X`,
 * `1. intent: X`). The decoration carries no meaning, so it is stripped before
 * the key is read rather than being treated as an unknown key.
 *
 * Exported because `security/outputGuard.ts` needs the SAME normalisation
 * before it compares a line against the System Prompt's headings. That guard
 * used to compare raw lines, so a decorated echo (`**CONTEXT: CONTEXT**`)
 * slipped past it while this parser happily read the same shape - the two
 * layers disagreed about what "a header line" looks like, and a real leak went
 * out through the gap (§14.2: one definition, not two).
 */
export function stripHeaderLineDecoration(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*`+|`+\s*$/g, '')
    .trim()
}

function splitKeyValue(line: string): { key: string; rawValue: string } {
  const cleaned = stripHeaderLineDecoration(line)
  const colonIndex = cleaned.indexOf(':')
  if (colonIndex === -1) return { key: cleaned.toLowerCase(), rawValue: '' }
  return { key: cleaned.slice(0, colonIndex).trim().toLowerCase(), rawValue: cleaned.slice(colonIndex + 1).trim() }
}

/** §11.3: `route:` empty/`none`/`null`/`-` all mean "no route yet". */
function parseRoute(rawValue: string): string | null {
  const normalized = rawValue.trim()
  if (normalized === '' || normalized.toLowerCase() === 'none' || normalized.toLowerCase() === 'null' || normalized === '-') {
    return null
  }
  // The token itself is NOT validated as a real RouteId here on purpose -
  // §11.3/§11.4 push that check to decisionSchema/routeValidator so a
  // hallucinated route only ever falls back to null downstream, never a
  // parse failure here.
  return normalized
}

/** §11.3: `slots:` is `key=value,key=value`; a malformed entry (no `=`) is dropped, not a failure. */
function parseSlots(rawValue: string): Record<string, string> {
  const normalized = rawValue.trim()
  if (normalized === '' || normalized.toLowerCase() === 'none' || normalized === '-') return {}
  const slots: Record<string, string> = {}
  for (const entry of normalized.split(',')) {
    const equalsIndex = entry.indexOf('=')
    if (equalsIndex === -1) continue
    const key = entry.slice(0, equalsIndex).trim()
    const value = entry.slice(equalsIndex + 1).trim()
    if (key === '') continue
    slots[key] = value
  }
  return slots
}

/**
 * §11.3/§11.4: confidence is clamped into [0, 1] rather than rejected when
 * out of range - a 0.6B model's self-reported confidence is an approximate
 * secondary signal (§11.6), and `decisionSchema`'s `z.number().min(0).max(1)`
 * would otherwise reject an answer that was correct in every other respect
 * over a single overshooting number. A value that isn't even parseable as a
 * finite number (e.g. empty or non-numeric text) is still a parse failure.
 */
function parseConfidence(rawValue: string): number | 'malformed_value' {
  const parsed = Number(rawValue.trim())
  if (!Number.isFinite(parsed)) return 'malformed_value'
  return Math.min(1, Math.max(0, parsed))
}

function parseClarify(rawValue: string): boolean | 'malformed_value' {
  const normalized = rawValue.trim().toLowerCase()
  if (normalized === 'yes' || normalized === 'true' || normalized === '1') return true
  if (normalized === 'no' || normalized === 'false' || normalized === '0') return false
  return 'malformed_value'
}

/**
 * Scans `lines[0, min(upperBound, MAX_HEADER_LINES))` for the first line
 * whose (decoration-stripped) key is a recognised `HEADER_KEYS` member.
 * Shared by both branches of `parseRaw` below: bounding the scan to
 * `MAX_HEADER_LINES` is what keeps an ordinary prose paragraph from being
 * misread as "prose in front of a header block" just because, several
 * sentences in, it happens to contain a line that reads exactly `intent`.
 */
function findHeaderStartIndex(lines: readonly string[], upperBound: number): number | null {
  const limit = Math.min(upperBound, MAX_HEADER_LINES, lines.length)
  for (let i = 0; i < limit; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const { key } = splitKeyValue(line)
    if ((HEADER_KEYS as readonly string[]).includes(key)) return i
  }
  return null
}

/**
 * From `start`, returns the index just past the last line of an unbroken run
 * of recognised header-key lines (blank lines do not break the run; the
 * first non-blank, non-header line ends it). Only used on the no-`---`
 * branch of `parseRaw`, where there is no separator to mark where the header
 * block ends - the header block's own shape has to mark it instead.
 */
function consecutiveHeaderBlockEnd(lines: readonly string[], start: number): number {
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i++
      continue
    }
    const { key } = splitKeyValue(line)
    if (!(HEADER_KEYS as readonly string[]).includes(key)) break
    i++
  }
  return i
}

/**
 * Validates an already-delimited header block against `body`: unknown/
 * duplicate keys, the `intent:`-required rule, confidence/clarify parsing and
 * defaults, and the empty-body check. Shared by every `parseRaw` branch below
 * so they cannot diverge on what makes a header block valid - only how its
 * boundaries were found differs between branches.
 */
function finalizeHeader(headerLines: readonly string[], body: string): ParseResult {
  const seenKeys = new Set<HeaderKey>()
  const rawValues: Partial<Record<HeaderKey, string>> = {}
  for (const line of headerLines) {
    const { key, rawValue } = splitKeyValue(line)
    if (!(HEADER_KEYS as readonly string[]).includes(key)) return failure('unknown_header_key')
    const headerKey = key as HeaderKey
    if (seenKeys.has(headerKey)) return failure('duplicate_header_key')
    seenKeys.add(headerKey)
    rawValues[headerKey] = rawValue
  }

  // Only `intent:` is genuinely required. §11.3 lists all five header lines,
  // but a 0.6B model routinely drops the ones that are empty or that it judges
  // irrelevant (most often `slots:`, then `confidence:`), and failing the whole
  // turn over a missing line would show §11.5's fixed message for an answer
  // that was otherwise fine. The dropped lines get conservative defaults and
  // every one of them is still validated downstream by `decisionSchema` and
  // `routeValidator` (§11.4), so tolerating them here cannot widen what the
  // model is allowed to decide. See docs/仕様/browser-ai.md §0.4.
  if (!seenKeys.has('intent')) return failure('header_incomplete')

  const confidence = seenKeys.has('confidence') ? parseConfidence(rawValues.confidence!) : DEFAULT_CONFIDENCE
  if (confidence === 'malformed_value') return failure('malformed_value')

  const clarify = seenKeys.has('clarify') ? parseClarify(rawValues.clarify!) : false
  if (clarify === 'malformed_value') return failure('malformed_value')

  if (body === '') return failure('empty_body')

  const header: DecisionHeader = {
    intent: rawValues.intent!.trim(),
    route: parseRoute(rawValues.route ?? ''),
    slots: parseSlots(rawValues.slots ?? ''),
    confidence,
    clarify,
  }

  return { ok: true, value: { header, body } }
}

/**
 * A response with no recognisable header line anywhere is treated as a
 * genuinely free-text answer rather than a parse failure (§0.4 "never
 * dead-end"): `intent: ''` maps through `toDecisionCandidate` unchanged, and
 * `routeValidator.ts`'s enum normaliser turns an unrecognised intent token
 * into `UNKNOWN` on its own - this function does not special-case it.
 */
function headerlessResult(text: string): ParseResult {
  const body = text.trim()
  if (body === '') return failure('empty_body')
  return {
    ok: true,
    value: {
      header: { intent: '', route: null, slots: {}, confidence: DEFAULT_CONFIDENCE, clarify: false },
      body,
      headerless: true,
    },
  }
}

/**
 * Shared core for `parseAssistantOutput()` and `StreamingParser.finish()` -
 * both must reach identical conclusions for identical raw text, so all
 * parsing/validation logic lives here exactly once.
 */
function parseRaw(raw: string): ParseResult {
  const preprocessed = normalizeLineEndingsAndLeadingBlank(stripWholeResponseCodeFence(stripThinkingBlock(raw)))
  const lines = preprocessed.split('\n')

  const separatorIndex = lines.findIndex((line) => line.trim() === HEADER_SEPARATOR)

  if (separatorIndex !== -1) {
    // Small models sometimes prefix the header block with a conversational
    // lead-in ("はい、承知しました。"). Drop everything before the first
    // recognised header key, as long as one appears within the first
    // MAX_HEADER_LINES lines of the prefix - otherwise leave headerStart at 0
    // and let the per-line check inside finalizeHeader fail it as an unknown
    // key, exactly as before this tolerance was added.
    const headerStart = findHeaderStartIndex(lines, separatorIndex) ?? 0
    if (separatorIndex - headerStart > MAX_HEADER_LINES) return failure('header_too_long')
    const headerLines = lines.slice(headerStart, separatorIndex).filter((line) => line.trim() !== '')
    const body = lines.slice(separatorIndex + 1).join('\n').trim()
    return finalizeHeader(headerLines, body)
  }

  // No literal '---' line anywhere. A small model sometimes drops the
  // separator entirely while still emitting real header lines - tolerate
  // that by treating everything after the last consecutive header line as
  // the body, only failing with `missing_separator` when there is no body
  // left at all. If no header key appears anywhere in the response, this is
  // genuine prose rather than a malformed decision - see `headerlessResult`.
  const headerStart = findHeaderStartIndex(lines, lines.length)
  if (headerStart === null) return headerlessResult(preprocessed)

  const headerEnd = consecutiveHeaderBlockEnd(lines, headerStart)
  const headerLines = lines.slice(headerStart, headerEnd).filter((line) => line.trim() !== '')
  const body = lines.slice(headerEnd).join('\n').trim()
  if (body === '') return failure('missing_separator')
  return finalizeHeader(headerLines, body)
}

export function parseAssistantOutput(raw: string): ParseResult {
  return parseRaw(raw)
}

/**
 * §11.1/§11.4 shape: maps the wire-format header/body onto the field names
 * `decisionSchema` expects (`route` -> `routeId`, `clarify` -> `needsClarification`,
 * `body` -> `reply`); `intent`/`slots`/`confidence` pass through unchanged.
 * Returns a plain object, not a validated `AssistantDecision` - the caller
 * still must run it through `decisionSchema`/`validateDecision`.
 */
export function toDecisionCandidate(parsed: ParsedOutput): Record<string, unknown> {
  return {
    intent: parsed.header.intent,
    reply: parsed.body,
    routeId: parsed.header.route,
    slots: parsed.header.slots,
    confidence: parsed.header.confidence,
    needsClarification: parsed.header.clarify,
  }
}

/** §15.3: headers are never displayed - only body text streams to the UI. */
export interface StreamingParser {
  /** Returns the newly revealed body text, or `''` while still inside the header. */
  push(delta: string): { bodyDelta: string }
  finish(): ParseResult
  headerComplete(): boolean
  /**
   * The raw accumulated model output, thinking block and headers included.
   * Diagnostics only (a DEV-mode `console.debug` when parsing fails) - it must
   * never be rendered, since §12.7 requires the user-visible reply to come
   * from the validated, sanitized decision.
   */
  raw(): string
}

/**
 * Matches a `---` line that is fully terminated by a newline (`\r?\n`),
 * anchored to either the start of the buffer or a preceding `\n`. Requiring
 * the trailing newline means a chunk boundary that lands mid-separator
 * (e.g. `"--"` then `"-\n"`) never triggers a false-positive body start.
 */
const SEPARATOR_LINE_PATTERN = /(^|\n)---\r?\n/

/** A `<think>` opening tag can arrive split across chunks; `'<think>'` is 7 chars. */
const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'

export function createStreamingParser(): StreamingParser {
  let buffer = ''
  let separatorFound = false
  // Absolute index into `buffer` up to which body text has already been
  // emitted via `push()`'s return value - starts undefined until the
  // separator is found, since nothing is ever emitted before that.
  let emittedUpTo = 0
  // Index the separator search starts from: 0 normally, or just past a leading
  // `</think>` once one has been seen. Every reply starts with WebLLM's
  // injected empty thinking block (see `stripThinkingBlock`), and a real
  // non-empty one could itself contain a `---` line, so the search must not
  // begin until the block is closed.
  let searchFrom: number | null = null

  /** Resolves `searchFrom`; returns false while still waiting for more chunks. */
  function resolveThinkingBoundary(): boolean {
    if (searchFrom !== null) return true
    const leading = buffer.trimStart()
    if (leading === '') return false
    if (!leading.startsWith(THINK_OPEN_TAG)) {
      // Wait until we have enough characters to be sure it is not `<think>`.
      if (THINK_OPEN_TAG.startsWith(leading) && leading.length < THINK_OPEN_TAG.length) return false
      searchFrom = 0
      return true
    }
    const closeIndex = buffer.indexOf(THINK_CLOSE_TAG)
    if (closeIndex === -1) return false
    searchFrom = closeIndex + THINK_CLOSE_TAG.length
    return true
  }

  return {
    push(delta: string): { bodyDelta: string } {
      buffer += delta

      if (!separatorFound) {
        if (!resolveThinkingBoundary()) return { bodyDelta: '' }
        const match = SEPARATOR_LINE_PATTERN.exec(buffer.slice(searchFrom!))
        if (!match) return { bodyDelta: '' }
        separatorFound = true
        emittedUpTo = searchFrom! + match.index + match[0].length
      }

      const bodyDelta = buffer.slice(emittedUpTo)
      emittedUpTo = buffer.length
      return { bodyDelta }
    },

    finish(): ParseResult {
      return parseRaw(buffer)
    },

    headerComplete(): boolean {
      return separatorFound
    },

    raw(): string {
      return buffer
    },
  }
}
