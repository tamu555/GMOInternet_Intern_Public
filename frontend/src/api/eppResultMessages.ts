/**
 * EPP result.code -> Japanese wording (spec §6.7 "EPP Error Doctor").
 *
 * THE one place for this mapping - §6.7 requires it to live in a single
 * module so screens cannot drift apart (precedent: features/auth/authMessages.ts
 * for the auth wording). Do not write per-screen copies of these strings.
 *
 * ⚠️ Contract to agree with the backend (frontend README "未合意事項"): we
 * assume the backend passes the registry's raw `result.code` through (e.g. as
 * `eppCode` on search results, `resultCode` on failed orders) and the frontend
 * maps it here. If the backend instead translates codes into its own error
 * kinds, this module becomes the mapping for *that* enum - either way the
 * mapping stays in this file only.
 */

/** spec §6.7 対応表. 1000 = success and has no user-facing error wording. */
export const EPP_SUCCESS_CODE = 1000

const EPP_CODE_MESSAGES: Record<number, string> = {
  2302: 'このドメインはすでに使われています。',
  2303: '対象が見つかりませんでした。',
  2202: '認証コードが違うようです。移管元でもう一度確認してください。',
  2306: 'この操作は現在の状態では行えません。',
}

/** Returns undefined for success (1000) and for codes the table does not know. */
export function messageForEppCode(code: number | undefined): string | undefined {
  if (code === undefined || code === EPP_SUCCESS_CODE) return undefined
  return EPP_CODE_MESSAGES[code]
}
