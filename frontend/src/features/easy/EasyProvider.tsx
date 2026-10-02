/**
 * かんたんモードの状態ホルダー。型は easyContext.ts、保存は easyStorage.ts。
 *
 * 保存スコープは uid 単位（共有端末で他人の下書きが見えないように）。未ログインで
 * 入力を始めた人は 'guest' スコープに書き、ログイン/新規登録が完了した時点で
 * uid スコープへ引き継ぐ — これがあるので「ログインを挟んでも入力が消えない」。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/useAuth'
import { EasyContext, type EasyContextValue } from './easyContext'
import {
  GUEST_SCOPE,
  clearEasySession,
  isEmptyEasySession,
  loadEasySession,
  saveEasySession,
} from './easyStorage'
import {
  EMPTY_EASY_SESSION,
  completedStepsOf,
  type EasyDnsPlanKind,
  type EasyNameCandidate,
  type EasyPurposeKind,
  type EasySession,
  type EasyStepId,
} from './easyTypes'

function scopeForUserId(userId: string | null): string {
  return userId ?? GUEST_SCOPE
}

/**
 * そのスコープの下書きを読む。uid 側がまだ空でゲストの下書きが残っていれば、
 * それを引き継いでゲスト側を消す（＝ログイン画面を挟んでも入力が失われない）。
 */
function loadForScope(scope: string): EasySession {
  const stored = loadEasySession(scope)
  if (scope === GUEST_SCOPE || !isEmptyEasySession(stored)) return stored

  const guestDraft = loadEasySession(GUEST_SCOPE)
  if (isEmptyEasySession(guestDraft)) return stored

  saveEasySession(scope, guestDraft)
  clearEasySession(GUEST_SCOPE)
  return guestDraft
}

/** 現在のスコープと、そのスコープで読み込んだ下書き。 */
type ScopedSession = { scope: string; session: EasySession }

export function EasyProvider({ children }: { children: ReactNode }) {
  const { state: authState } = useAuth()
  const userId = authState.status === 'authenticated' ? authState.user.id : null
  const scope = scopeForUserId(userId)

  const [scoped, setScoped] = useState<ScopedSession>(() => ({ scope, session: loadForScope(scope) }))
  const [stepErrors, setStepErrors] = useState<Partial<Record<EasyStepId, string>>>({})

  /* Adjust-during-render: ログインが成立して保存スコープが変わった瞬間に、
     そのスコープの下書きへ差し替える（DomainSearchPage が URL の変化を
     フォームへ反映しているのと同じパターン）。エフェクトにすると、古い
     スコープの内容で 1 フレーム描画してしまう。 */
  if (scoped.scope !== scope) {
    setScoped({ scope, session: loadForScope(scope) })
  }

  const session = scoped.session

  const update = useCallback(
    (updater: (current: EasySession) => EasySession) => {
      setScoped((current) => {
        const next = { ...updater(current.session), updatedAt: new Date().toISOString() }
        saveEasySession(current.scope, next)
        return { scope: current.scope, session: next }
      })
    },
    [],
  )

  const setStepError = useCallback((step: EasyStepId, message: string | null) => {
    setStepErrors((current) => {
      if (message === null) {
        if (!(step in current)) return current
        const { [step]: _removed, ...rest } = current
        return rest
      }
      if (current[step] === message) return current
      return { ...current, [step]: message }
    })
  }, [])

  /* アクションは session に依存させない（update だけに依存させる）。
     依存させると session 更新のたびに関数の同一性が変わり、これらを依存配列に
     入れている画面側の useEffect が再実行されてしまう。 */
  const choosePurpose = useCallback(
    (purpose: EasyPurposeKind, note: string) =>
      update((current) => ({
        ...current,
        purpose,
        purposeNote: note,
        // 目的が変わったら、その目的で作った候補は意味を失う。
        candidates: current.purpose === purpose ? current.candidates : [],
      })),
    [update],
  )

  const saveCandidates = useCallback(
    (candidates: EasyNameCandidate[]) => update((current) => ({ ...current, candidates })),
    [update],
  )

  const toggleFavorite = useCallback(
    (label: string) =>
      update((current) => ({
        ...current,
        favorites: current.favorites.includes(label)
          ? current.favorites.filter((entry) => entry !== label)
          : [...current.favorites, label],
      })),
    [update],
  )

  const chooseLabel = useCallback(
    (label: string) =>
      update((current) => ({
        ...current,
        label,
        // 名前が変われば別のドメイン。選択済みの末尾は無効になる。
        tld: current.label === label ? current.tld : '',
      })),
    [update],
  )

  const chooseTld = useCallback((tld: string) => update((current) => ({ ...current, tld })), [update])

  const setYears = useCallback((years: number) => update((current) => ({ ...current, years })), [update])

  const setAutoRenew = useCallback(
    (autoRenew: boolean) => update((current) => ({ ...current, autoRenew })),
    [update],
  )

  const chooseDnsPlan = useCallback(
    (dnsPlan: EasyDnsPlanKind | null) =>
      update((current) => ({
        ...current,
        dnsPlan,
        // 使いみちが変わればサービス候補も変わる。
        dnsServiceId: current.dnsPlan === dnsPlan ? current.dnsServiceId : null,
      })),
    [update],
  )

  const chooseDnsService = useCallback(
    (dnsServiceId: string | null) => update((current) => ({ ...current, dnsServiceId })),
    [update],
  )

  const setDnsInput = useCallback(
    (key: string, inputValue: string) =>
      update((current) => ({ ...current, dnsInputs: { ...current.dnsInputs, [key]: inputValue } })),
    [update],
  )

  const recordOrder = useCallback(
    (orderId: string, domainName: string) => update((current) => ({ ...current, orderId, domainName })),
    [update],
  )

  /* 保存だけ消す。setState しないので、完了画面を表示したままでも
     ガードが発火しない（＝画面が先頭に飛ばされない）。 */
  const finish = useCallback(() => {
    clearEasySession(scopeForUserId(userId))
    clearEasySession(GUEST_SCOPE)
  }, [userId])

  const reset = useCallback(() => {
    const currentScope = scopeForUserId(userId)
    clearEasySession(currentScope)
    clearEasySession(GUEST_SCOPE)
    setStepErrors({})
    setScoped({ scope: currentScope, session: EMPTY_EASY_SESSION })
  }, [userId])

  const value = useMemo<EasyContextValue>(
    () => ({
      session,
      completedSteps: completedStepsOf(session),
      stepErrors,
      setStepError,
      choosePurpose,
      saveCandidates,
      toggleFavorite,
      chooseLabel,
      chooseTld,
      setYears,
      setAutoRenew,
      chooseDnsPlan,
      chooseDnsService,
      setDnsInput,
      recordOrder,
      finish,
      reset,
    }),
    [
      session,
      stepErrors,
      setStepError,
      choosePurpose,
      saveCandidates,
      toggleFavorite,
      chooseLabel,
      chooseTld,
      setYears,
      setAutoRenew,
      chooseDnsPlan,
      chooseDnsService,
      setDnsInput,
      recordOrder,
      finish,
      reset,
    ],
  )

  return <EasyContext.Provider value={value}>{children}</EasyContext.Provider>
}
