import { cn } from '@/lib/utils'

/**
 * The product logo: a sprout growing out of the O of ゼロ.
 *
 * This is the app icon itself (public/*.png, all generated from one artwork),
 * not a redrawn variant — the header, the login card and the browser tab all
 * show the same picture, which is the whole point of a mark. index.html wires
 * the other sizes; this one renders the 128px version, enough for the largest
 * on-screen use (44px on the login card) at 3x.
 *
 * No tokens here on purpose: the tile is a fixed brand asset, so unlike the
 * rest of the UI it does not restate itself in dark mode. It stays legible
 * there anyway — the cream O and the pale leaves are the light half of the
 * palette, and they read against `--paper`'s deep green either way.
 *
 * Decorative: every call site puts the product name in text right next to it,
 * so the mark is `aria-hidden` and carries an empty alt.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand-mark-128.png"
      alt=""
      aria-hidden="true"
      width={128}
      height={128}
      className={cn('block size-7 shrink-0', className)}
    />
  )
}
