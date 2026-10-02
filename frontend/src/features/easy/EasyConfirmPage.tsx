/**
 * ステップ4: 契約内容の確認（/easy/confirm）。ここから先はログインが必要
 * （AppRouter の RequireAuth。未ログインなら returnTo 付きで /login へ）。
 *
 * 仕様 §1.2 の「隠すのは *描画* だけ。ペイロードは常に完全」をそのまま実装する:
 * `buildInitialOrderFormValues()` で完全な値を作り、`OrderFormSections` の各部品は
 * **既定では 1 つもレンダリングしない**（「変える」を開いたときだけ描画する）。
 * 値は次のステップでそのまま `buildOrderCreateRequest()` に渡る。
 *
 * この画面が問うのは「この内容でよいか」だけである。だから:
 *   - 期間・自動更新は**答え済みの行**として読ませ、入力欄は畳んでおく
 *   - DNSの使いみちはここでは聞かない。目的（ステップ1）から既定が決まり、
 *     実際に設定するステップ6で選択済みの状態から始まる（同じ質問を 2 回しない）
 *   - 料金は表 1 つに集約する。同じ金額を 2 枚のカードに書くと、どちらが
 *     請求額なのか読み手が確かめ直すことになる（内訳は支払い画面にある）
 */
import { useId, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '../../auth/useAuth'
import { StatusBanner } from '../../components/StatusBanner'
import { formatYen } from '../domains/tldData'
import { AutoRenewField, RegistrationYearsField } from '../orders/OrderFormSections'
import { buildInitialOrderFormValues, parseOrderableDomain, totalPriceYen, validateOrderForm } from '../orders/orderFormModel'
import { EasyPageHeader, EasyStepActions, EasyStepNav } from './EasyStepActions'
import {
  AUTO_RENEW_OFF_SUMMARY,
  autoRenewOnSummary,
  confirmChargedLabel,
  CONFIRM_CHANGE_ACTION,
  CONFIRM_HEADING,
  CONFIRM_HIDDEN_SETTINGS_NOTE,
  CONFIRM_INVALID_ERROR,
  CONFIRM_LEDE,
  CONFIRM_SETTINGS_SUMMARY,
  CONFIRM_TO_PAYMENT_ACTION,
} from './easyMessages'
import { purposeLabel } from './purposeOptions'
import { easyStepDef } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyGate } from './useEasyGate'
import { easyNameResultsPath, easyStepPathWithReturn } from './useEasyReturn'

/** 開いたときだけ中身が存在する（Radix の Accordion）ので、フォーカスは次フレーム。 */
const SETTINGS_ACCORDION_VALUE = 'settings'

function SummaryRow({
  term,
  children,
  action,
}: {
  term: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="flex items-baseline gap-3 text-sm font-medium">
        <span>{children}</span>
        {action}
      </dd>
    </div>
  )
}

/**
 * 「変更」ボタン。該当ステップがあるものはそのステップへ、無いもの
 * （契約期間・自動更新）は同じ画面の折りたたみを開いて入力へフォーカスする。
 *
 * ステップへ送るときは `?return=confirm` を付ける。付けないと各ステップの
 * 「次へ」が 1 つ先へ進むだけなので、1 項目直したい人がウィザードを最後まで
 * 歩き直すことになる（useEasyReturn.ts を参照）。
 */
function ChangeButton({ item, onClick }: { item: string; onClick: () => void }) {
  return (
    <Button variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={onClick}>
      <Pencil aria-hidden="true" />
      <span className="sr-only">{item}を</span>
      {CONFIRM_CHANGE_ACTION}
    </Button>
  )
}

export function EasyConfirmPage() {
  const gate = useEasyGate('confirm')
  const idPrefix = useId()
  const navigate = useNavigate()
  const { session, setYears, setAutoRenew, setStepError, stepErrors } = useEasy()
  const { state: authState } = useAuth()
  const [invalid, setInvalid] = useState(false)
  const [openSettings, setOpenSettings] = useState('')

  if (gate) return gate

  const parsed = parseOrderableDomain(`${session.label}${session.tld}`)
  if (!parsed) {
    // 取り扱いのない TLD がセッションに残っている場合（保存値の改変など）。
    return (
      <div className="space-y-6">
        <EasyPageHeader title={CONFIRM_HEADING} />
        <StatusBanner tone="error">
          選んだドメインの末尾を確認できませんでした。もう一度選び直してください。
        </StatusBanner>
        <Button onClick={() => navigate(easyStepDef('tld').path)}>ドメインの末尾を選び直す</Button>
      </div>
    )
  }

  // RequireAuth を通っているので user は必ずいる。
  const user = authState.user
  if (!user) return null

  const { domainName, pricing } = parsed
  const total = totalPriceYen(pricing, session.years)

  /** 折りたたみを開いてから、その中の入力へフォーカスを送る。 */
  function revealSetting(controlId: string) {
    setOpenSettings(SETTINGS_ACCORDION_VALUE)
    requestAnimationFrame(() => {
      const control = document.getElementById(controlId)
      control?.scrollIntoView({ block: 'center' })
      control?.focus()
    })
  }

  function handleNext() {
    /* 描画していない項目も必ず検証する。「隠したせいで送信できない画面」を
       作らないための §1.2 の事故防止条項。 */
    const values = { ...buildInitialOrderFormValues(), years: session.years, autoRenew: session.autoRenew }
    if (Object.keys(validateOrderForm(values)).length > 0) {
      setInvalid(true)
      setStepError('confirm', CONFIRM_INVALID_ERROR)
      return
    }
    setInvalid(false)
    setStepError('confirm', null)
    navigate(easyStepDef('payment').path)
  }

  return (
    <div className="space-y-5">
      <EasyStepNav backTo={easyStepDef('tld').path} />

      <EasyPageHeader title={CONFIRM_HEADING} lede={CONFIRM_LEDE} />

      {invalid || stepErrors.confirm ? <StatusBanner tone="error">{CONFIRM_INVALID_ERROR}</StatusBanner> : null}

      {/* ⚠️ カードに「お申し込み内容」の見出しを付けない。ページ見出しの
          「内容の確認」と同じことを言っているだけで、読む行が 1 本増える。
          このカードの主語はドメイン名そのもので、それが下の 1 行目に出ている。 */}
      <Card>
        <CardContent className="space-y-4">
          {/* 何を買うのかは行の中で探させない。この画面の主語として先に置く。 */}
          <p className="font-mono text-[22px] leading-tight font-bold break-all text-green-darkest">
            {domainName}
          </p>

          <dl className="divide-y divide-border">
            {/* 行の名前は進行バーの段（名前 / 末尾）と同じ語にそろえる。
                同じものを画面ごとに違う語で呼ぶと、戻り先が分からなくなる。 */}
            <SummaryRow
              term="名前"
              action={
                <ChangeButton
                  item="名前"
                  onClick={() => navigate(easyNameResultsPath(null, 'confirm'))}
                />
              }
            >
              <span className="font-mono">{session.label}</span>
            </SummaryRow>

            <SummaryRow
              term="末尾"
              action={
                <ChangeButton
                  item="末尾"
                  onClick={() => navigate(easyStepPathWithReturn('tld', 'confirm'))}
                />
              }
            >
              <span className="font-en">{session.tld}</span>
            </SummaryRow>

            <SummaryRow
              term="使いみち"
              action={
                <ChangeButton
                  item="使いみち"
                  onClick={() => navigate(easyStepPathWithReturn('goal', 'confirm'))}
                />
              }
            >
              {purposeLabel(session.purpose)}
            </SummaryRow>

            <SummaryRow
              term="契約期間"
              action={<ChangeButton item="契約期間" onClick={() => revealSetting(`${idPrefix}-years-years`)} />}
            >
              {session.years}年
            </SummaryRow>

            <SummaryRow
              term="自動更新"
              action={<ChangeButton item="自動更新" onClick={() => revealSetting(`${idPrefix}-renew-auto-renew`)} />}
            >
              {session.autoRenew
                ? autoRenewOnSummary(formatYen(pricing.renewalYearYen))
                : AUTO_RENEW_OFF_SUMMARY}
            </SummaryRow>

            {/* §6.2.5: 初年度と更新料は同じ文字サイズで並記する。 */}
            <SummaryRow term="初年度料金">
              <span className="font-en">{formatYen(pricing.firstYearYen)}</span>
            </SummaryRow>
            <SummaryRow term="2年目以降 毎年">
              <span className="font-en">{formatYen(pricing.renewalYearYen)}</span>
            </SummaryRow>

            <SummaryRow term="契約者情報">
              <span className="block text-right">
                {user.displayName}
                <span className="block text-[13px] font-normal text-muted-foreground">{user.email}</span>
              </span>
            </SummaryRow>
          </dl>

          {/* 請求額だけは表から出す。表の 1 行として並べると、同額になりがちな
              「初年度料金」と字の太さでしか区別できず、どちらが請求額なのかを
              読み手が確かめ直すことになる（このファイル冒頭の禁止事項）。 */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-grass-2 px-3 py-3">
            <span className="text-sm font-medium">{confirmChargedLabel(session.years)}</span>
            <strong className="font-en text-xl font-bold text-green-darkest">{formatYen(total)}</strong>
          </div>

          {/* 期間も自動更新も既定値のままで問題ないので、入力欄は畳んでおく。
              サマリー行の「変更」がここを開き、該当の入力へフォーカスを送る。 */}
          <Accordion
            type="single"
            collapsible
            value={openSettings}
            onValueChange={setOpenSettings}
            className="bg-grass-1/60 px-3"
          >
            <AccordionItem value={SETTINGS_ACCORDION_VALUE}>
              <AccordionTrigger className="py-3">{CONFIRM_SETTINGS_SUMMARY}</AccordionTrigger>
              <AccordionContent className="space-y-5 pb-4">
                {/* OrderFormSections の部品をそのまま使う（かんたんモード専用の
                    フォーム部品は作らない — 仕様 §1.2）。 */}
                <RegistrationYearsField
                  idPrefix={`${idPrefix}-years`}
                  value={session.years}
                  onChange={setYears}
                />
                <AutoRenewField
                  idPrefix={`${idPrefix}-renew`}
                  checked={session.autoRenew}
                  onChange={setAutoRenew}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      <StatusBanner tone="info">{CONFIRM_HIDDEN_SETTINGS_NOTE}</StatusBanner>

      <EasyStepActions nextLabel={CONFIRM_TO_PAYMENT_ACTION} onNext={handleNext} />
    </div>
  )
}
