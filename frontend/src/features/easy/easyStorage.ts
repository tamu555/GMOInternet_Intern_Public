/**
 * かんたんモードの下書き保存（localStorage）。
 *
 * sessionStorage ではなく localStorage を使うのは意図的。仕様 §6.2.3 が
 * 「再ログインしても正しい位置に復帰する」ことを要求しており、タブを閉じた
 * 時点で消える sessionStorage では構造的に満たせないため。
 * （signup が sessionStorage で足りるのは、会員登録が1タブで完結する作業だから。）
 *
 * 保存するのは EasySession（＝入力途中の「意図」）だけで、機微情報は載せない。
 * authInfo は注文のたびに生成し、永続化しない（SignupProvider がパスワードを
 * 除外しているのと同じ方針）。
 *
 * 読み出しは必ず形を検証する。localStorage の中身はユーザーが書き換えられる
 * うえ、domainName は callable の引数に、orderId は navigate() のパスに入るため、
 * 壊れた値は「保存が無い」として扱う。
 */
import { EMPTY_EASY_SESSION, type EasySession } from './easyTypes'

/** v1: 初版。スキーマを変えるときは v2 に上げて古い下書きを破棄する。 */
const STORAGE_PREFIX = 'registrar.easy.session.v1'

/** 未ログインで入力を始めた人の下書き。ログイン後に uid スコープへ引き継ぐ。 */
export const GUEST_SCOPE = 'guest'

/**
 * 下書きの寿命（issue #91）。最終更新から 24 時間で破棄する。
 *
 * localStorage は放っておけば無期限に残るので、数日前に途中でやめた人が
 * `/easy` を開くと、覚えていない目的・覚えていない名前の「2/6」から再開させられる。
 * 「続きから」に値打ちがあるのは、その続きを本人がまだ覚えているあいだだけ。
 * 1 日を境にしているのは、席を立って翌日戻ってくるまでは続きとして成立し、
 * それ以上空けば別の用事になっている、という線引き。
 *
 * ⚠️ 期限切れでも **orderId のある下書きは残す**。あれはもう「入力内容」ではなく
 * 購入済みドメインの設定途中で、消すと `/easy` からつなぐ設定（ステップ6）へ戻る
 * 手がかりが無くなる（`clearEasyDrafts` の carve-out と同じ理由）。
 */
export const EASY_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 下書きが寿命を過ぎているか。`updatedAt` が空・不正な値のものは、いつ書かれたか
 * 分からない＝判定できないので「切れていない」側に倒す（勝手に消さない）。
 */
export function isExpiredEasySession(session: EasySession, now: number = Date.now()): boolean {
  if (session.orderId !== null) return false
  if (session.updatedAt === '') return false
  const updatedAt = Date.parse(session.updatedAt)
  if (Number.isNaN(updatedAt)) return false
  return now - updatedAt > EASY_DRAFT_TTL_MS
}

export function easyStorageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${scope}`
}

const PURPOSES = new Set(['business', 'blog', 'shop', 'event', 'mail', 'undecided'])
const DNS_PLANS = new Set(['web', 'mail', 'both', 'later', 'recommended'])

/** 保存された値の型・書式を検証し、怪しい値は初期値へ落とす。 */
function coerceSession(raw: unknown): EasySession {
  if (typeof raw !== 'object' || raw === null) return EMPTY_EASY_SESSION
  const value = raw as Record<string, unknown>

  const label = typeof value.label === 'string' && /^[A-Za-z0-9-]{0,63}$/.test(value.label) ? value.label : ''
  const tld = typeof value.tld === 'string' && /^\.[a-z]{2,24}$/.test(value.tld) ? value.tld : ''
  const orderId =
    typeof value.orderId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.orderId) ? value.orderId : null
  const domainName =
    typeof value.domainName === 'string' && /^[A-Za-z0-9-]{1,63}\.[a-z]{2,24}$/.test(value.domainName)
      ? value.domainName
      : ''

  const candidates = Array.isArray(value.candidates)
    ? value.candidates
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .filter((entry) => typeof entry.label === 'string' && /^[A-Za-z0-9-]{1,63}$/.test(entry.label))
        .slice(0, 20)
        .map((entry) => ({
          label: entry.label as string,
          reason: typeof entry.reason === 'string' ? entry.reason : '',
          traits: Array.isArray(entry.traits)
            ? entry.traits.filter((trait): trait is string => typeof trait === 'string').slice(0, 5)
            : [],
        }))
    : []

  const favorites = Array.isArray(value.favorites)
    ? value.favorites
        .filter((entry): entry is string => typeof entry === 'string' && /^[A-Za-z0-9-]{1,63}$/.test(entry))
        .slice(0, 20)
    : []

  const dnsInputs: Record<string, string> = {}
  if (typeof value.dnsInputs === 'object' && value.dnsInputs !== null) {
    for (const [key, entry] of Object.entries(value.dnsInputs as Record<string, unknown>)) {
      if (typeof entry === 'string' && entry.length <= 253) dnsInputs[key] = entry
    }
  }

  return {
    purpose:
      typeof value.purpose === 'string' && PURPOSES.has(value.purpose)
        ? (value.purpose as EasySession['purpose'])
        : null,
    purposeNote: typeof value.purposeNote === 'string' ? value.purposeNote.slice(0, 500) : '',
    candidates,
    favorites,
    label,
    tld,
    years: typeof value.years === 'number' && Number.isInteger(value.years) && value.years > 0 && value.years <= 10
      ? value.years
      : EMPTY_EASY_SESSION.years,
    autoRenew: typeof value.autoRenew === 'boolean' ? value.autoRenew : EMPTY_EASY_SESSION.autoRenew,
    dnsPlan:
      typeof value.dnsPlan === 'string' && DNS_PLANS.has(value.dnsPlan)
        ? (value.dnsPlan as EasySession['dnsPlan'])
        : null,
    dnsServiceId:
      typeof value.dnsServiceId === 'string' && /^[a-z0-9-]{1,40}$/.test(value.dnsServiceId)
        ? value.dnsServiceId
        : null,
    dnsInputs,
    orderId,
    domainName,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

export function loadEasySession(scope: string): EasySession {
  try {
    const raw = window.localStorage.getItem(easyStorageKey(scope))
    if (!raw) return EMPTY_EASY_SESSION
    const session = coerceSession(JSON.parse(raw))
    /* 期限切れはここで断つ。読み出し口を 1 つに絞ってあるので、画面ごとに
       「古くないか」を確かめて回る必要がない（確かめ漏れた画面だけが古い
       下書きで動く、という食い違いが起きない）。 */
    if (isExpiredEasySession(session)) {
      clearEasySession(scope)
      return EMPTY_EASY_SESSION
    }
    return session
  } catch {
    // 壊れた JSON / プライベートモード: メモリ内の状態で動き続ける。
    return EMPTY_EASY_SESSION
  }
}

export function saveEasySession(scope: string, session: EasySession): void {
  try {
    window.localStorage.setItem(easyStorageKey(scope), JSON.stringify(session))
  } catch {
    // 容量超過など。保存できなくてもこのタブの入力は失われない。
  }
}

export function clearEasySession(scope: string): void {
  try {
    window.localStorage.removeItem(easyStorageKey(scope))
  } catch {
    // Ignore.
  }
}

/** 何も入力されていない下書きか（復帰バナーの出し分けと引き継ぎ判定に使う）。 */
export function isEmptyEasySession(session: EasySession): boolean {
  return (
    session.purpose === null &&
    session.label === '' &&
    session.tld === '' &&
    session.orderId === null &&
    session.purposeNote === ''
  )
}

/**
 * トップページに戻ってきたときの下書き破棄（2026-08-28）。
 *
 * サイトのトップは「最初からやり直す場所」なので、そこへ戻ったのに前回の
 * かんたんモードの入力が残っていると、次に `/easy` を開いた人が身に覚えのない
 * 続きから再開させられる。トップを踏んだ時点で入力履歴は捨てる。
 *
 * ⚠️ ただし **注文が発行済み（orderId あり）の下書きは残す**。あれはもう
 * 「入力内容」ではなく購入済みドメインの設定途中で、消すと `/easy` から
 * つなぐ設定（ステップ6）へ戻る手がかりが無くなる。取得そのものは取り消せない
 * のに導線だけ消えるのがいちばん困る状態なので、そこだけは残す。
 *
 * スコープを跨いで全部消すのは意図的: ゲストで入力 → ログイン、の途中で
 * トップを踏むこともあるため、片方だけ残すと引き継ぎで復活してしまう。
 */
export function clearEasyDrafts(): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(`${STORAGE_PREFIX}:`)) keys.push(key)
    }
    for (const key of keys) {
      const scope = key.slice(STORAGE_PREFIX.length + 1)
      if (loadEasySession(scope).orderId !== null) continue
      window.localStorage.removeItem(key)
    }
  } catch {
    // プライベートモードなど。消せなくても画面は動く。
  }
}

/**
 * このブラウザに未完了のかんたんモード下書きが残っているか。
 * ログイン/新規登録の完了画面が「かんたんモードに戻る」導線を出すかの判定に使う
 * （スコープ＝uid が分からない画面からも呼べるよう、prefix 一致で全件を見る）。
 */
export function hasPendingEasySession(): boolean {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(`${STORAGE_PREFIX}:`)) continue
      const scope = key.slice(STORAGE_PREFIX.length + 1)
      if (!isEmptyEasySession(loadEasySession(scope))) return true
    }
  } catch {
    // Ignore: 判定できないときは導線を出さない（誤誘導しない側に倒す）。
  }
  return false
}
