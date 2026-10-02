/**
 * Message composer (spec browser-ai.md §12.3, §6.4.1). No `Textarea` exists
 * in `components/ui/` yet, so this is a native `<textarea>` styled to match
 * `Input`'s conventions locally.
 */
import { Send } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  AI_GENERATED_CONTENT_NOTICE,
  CHAT_INPUT_LABEL,
  CHAT_INPUT_PLACEHOLDER,
  CHAT_INPUT_SEND_BUTTON_LABEL,
  remainingCharsLabel,
} from './assistantMessages'
import { INPUT_MAX_CHARS, remainingInputChars } from './security/inputGuard'

export interface ChatInputProps {
  onSubmit: (text: string) => void
  /** true while the model is generating - the send button is disabled but typing stays allowed. */
  busy: boolean
  /** §6.4.1: input stays enabled while the model loads; messages queue as `pending`. */
  disabled?: boolean
}

/**
 * §12.3: announcing the remaining-character count on every keystroke would
 * spam a screen reader while the user is comfortably under the limit. The
 * counter only switches to `aria-live="polite"` once this close to
 * `INPUT_MAX_CHARS`, so the announcement fires only near the point it
 * actually matters.
 */
const REMAINING_CHARS_LIVE_THRESHOLD = 20

/** Counts and truncates by code point (never `.length`), matching `remainingInputChars`. */
function capToLimit(text: string): string {
  const codePoints = Array.from(text)
  return codePoints.length > INPUT_MAX_CHARS ? codePoints.slice(0, INPUT_MAX_CHARS).join('') : text
}

export function ChatInput({ onSubmit, busy, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState('')
  const inputId = useId()
  /**
   * True while an IME (Japanese/Chinese/Korean input) conversion is open.
   *
   * Without this, the Enter that merely CONFIRMS a kana-to-kanji conversion is
   * read as "send", so 「ドメインを購入したい」 gets submitted the moment the
   * user accepts the conversion and the confirmed text is left behind in the
   * box. `event.nativeEvent.isComposing` covers Chromium/Firefox; the ref is
   * the fallback for browsers that fire `keydown` with a stale `isComposing`
   * (Safari) - `compositionend` runs after that `keydown`, so the ref is only
   * cleared on the next tick.
   */
  const composingRef = useRef(false)

  const remaining = remainingInputChars(value)
  const isNearLimit = remaining <= REMAINING_CHARS_LIVE_THRESHOLD

  function trySubmit(): void {
    const trimmed = value.trim()
    if (trimmed === '') return
    onSubmit(trimmed)
    setValue('')
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    trySubmit()
  }

  function isComposing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    // `keyCode === 229` is the legacy signal every browser still emits for a
    // keydown that belongs to an in-progress IME composition.
    return composingRef.current || event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // An Enter that confirms an IME conversion must never submit - it belongs
    // to the composition, not to the form.
    if (isComposing(event)) return
    // Enter submits; Shift+Enter falls through to the textarea's own newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      trySubmit()
    }
  }

  return (
    <form className="flex flex-col gap-1.5" onSubmit={handleSubmit}>
      <label htmlFor={inputId} className="sr-only">
        {CHAT_INPUT_LABEL}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={inputId}
          className={cn(
            'min-h-[2.5rem] w-full flex-1 resize-none rounded-lg border border-input bg-transparent px-3.5 py-2 text-sm outline-none transition-colors placeholder:text-ink-hint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
          )}
          rows={1}
          placeholder={CHAT_INPUT_PLACEHOLDER}
          value={value}
          onChange={(event) => setValue(capToLimit(event.target.value))}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            // Cleared on the next tick: Safari fires `compositionend` BEFORE the
            // confirming Enter's `keydown`, so clearing synchronously would let
            // that Enter submit after all.
            window.setTimeout(() => {
              composingRef.current = false
            }, 0)
          }}
          disabled={disabled}
        />
        <Button type="submit" size="icon" aria-label={CHAT_INPUT_SEND_BUTTON_LABEL} disabled={busy || disabled}>
          <Send aria-hidden="true" />
        </Button>
      </div>
      <p className="text-right text-xs text-muted-foreground" aria-live={isNearLimit ? 'polite' : 'off'}>
        {remainingCharsLabel(remaining)}
      </p>
      {/*
       * Persistent "this is AI" disclosure (team-lead request). Placed
       * INSIDE `ChatInput`, not as a sibling in `AssistantModal.tsx`,
       * precisely because `AssistantModal.tsx` conditionally hides
       * `ChatInput` itself for the UNSUPPORTED/ERROR model states
       * (`showChatInput`) - hiding this notice along with it is intentional:
       * those two states already render `AssistantError` instead, which
       * explains the AI is unavailable, and there is no AI reply in flight
       * for this notice to disclaim there. Static text, never re-rendered
       * per keystroke like the counter above - no `aria-live`, so a screen
       * reader is never made to announce it more than once (on mount).
       */}
      <p className="text-xs text-muted-foreground">{AI_GENERATED_CONTENT_NOTICE}</p>
    </form>
  )
}
