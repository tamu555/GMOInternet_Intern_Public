import { describe, expect, it } from 'vitest'
import { decisionSchema } from '../decisionSchema'
import {
  createStreamingParser,
  HEADER_KEYS,
  HEADER_SEPARATOR,
  MAX_HEADER_LINES,
  parseAssistantOutput,
  toDecisionCandidate,
} from './outputParser'

/** §11.3 example, verbatim. */
const SPEC_EXAMPLE = `intent: CONNECT_WEBSITE
route: DNS_RECORDS
slots: provider=vercel
confidence: 0.9
clarify: no
---
DNS設定の「レコード設定モード」から接続できます。`

describe('constants', () => {
  it('exposes the 5 header keys and the separator/limit constants from the spec', () => {
    expect(HEADER_KEYS).toEqual(['intent', 'route', 'slots', 'confidence', 'clarify'])
    expect(HEADER_SEPARATOR).toBe('---')
    expect(MAX_HEADER_LINES).toBe(8)
  })
})

describe('parseAssistantOutput', () => {
  it('parses the §11.3 example exactly', () => {
    const result = parseAssistantOutput(SPEC_EXAMPLE)
    expect(result).toEqual({
      ok: true,
      value: {
        header: {
          intent: 'CONNECT_WEBSITE',
          route: 'DNS_RECORDS',
          slots: { provider: 'vercel' },
          confidence: 0.9,
          clarify: false,
        },
        body: 'DNS設定の「レコード設定モード」から接続できます。',
      },
    })
  })

  it('parses correctly regardless of header key order', () => {
    const shuffled = `clarify: no
confidence: 0.9
slots: provider=vercel
intent: CONNECT_WEBSITE
route: DNS_RECORDS
---
DNS設定の「レコード設定モード」から接続できます。`
    const result = parseAssistantOutput(shuffled)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
      expect(result.value.header.slots).toEqual({ provider: 'vercel' })
    }
  })

  it('parses an empty slots: line as {}', () => {
    const text = `intent: EXPLAIN_DNS
route: none
slots:
confidence: 0.8
clarify: no
---
DNSはドメイン名をIPアドレスに変換する仕組みです。`
    const result = parseAssistantOutput(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.header.slots).toEqual({})
  })

  it('parses route: none as null', () => {
    const text = `intent: EXPLAIN_DNS
route: none
slots: -
confidence: 0.8
clarify: no
---
説明します。`
    const result = parseAssistantOutput(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.header.route).toBeNull()
  })

  it('clamps confidence: 1.7 to 1', () => {
    const text = SPEC_EXAMPLE.replace('confidence: 0.9', 'confidence: 1.7')
    const result = parseAssistantOutput(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.header.confidence).toBe(1)
  })

  it('clamps a negative confidence to 0', () => {
    const text = SPEC_EXAMPLE.replace('confidence: 0.9', 'confidence: -3')
    const result = parseAssistantOutput(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.header.confidence).toBe(0)
  })

  it('fails with malformed_value for clarify: maybe', () => {
    const text = SPEC_EXAMPLE.replace('clarify: no', 'clarify: maybe')
    expect(parseAssistantOutput(text)).toEqual({ ok: false, reason: 'malformed_value' })
  })

  it('fails with header_too_long for 9 header lines before ---', () => {
    const text = `intent: CONNECT_WEBSITE
route: DNS_RECORDS
slots: provider=vercel
confidence: 0.9
clarify: no
extra1: a
extra2: b
extra3: c
extra4: d
---
本文`
    expect(parseAssistantOutput(text)).toEqual({ ok: false, reason: 'header_too_long' })
  })

  it('fails with unknown_header_key for an unrecognized key', () => {
    const text = SPEC_EXAMPLE.replace('clarify: no', 'clarify: no\nfoo: bar')
    expect(parseAssistantOutput(text)).toEqual({ ok: false, reason: 'unknown_header_key' })
  })

  it('fails with duplicate_header_key for a repeated key', () => {
    const text = SPEC_EXAMPLE.replace('clarify: no', 'clarify: no\nintent: SEARCH_DOMAIN')
    expect(parseAssistantOutput(text)).toEqual({ ok: false, reason: 'duplicate_header_key' })
  })

  it('tolerates a missing --- when real header lines are still present, using the text after them as the body', () => {
    // v1.4 "never dead-end" tolerance: a small model that forgets the
    // separator but still emits a real header block should not show §11.5's
    // fixed apology for what is otherwise a perfectly good answer.
    const text = `intent: CONNECT_WEBSITE
route: DNS_RECORDS
slots: provider=vercel
confidence: 0.9
clarify: no
本文のみ`
    const result = parseAssistantOutput(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
    expect(result.value.header.slots).toEqual({ provider: 'vercel' })
    expect(result.value.body).toBe('本文のみ')
    expect(result.value.headerless).toBeUndefined()
  })

  it('still fails with missing_separator when a real header block has no body left at all', () => {
    const text = `intent: CONNECT_WEBSITE
route: DNS_RECORDS
slots: provider=vercel
confidence: 0.9
clarify: no`
    expect(parseAssistantOutput(text)).toEqual({ ok: false, reason: 'missing_separator' })
  })

  it('tolerates omitted optional header lines but fails when intent is missing', () => {
    // Only `intent:` is required - see the "small-model output tolerance"
    // block below and the rationale comment in outputParser.ts's parseRaw().
    const withoutOptionalKeys = `intent: CONNECT_WEBSITE
route: DNS_RECORDS
---
本文`
    expect(parseAssistantOutput(withoutOptionalKeys).ok).toBe(true)

    const withoutIntent = `route: DNS_RECORDS
slots: provider=vercel
confidence: 0.9
clarify: no
---
本文`
    expect(parseAssistantOutput(withoutIntent)).toEqual({ ok: false, reason: 'header_incomplete' })
  })

  it('fails with empty_body when the body is blank after trim', () => {
    const text = `intent: CONNECT_WEBSITE
route: DNS_RECORDS
slots: provider=vercel
confidence: 0.9
clarify: no
---
   `
    expect(parseAssistantOutput(text)).toEqual({ ok: false, reason: 'empty_body' })
  })

  it('parses a ```-fenced payload', () => {
    const fenced = '```\n' + SPEC_EXAMPLE + '\n```'
    const result = parseAssistantOutput(fenced)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
  })

  it('parses \\r\\n line endings', () => {
    const crlf = SPEC_EXAMPLE.replace(/\n/g, '\r\n')
    const result = parseAssistantOutput(crlf)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
      expect(result.value.body).toBe('DNS設定の「レコード設定モード」から接続できます。')
    }
  })

  it('tolerates a single leading blank line', () => {
    const result = parseAssistantOutput('\n' + SPEC_EXAMPLE)
    expect(result.ok).toBe(true)
  })
})

describe('toDecisionCandidate', () => {
  it('maps route/clarify/body onto routeId/needsClarification/reply, passing the rest through', () => {
    const result = parseAssistantOutput(SPEC_EXAMPLE)
    if (!result.ok) throw new Error('expected the spec example to parse')
    const candidate = toDecisionCandidate(result.value)
    expect(candidate).toEqual({
      intent: 'CONNECT_WEBSITE',
      reply: 'DNS設定の「レコード設定モード」から接続できます。',
      routeId: 'DNS_RECORDS',
      slots: { provider: 'vercel' },
      confidence: 0.9,
      needsClarification: false,
    })
  })

  it('produces a candidate that passes decisionSchema', () => {
    const result = parseAssistantOutput(SPEC_EXAMPLE)
    if (!result.ok) throw new Error('expected the spec example to parse')
    const candidate = toDecisionCandidate(result.value)
    expect(decisionSchema.safeParse(candidate).success).toBe(true)
  })
})

describe('createStreamingParser', () => {
  it('yields a concatenated bodyDelta equal to the body and never leaks header text (char-by-char)', () => {
    const parser = createStreamingParser()
    let streamed = ''
    for (const char of SPEC_EXAMPLE) {
      const { bodyDelta } = parser.push(char)
      streamed += bodyDelta
      // No emitted fragment may ever contain header-only tokens.
      expect(bodyDelta).not.toContain('intent:')
      expect(bodyDelta).not.toContain('confidence:')
    }
    expect(streamed).toBe('DNS設定の「レコード設定モード」から接続できます。')
    expect(parser.headerComplete()).toBe(true)
  })

  it('emits nothing before the separator is seen', () => {
    const parser = createStreamingParser()
    const { bodyDelta } = parser.push('intent: CONNECT_WEBSITE\nroute: DNS_RECORDS\n')
    expect(bodyDelta).toBe('')
    expect(parser.headerComplete()).toBe(false)
  })

  it('does not falsely trigger on a partial separator split across chunks', () => {
    const parser = createStreamingParser()
    parser.push('intent: CONNECT_WEBSITE\nroute: DNS_RECORDS\nslots: provider=vercel\nconfidence: 0.9\nclarify: no\n--')
    expect(parser.headerComplete()).toBe(false)
    const { bodyDelta } = parser.push('-\n本文')
    expect(parser.headerComplete()).toBe(true)
    expect(bodyDelta).toBe('本文')
  })

  describe('finish() matches parseAssistantOutput on the same input', () => {
    const inputs: { name: string; text: string }[] = [
      { name: 'spec example', text: SPEC_EXAMPLE },
      {
        name: 'empty slots',
        text: `intent: EXPLAIN_DNS
route: none
slots:
confidence: 0.8
clarify: no
---
説明します。`,
      },
      {
        name: 'clamped confidence',
        text: SPEC_EXAMPLE.replace('confidence: 0.9', 'confidence: 1.7'),
      },
      {
        name: 'malformed clarify',
        text: SPEC_EXAMPLE.replace('clarify: no', 'clarify: maybe'),
      },
      {
        name: 'header without separator (tolerated)',
        text: 'intent: CONNECT_WEBSITE\nroute: DNS_RECORDS\nslots: provider=vercel\nconfidence: 0.9\nclarify: no\n本文のみ',
      },
      {
        name: 'header without separator and no body left (still fails)',
        text: 'intent: CONNECT_WEBSITE\nroute: DNS_RECORDS\nslots: provider=vercel\nconfidence: 0.9\nclarify: no',
      },
      {
        name: 'leading prose before a real header block',
        text: 'はい、承知しました。\n' + SPEC_EXAMPLE,
      },
      {
        name: 'pure prose, no header at all (headerless)',
        text: 'こんにちは。ご質問の内容についてお答えします。',
      },
    ]

    for (const { name, text } of inputs) {
      it(`matches for: ${name}`, () => {
        const direct = parseAssistantOutput(text)
        const parser = createStreamingParser()
        parser.push(text)
        const streamed = parser.finish()
        expect(streamed).toEqual(direct)
      })
    }
  })
})

/**
 * Regression guard for the bug that made the assistant answer 「うまく案内先を
 * 判断できませんでした」 to essentially every question.
 *
 * §15.4 mandates `extra_body: { enable_thinking: false }`, and WebLLM
 * implements that by pushing the tokens of `"<think>\n\n</think>\n\n"` into
 * the response itself (`llm_chat.ts`: `appendEmptyThinkingReplyHeader`). Every
 * reply therefore arrives with that literal block in front of the header, and
 * the parser used to read `<think>` as an unknown header key.
 */
describe('Qwen3 thinking block (regression)', () => {
  const WEBLLM_EMPTY_THINKING_PREFIX = '<think>\n\n</think>\n\n'

  it('parses a reply prefixed with WebLLM’s injected empty thinking block', () => {
    const result = parseAssistantOutput(WEBLLM_EMPTY_THINKING_PREFIX + SPEC_EXAMPLE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
    expect(result.value.header.route).toBe('DNS_RECORDS')
    expect(result.value.body).toBe('DNS設定の「レコード設定モード」から接続できます。')
  })

  it('strips a non-empty thinking block, including one containing a --- line', () => {
    const raw = `<think>
Let me consider the options.
---
Actually, DNS records.
</think>
${SPEC_EXAMPLE}`
    const result = parseAssistantOutput(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
    expect(result.value.body).toBe('DNS設定の「レコード設定モード」から接続できます。')
  })

  it('never streams any part of the thinking block or the header to the UI', () => {
    const raw = WEBLLM_EMPTY_THINKING_PREFIX + SPEC_EXAMPLE
    const parser = createStreamingParser()
    let streamed = ''
    for (const char of raw) streamed += parser.push(char).bodyDelta
    expect(streamed).toBe('DNS設定の「レコード設定モード」から接続できます。')
    expect(streamed).not.toContain('think')
    expect(streamed).not.toContain('intent:')
    expect(parser.raw()).toBe(raw)
    expect(parser.finish()).toEqual(parseAssistantOutput(raw))
  })

  it('does not stream a --- that only appears inside the thinking block', () => {
    const raw = `<think>\n---\nnot the separator\n</think>\n${SPEC_EXAMPLE}`
    const parser = createStreamingParser()
    let streamed = ''
    for (const char of raw) streamed += parser.push(char).bodyDelta
    expect(streamed).toBe('DNS設定の「レコード設定モード」から接続できます。')
  })
})

describe('small-model output tolerance', () => {
  it('accepts markdown-decorated header lines', () => {
    const raw = `- **intent:** PURCHASE_DOMAIN
- **route:** DOMAIN_SEARCH
- **slots:**
- **confidence:** 0.9
- **clarify:** no
---
検索画面から取得できます。`
    const result = parseAssistantOutput(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.intent).toBe('PURCHASE_DOMAIN')
    expect(result.value.header.route).toBe('DOMAIN_SEARCH')
  })

  it('fills in omitted slots/confidence/clarify lines instead of failing', () => {
    const raw = 'intent: PURCHASE_DOMAIN\nroute: DOMAIN_SEARCH\n---\n検索画面から取得できます。'
    const result = parseAssistantOutput(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.slots).toEqual({})
    expect(result.value.header.clarify).toBe(false)
    // Above minConfidence (0.5) so a dropped line is not a silent rejection.
    expect(result.value.header.confidence).toBeGreaterThan(0.5)
    expect(decisionSchema.safeParse(toDecisionCandidate(result.value)).success).toBe(true)
  })

  it('still fails when even the intent line is absent', () => {
    const result = parseAssistantOutput('route: DOMAIN_SEARCH\n---\n本文')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('header_incomplete')
  })

  it('still fails on a genuinely unknown header key', () => {
    const result = parseAssistantOutput('intent: PURCHASE_DOMAIN\nfoo: bar\n---\n本文')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unknown_header_key')
  })

  it('drops a conversational lead-in before the real header block instead of failing with unknown_header_key', () => {
    const raw = 'はい、承知しました。\n' + SPEC_EXAMPLE
    const result = parseAssistantOutput(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.header.intent).toBe('CONNECT_WEBSITE')
    expect(result.value.header.slots).toEqual({ provider: 'vercel' })
    expect(result.value.body).toBe('DNS設定の「レコード設定モード」から接続できます。')
    expect(result.value.headerless).toBeUndefined()
  })

  it('does not strip a lead-in if no recognised header key appears within MAX_HEADER_LINES lines of it', () => {
    // The lead-in itself is treated as (part of) the header block here, and
    // fails as an unknown key, same as before this tolerance was added -
    // stripping only kicks in once a real header key is actually found.
    const raw = 'はい、承知しました。\nfoo: bar\n---\n本文'
    const result = parseAssistantOutput(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unknown_header_key')
  })
})

describe('headerless output (pure prose, "never dead-end")', () => {
  it('treats a response with no recognisable header line as a successful headerless result', () => {
    const raw = 'ご質問ありがとうございます。ドメインの取得については検索画面からお試しください。'
    const result = parseAssistantOutput(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.headerless).toBe(true)
    expect(result.value.header).toEqual({ intent: '', route: null, slots: {}, confidence: 0.6, clarify: false })
    expect(result.value.body).toBe(raw)
  })

  it('still fails with empty_body when the headerless text is blank after stripping', () => {
    expect(parseAssistantOutput('   \n  ')).toEqual({ ok: false, reason: 'empty_body' })
  })

  it('maps a headerless result through toDecisionCandidate/decisionSchema to intent UNKNOWN (via routeValidator normalisation)', () => {
    const raw = 'ご質問ありがとうございます。'
    const result = parseAssistantOutput(raw)
    if (!result.ok) throw new Error('expected a headerless success')
    const candidate = toDecisionCandidate(result.value)
    expect(candidate).toEqual({
      intent: '',
      reply: raw,
      routeId: null,
      slots: {},
      confidence: 0.6,
      needsClarification: false,
    })
    // decisionSchema itself rejects intent: '' (not a member of ALLOWED_INTENT_IDS) -
    // routeValidator.ts's normalizeDecisionCandidate is what maps it to 'UNKNOWN'
    // before validation, exactly like a hallucinated intent token (see its module doc).
    expect(decisionSchema.safeParse(candidate).success).toBe(false)
  })
})
