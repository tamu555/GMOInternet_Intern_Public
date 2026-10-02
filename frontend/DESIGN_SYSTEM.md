# Design System — 疑似レジストラサービス (TeamC)

This is the single source of truth for the shadcn/ui-based redesign.
Every page MUST follow these rules so the app reads as one product.

## Brand & tokens

The palette is **やわらか若草** (`design_theme/theme-04-3-wakakusa.html`), adopted
2026-08-26. Its three rules are what make it read as one product:

1. **Deep green is ink, not paint.** `--green` (#1f6d45) is only ever type, a
   button fill, or a small mark. Never a large filled surface.
2. **Surfaces are paper and pale grass.** `--paper` / `--paper-2` for the ground,
   `--grass-1` / `--grass-2` for every tinted band, panel or chip.
3. **One shadow, no outlines.** `shadow-soft` is the only elevation in the design.
   Do not add borders or rings to lift a card — the theme deliberately removed them.

- The shadcn semantic tokens (`--primary`, `--ring`, `--accent`, …) are mapped to the
  brand palette in `src/styles/app.css` via `var()` indirection, so **never hardcode
  hex colors in JSX**.
- Use semantic Tailwind classes first: `bg-background`, `bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary`,
  `text-destructive`, `bg-accent`, `ring-ring`.
- Brand accents are exposed as Tailwind colours where a semantic token would be a lie:
  `bg-grass`, `bg-grass-1/2/3`, `text-green-brand`, `text-green-deep`,
  `text-green-darkest`, `bg-paper-2`, `bg-sun` / `bg-sky` / `bg-clay`, `text-ink-faint`.
- Do NOT use `dark:` utilities. Dark mode is handled entirely by CSS variables
  (brand tokens switch via `prefers-color-scheme`, and semantic tokens reference them).
  The theme itself is light-only; the dark ramp keeps its logic with the values inverted.
- Warning/attention accent: use `--orange` only through existing status classes; in new
  JSX prefer `Badge` variants and `Alert` instead.
- Element defaults (`a { color }`, `body`, `h1-h3`) MUST stay inside `@layer base` in
  `src/styles/app.css`. Unlayered rules outrank Tailwind utilities and would repaint the
  label of every `<Button asChild><Link>` in the app.

## Typography

- Font: **Noto Sans JP** for body, **Zen Maru Gothic** for headings (the theme's
  丸ゴシック), **Poppins** for figures, TLDs and domain names. Set globally: `h1`-`h3`
  and `font-heading` pick up Zen Maru Gothic; `.font-en` picks up Poppins. Do not
  override per-component.
- Page title: `text-2xl font-bold tracking-tight` (h1, one per page).
- Page lede (subtitle): `text-sm text-muted-foreground leading-relaxed`.
- Section/card titles: use `CardTitle` (default styling) inside `CardHeader`.
- Body text: default size; secondary text `text-sm text-muted-foreground`.
- Monospace (domains, codes): `font-mono text-sm`; prices and TLD labels `.font-en`.

## Shape & elevation

- **Corners are square (2026-08-27).** `--radius` is `0rem` in `src/styles/app.css`, and
  every `--radius-*` step derives from it, so `rounded-xl` / `rounded-lg` / `rounded-md`
  all resolve to 0 — cards, inputs, selects, dialogs and popovers need no per-component
  class. Buttons are no longer pills: `buttonVariants` is `rounded-none`
  (`font-heading font-bold` stays). Do not reintroduce `rounded-full`, `rounded-[16px]`
  or similar in new JSX; if the whole product ever goes soft again, change `--radius`,
  not the call sites.
- **The only shapes that stay circular** are the ones whose meaning IS a circle: the
  `Switch` track and thumb, `RadioGroup` items, and the 1.5px auth-status dot in the
  header. Everything else — stepper numerals, completion medallions, chips, tabs, nav
  links, the progress bar — is square.
- `Card` carries `shadow-soft` and no ring. Reach for `bg-grass-1` (a soft fill) rather
  than a border when a block needs separating from the page.
- **The sticky header is the one exception to "no outlines".** The hero and the top of
  every inner screen open on a `--grass-1` band, so a grass-1 header has no edge at all.
  It uses its own plate token — `bg-header-surface` (`--header-surface`: paper white in
  light, a shade below `--paper` in dark) — plus a `border-border` hairline that is drawn
  even at scroll 0. Scrolled, it swaps to `--header-surface-translucent` with blur and a
  deeper shadow. Do not repaint it `bg-grass-1`, and keep anything sitting on it
  (`Badge`, the walkthrough strip) on a grass tint so it stays visible against the plate.
- The landing page uses `.leaf` (a square with two opposite corners fully rounded) as a
  background motif at low opacity. It is decoration: always `aria-hidden`, never behind
  body text at a contrast-reducing opacity.
- **Hero illustration** (`src/features/domains/HeroTree.tsx`, `heroTreeStages.ts`,
  `heroTreeMarkerKind.ts`, `heroTreeMarkers.tsx`, `HeroTreeAbout.tsx` and the generated
  `heroTreeSpots.ts`): a watercolour plant that **grows with the member's domain count**
  — 1-2 sprout, 3-5 sapling, 6+ full tree — carrying **one marker per owned domain**, up to
  40. The three paintings are rasters (`src/assets/hero-{sprout,sapling,tree}.webp`) put
  through the *same* grade before they were committed — HSV saturation x0.58, value gamma
  0.92, alpha below 42 dropped to kill the generator's halo — which is what makes them read
  as one plant at three ages. No call site recolours them; a raster cannot follow a token, so
  dark mode goes through `--hero-tree-filter` and nothing else.
  - **A marker's form is the distance to the renewal date**, never the §3.5 status
    (`markerKindFor` in `heroTreeMarkerKind.ts`, thresholds 30 / 90 days to match
    `expiryIndicatorClass`). Plenty of time → ripe fruit / butterfly / ground flower; 31-90
    days → snail on the trunk; 30 days or fewer → bee; expired, or §3.5 `ending`, → wilted
    flower on the ground; no `exDate` → ladybug. **Healthy domains deliberately share one
    form**: twenty ripe berries read as "nothing to do", and one different shape pulls the
    eye. "The exception stands out" can only be built by making the norm uniform.
  - **Premium TLDs change material, not form** — the fruit turns gold with a deliberately
    exaggerated radiance (pulsing halo + slowly rotating rays, `hero-tree-glow` /
    `hero-tree-rays`) and sparkles are added in every band. A premium-only creature would
    put a second meaning on the axis that already carries expiry, and "is the gold
    butterfly urgent?" becomes unanswerable.
  - The other §3.5 statuses (未公開 / 引っ越し中 / ロック中 / 一時停止中) are **not in the
    form**; they reach the member through the tooltip and the `aria-label` only. That is a
    deliberate trade for a single readable axis — if 一時停止中 ever needs to be visible at
    rest, add a small accent to the marker, not a new creature.
  - **Nothing is written on the artwork.** A label forces the marker big enough to hold text,
    which caps how many fit and turns it back into a chip pasted on watercolour.
  - **Hover/focus reveals by subtraction**: the painting drops to `--hero-tree-veil` opacity
    (heavier in dark) and every other marker to 26%, so the one you are on is the only thing
    at full strength. Do NOT do this with a `--paper` rectangle over the art — the SVG's own
    square edge then shows against the hero band.
  - **The hit target is an invisible circle**, not the marker. Both are sized from
    `spacing[k-1]` (how close the closest two of the first k spots get), so they shrink
    together; `HIT_OF_SPACING < 0.5` is what guarantees the circles never overlap.
  - **`heroTreeSpots.ts` is generated** by `scripts/generate-hero-tree-markers.py`; rerun it
    after touching the artwork and never hand-edit the output. Leaves are green-dominant
    (`G >= R`) and bark is not, which is what lets fruit sit only on foliage and snails only
    on the trunk. Foliage points additionally have to clear the bark (`BARK_CLEARANCE`) —
    the canopy has green pixels right against the trunk, and without it fruit hangs on the
    trunk, which is the one thing fruit must never do. Ground positions are in the component
    (`GROUND_SPOTS`), since they are outside the painting.
  - Markers are **never rotated to the branch**: an insect faces up regardless of the leaf's
    tilt, and rotating it reads as pasted-on immediately. **Only things that rest get a
    contact shadow** (`SHADES`); bees and butterflies get a smaller, blurred one further
    down. That single detail carries most of the "sitting on it" impression.
  - **「この木について」** (`HeroTreeAbout.tsx`) sits under the tree and opens the whole
    mapping in a shadcn `Dialog`. It must keep working logged out — explaining "acquire a
    domain and the tree fills up" to someone who has none is its main job; the live counts
    are the secondary one. The table is マーカー／期限の帯／いま and nothing else
    (2026-08-28): the 出る場所 and なぜそれか columns were cut — a legend maps picture to
    meaning; placement and authorial rationale don't help the reader decide anything.
  - Past 40 the count is printed (`ほかに◯件`), never dropped silently.
  - The stages share one coordinate system (width 960, ground line `GROUND_Y`, bottom
    `VIEW_BOTTOM`). Only the artwork's size and the `viewBox` **top** change, so the ground
    never moves between stages and the growth reads as the plant, not a zoom.
  - Logged out, or with 0 domains, or when `listDomains` fails, it is just the tree with no
    markers and the SVG is `aria-hidden` — the top page never renders a list error.
  - Marker colours are `--marker-*` in `app.css`: natural-object colours, not brand tokens,
    because a red berry is red in both themes. Only the pale ones are dimmed for dark.
  The one Storyset illustration this replaced was the only third-party art in the app, so the
  footer's mandatory "Illustration by Storyset" credit went with it — do not reintroduce one
  without the other.
- The ログイン／会員登録 pair at the right end of the header is two boxes butted together
  (`-ml-px`) so they read as one block. Keep the seam — a `gap` there turns the entry
  point back into two loose buttons.

## Layout & spacing

- Page root: `<div className="space-y-6">` (the shell provides outer padding/max-width).
- EXCEPTION — the top page (`/`): `AppLayout` gives it no max-width or padding so it can
  run the theme's full-bleed bands. Pages under `/` own their own `max-w-[1400px]`
  container (see `WRAP` in `DomainSearchPage.tsx`).
- **Landing band order** (`DomainSearchPage.tsx`): ヒーロー → 安いTLDの帯 → 対応TLDと料金
  → 3つの安心 → 結果見本 → 機能紹介 → CTA. The first five answer "what happens before I
  search"; **機能紹介** (`LandingFeatures.tsx` — かんたんモード / AIアシスタント / つなぐ)
  answers "what happens after I buy", which is why it sits last. Its three rows alternate
  copy/見本 sides (`flip`), and the 見本 panels are `bg-card` + `shadow-soft` on the bare
  `--paper` ground — the band above it is already `bg-paper-2`, so tinting this one too
  would merge the two into a single 1500px slab.
- **A 見本 is built from the real thing, and says so.** Both 結果見本 and every panel in
  機能紹介 reuse the product's own data (`TldCell`, `EASY_STEPS`, `DNS_RECIPES`,
  `plainRecordLabel`, the `assistantMessages` headings) instead of literals, carry a
  `※ 表示は見本です` line, and contain nothing focusable. A hard-coded step name or service
  list would leave the top page advertising a flow that no longer exists.
- **The 22-TLD price list is a list, not a card grid** (2026-08-28). One row per TLD —
  `TLD ─ 初年度 ─ 更新` — three columns at `lg`, inside ONE `bg-card shadow-soft` panel
  (the theme has one shadow; do not print it 22 times). This replaced 4 columns of tall
  cards that cost ~900px of the page on their own. Per spec §6.2.5 the two figures share a
  font size and are separated by weight and `text-ink-faint`, and the lede — not a per-row
  label — says which is which.
- Page header pattern:
  ```tsx
  <header className="space-y-1.5">
    <h1 className="text-2xl font-bold tracking-tight">…</h1>
    <p className="text-sm text-muted-foreground leading-relaxed">…</p>
  </header>
  ```
  With a right-aligned action: wrap in `flex flex-wrap items-start justify-between gap-4`.
- Panels/sections: replace `.panel` with `Card` (`CardHeader` + `CardContent`, optionally
  `CardFooter`). Card content stacks: `space-y-4`.
- Forms: `space-y-5` between fields; related inline controls `flex gap-2`.
- Button rows: `flex flex-wrap gap-3` (primary action LAST visually on confirm steps is
  NOT required — keep current order); on mobile buttons may go full width via `w-full sm:w-auto`.

## Components (mandatory mappings)

| Old | New |
|---|---|
| `.panel` | `Card` + `CardHeader`/`CardTitle` + `CardContent` |
| `.button--primary` | `<Button>` (default variant) |
| `.button--ghost` / plain `.button` | `<Button variant="outline">` (or `ghost` for low-emphasis inline actions) |
| `StatusBanner` | keep the `StatusBanner` component (it now wraps shadcn `Alert`) — do not inline Alerts in pages |
| `.tag`, `.status-tag` | `<Badge>` (variants: `default` for positive/teal, `secondary` for neutral, `destructive` for taken/error, `outline` for unknown) |
| `.input`, `select.input` | `<Input>`, `<Select>` (shadcn) — native `<select>` may remain ONLY where tests target it via role `combobox` + `.input` styling is gone; prefer shadcn `Select` unless a test queries the native element by role and options (see Testing) |
| `.checkbox-option` | `<Checkbox>` + `<Label>` in `flex items-start gap-3` row (or `RadioGroup` for radios) |
| loaders | `Loader2` icon (`animate-spin`) or `Skeleton` for content placeholders |
| tooltips | `Tooltip` (provider is mounted in AppLayout) |
| toasts | `toast()` from `sonner` (Toaster mounted in AppLayout) — ONLY for feedback not asserted by tests |

## States

- Loading buttons: `disabled` + `<Loader2 className="animate-spin" />` prefix + the existing
  Japanese in-progress label (keep exact wording — tests assert it).
- Disabled: rely on shadcn built-ins (`disabled:opacity-50` etc.). Never remove `disabled` logic.
- Focus: shadcn's `focus-visible` rings are the standard; do not add custom outlines.
- Empty states: centered `text-sm text-muted-foreground` block with an icon (lucide) where useful.

## Responsive

- Mobile-first. Breakpoints: `sm:` (≥640), `md:` (≥768), `lg:` (≥1024).
- Two-column layouts (e.g. search results + cart) collapse to one column below `lg`.
- Tables that can't reflow get `overflow-x-auto` wrappers.

## Icons

- `lucide-react` only. Size `size-4` inline with text, `size-5` standalone. Every icon-only
  button keeps an `aria-label`.

## Hard constraints (DO NOT BREAK)

1. **All Japanese copy comes from the existing message modules / literals — keep wording
   byte-identical.** Tests query by exact text.
2. Keep all aria attributes: `aria-describedby` wiring from `Field`, `role="alert"` on errors,
   `role="status"` on progress/copy feedback, `aria-pressed` on toggles, `aria-label` on
   glyph-only controls.
3. Domain availability keeps THREE visually distinct states (◯ available / ✕ taken / ？ unknown),
   each pairing color with a text/glyph (never color alone).
4. `PriceDisplay`: first-year and renewal figures must share the same font size (spec §6.2.5).
5. `AuthInfoMasked`: fixed mask, copy button — NO reveal toggle (spec §7.3).
6. Do not change routing, state management, API calls, or message modules.
7. Do not edit files owned by another workstream (ownership list in the task prompt).
8. **The login e-mail field is ONE input** (`features/auth/EmailField.tsx`). The
   `@example.com` pulldown was removed 2026-08-27: sign-in only checks that the address is
   well-formed (`正しいメールアドレスを入力してください。`, shown on blur and on submit).
   The closed domain list is a REGISTRATION rule and lives in
   `features/signup/accountSchema.ts` — do not push it back onto the login form.

## Testing

- After changes run the relevant suite(s): `npx vitest run src/app/authFlows.test.tsx`
  (or domainSearchFlow / orderFlow) and finally `npm test`.
- Tests may be updated ONLY when a query targets an implementation detail that legitimately
  changed (e.g. native `<select>` → shadcn Select requires switching from `selectOptions` to
  click-based interaction). Never weaken an assertion; keep the user-visible behavior asserted.
  Prefer keeping native form controls where a test heavily depends on them.
