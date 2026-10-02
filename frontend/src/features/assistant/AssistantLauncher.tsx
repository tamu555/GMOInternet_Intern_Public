/**
 * "AIに相談する" entry point (spec browser-ai.md §13.4, §13.5, §13.6). Builds
 * the `PageContext` from the current route and owns the `open` state for the
 * `AssistantModal` it renders alongside itself.
 */
// `Sparkles` is already かんたんモード's glyph (`EasyModeSwitch.tsx:30`,
// `EasyLayout.tsx:134`) and appears on the same hero ~150px away, so one glyph
// cannot mean two features - the assistant gets its own question-mark bubble.
import { MessageCircleQuestionMark } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AssistantModal } from './AssistantModal'
import { ASSISTANT_LAUNCHER_BUTTON_LABEL, ASSISTANT_LAUNCHER_PROMPT } from './assistantMessages'
import { assistantEnabled } from './config/assistantConfig'
import { routeIdForPath } from './routing/manifestResolver'
import { recordWalkthroughRouteVisit } from './store/chatStore'
import type { PageContext, WalkthroughState } from './types'
import { WalkthroughStepper } from './WalkthroughStepper'
import type { WalkthroughTemplate } from './walkthrough/walkthroughTemplates'

export interface AssistantLauncherProps {
  /** 'cta' = the §13.4 top-page block with its lead-in copy; 'icon' = the §13.5 header button; 'compact' = `AppLayout`'s out-of-modal walkthrough progress bar. */
  variant?: 'cta' | 'icon' | 'compact'
  className?: string
  /**
   * `variant="icon"` only: render the label as ordinary visible text at EVERY
   * width and drop the icon-only box/glyph sizing. The default (`false`) keeps
   * the header's responsive behaviour - glyph-only below 820px, label from
   * 820px up. Set it where the button sits in a column of labelled text rows
   * (the mobile `Sheet` nav), because the `min-[820px]:` gate can never fire
   * inside a `md:hidden` container and the bare glyph reads as a stray bullet
   * there.
   */
  showLabel?: boolean
  /**
   * `variant="compact"` only: the live walkthrough `AppLayout` already
   * resolved from the store. `AssistantLauncher` still owns `open`/the modal
   * it renders alongside itself (same pattern as the other two variants) -
   * `AppLayout` only decides WHETHER to render this instance at all, never
   * the modal's open state.
   */
  walkthroughTemplate?: WalkthroughTemplate
  walkthroughState?: WalkthroughState
}

export function AssistantLauncher({ variant = 'cta', className, showLabel = false, walkthroughTemplate, walkthroughState }: AssistantLauncherProps) {
  const location = useLocation()
  // §13.6: only used to resolve a `:domainName` path once the AI has chosen a
  // route (`manifestResolver.ts`) - it is never read into the prompt itself
  // (enforced independently by `systemPrompt.ts`'s own runtime guard).
  const { domainName } = useParams<{ domainName?: string }>()
  const [open, setOpen] = useState(false)
  // The modal is opened by a plain `<Button onClick>` rather than a Radix
  // `DialogTrigger`, so Radix has no trigger element of its own to hand focus
  // back to when the dialog closes. This ref is that element (see
  // `onCloseAutoFocus` on `AssistantModal` below).
  const triggerRef = useRef<HTMLButtonElement>(null)
  const routeId = routeIdForPath(location.pathname, location.search)

  // Guided Walkthrough auto-detection (`.agents/docs/research/assistant-walkthrough-plan.md`
  // §1/§4.1, FR-21): `AssistantLauncher` is mounted in `AppLayout` on every
  // page, so this effect runs on every in-app navigation REGARDLESS of
  // whether the chat modal is open - that is the entire point of the
  // auto-detection. It must not move inside `AssistantModal`/be gated on
  // `open`. `recordWalkthroughRouteVisit` is already a safe no-op when there
  // is no active walkthrough (store/chatStore.ts) or the route was already
  // recorded, so this never needs to duplicate that check here.
  useEffect(() => {
    if (routeId) recordWalkthroughRouteVisit(routeId)
  }, [routeId])

  // §6.1: the service-wide kill switch / dev override. When disabled, there
  // is no entry point anywhere in the app - unlike §16's UNSUPPORTED case
  // below, which keeps the button visible.
  if (!assistantEnabled()) return null
  // `AppLayout` only renders a `variant="compact"` instance when it already
  // resolved a live walkthrough - this is defensive only, so a caller that
  // gets it wrong renders nothing instead of a broken progress bar.
  if (variant === 'compact' && (!walkthroughTemplate || !walkthroughState)) return null

  const context: PageContext = {
    routeId,
    ...(domainName ? { domain: domainName } : {}),
  }

  return (
    <>
      {variant === 'compact' && walkthroughTemplate && walkthroughState ? (
        <WalkthroughStepper
          variant="compact"
          template={walkthroughTemplate}
          state={walkthroughState}
          onOpenAssistant={() => setOpen(true)}
        />
      ) : variant === 'icon' ? (
        // Below 820px this is a 40x40 icon-only button; from 820px up the
        // label becomes visible text. The gate is an arbitrary `min-[820px]:`
        // rather than `md:` or `lg:`: measured in the real header, 768px
        // leaves only 70px of free track (the label costs ~85px) but 1023px
        // already leaves 325px, so `lg:` hid the label for ~200px more than it
        // had to. 820 is the first width where the label fits with margin.
        // The icon-only box is 40x40 with a 20px glyph so it matches the
        // hamburger sitting next to it (`AppLayout.tsx`, `size="icon"` +
        // `size-5`); `size="sm"` alone would give 32x32/14px, and the 14px
        // question mark is the entire signal on that surface. The explicit
        // `min-[820px]:size-3.5` is required, not decorative: `size="sm"`
        // sizes the glyph via `[&_svg:not([class*='size-'])]`, so any `size-`
        // class on the svg opts it out of that rule at every width.
        // `max-[820px]:` (not `max-[819px]:`) is the exact complement of
        // `min-[820px]:`: Tailwind v4 compiles `max-*` to `width < N`, so
        // `max-[819px]` left 819px itself matched by NEITHER half - measured
        // there, the button fell back to `size="sm"`'s 32px box with a 24px
        // unsized glyph.
        // The accessible name is `aria-label` at every width, so the single
        // button never doubles up for a responsive pair.
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={ASSISTANT_LAUNCHER_BUTTON_LABEL}
          className={cn(!showLabel && 'max-[820px]:size-10 max-[820px]:px-0', className)}
          onClick={() => setOpen(true)}
        >
          <MessageCircleQuestionMark
            className={showLabel ? undefined : 'max-[820px]:size-5 min-[820px]:size-3.5'}
            aria-hidden="true"
          />
          <span className={showLabel ? undefined : 'sr-only min-[820px]:not-sr-only'}>
            {ASSISTANT_LAUNCHER_BUTTON_LABEL}
          </span>
        </Button>
      ) : (
        // Left-aligned and inline by default: the header button is the app-wide
        // entry point, so this block is a quiet second offer, not the loudest
        // thing on the page. `variant="secondary"`/`size="sm"` demote it from
        // the former primary-filled `size="lg"` chip; no `rounded-none` /
        // `font-heading` here because `buttonVariants`' base already has both,
        // and no bespoke hover/focus/active styles because `button.tsx` already
        // ships them.
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
          <p className="text-sm text-muted-foreground">{ASSISTANT_LAUNCHER_PROMPT}</p>
          <Button ref={triggerRef} type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <MessageCircleQuestionMark aria-hidden="true" />
            {ASSISTANT_LAUNCHER_BUTTON_LABEL}
          </Button>
        </div>
      )}

      {/* §16: even when the model turns out UNSUPPORTED, this button keeps
          opening the modal, which then shows the §16 message itself - the
          launcher never hides on that account (§13.4). */}
      <AssistantModal
        open={open}
        onOpenChange={setOpen}
        context={context}
        /* WCAG 2.4.3: without this, Esc (or the close button) left focus on
           `<body>`, because Radix restores focus to a `DialogTrigger` and this
           modal is opened by a plain `<Button onClick>`. `onCloseAutoFocus` is
           preferred over doing it in `onOpenChange` + `requestAnimationFrame`:
           it is Radix's own focus-restore step, so it cannot race the
           `FocusScope` teardown that was overwriting our focus call, and it
           needs no restructuring of `AssistantModal` (one optional prop
           forwarded to `DialogContent`). `variant="compact"` opens the modal
           from `WalkthroughStepper`'s own button, which this ref is not
           attached to - there we bail out and let Radix's default run. */
        onCloseAutoFocus={(event) => {
          const trigger = triggerRef.current
          if (!trigger) return
          event.preventDefault()
          trigger.focus()
        }}
      />
    </>
  )
}
