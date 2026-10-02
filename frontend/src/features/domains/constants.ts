/**
 * Domain-name input constraints the UI must enforce (spec §3.4).
 *
 * The pseudo registries reject anything else with HTTP 400, so a search box
 * that lets through full-width characters, stray hyphens, or an over-length
 * label would fail 100% of the time once the backend forwards it to
 * domain:check / domain:create.
 */

/** Per-label cap (spec §3.4: "各ラベル ≤63文字"). The search box takes one label. */
export const DOMAIN_LABEL_MAX_LENGTH = 63

/**
 * Whole-name cap (spec §3.4: "全体 ≤253文字"). Kept only because the spec
 * states it as a distinct rule - unreachable in practice here since a single
 * ≤63-char label plus any real TLD never approaches 253 characters.
 */
export const DOMAIN_TOTAL_MAX_LENGTH = 253

/** Alphanumeric and hyphen only (spec §3.4); leading/trailing hyphen is checked separately. */
export const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9-]+$/

/** "おすすめTLDを3件提示" (spec §6.2.4). */
export const SUGGESTION_TARGET_COUNT = 3

/**
 * Used only when GET /api/domains/tlds fails (spec §4.3: "失敗時はフォール
 * バック定義を使う"). All four are ✅ confirmed (§3.8) — `.com` / `.net` on
 * Kitaqsign, and `.org` / `.info` on Kitaqnic since the 2026-08-27 16:00
 * registry-side move. This list intentionally excludes Kitaqnic's other 18
 * (TBD #1, not yet researched) so the fallback never claims support for a
 * TLD nobody has verified.
 */
export const FALLBACK_TLDS = ['.com', '.net', '.org', '.info'] as const
