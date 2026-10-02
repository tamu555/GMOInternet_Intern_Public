/**
 * ステップ6: easyDNS 設定（/easy/dns）。
 *
 * 支払い直後に来る画面なので、まず注文の完了を待つ（既存の useOrderPolling を
 * そのまま使う。かんたんモード用のポーリングは作らない）。
 *
 * ⚠️ 「何に使うか」はステップ1の目的で既に答えている質問なので、ここでは
 * 聞き直さない。`defaultDnsPlanFor()` が解決した既定を**選択済みの答え**として
 * 1 行で見せ、違うときだけ「使いみちを変える」を開く。したがってこの画面で
 * 初心者に残る判断は「どのサービスか」の 1 つだけになる。
 *
 * A / CNAME / MX といった用語は最初から前面に出さない。「詳細を見る」を開いた
 * ときだけ、実際に書き込まれるレコードを表示する（仕様 §1.4: 用語は消さずに注釈）。
 * ⚠️ ただし「何が起きるか」の 1 行だけは折りたたみに入れない。確定ボタンの真上に
 * 常に出し、しかもレコードから組み立てる（サービスごとの固定文にしない）。
 *
 * 画面は 2 フェーズ持つ (§6.3.3d):
 *   1. 設定を選ぶ  → 保存
 *   2. 確認する    → 同じ画面のまま DnsCheckPanel を出し、「完了」で done へ
 * 保存した瞬間に完了画面へ飛ばしてはならない。「つながったか確認する」手段が
 * 無いまま放り出されるのが、初心者がいちばん詰まる場所だからである。
 * 保存直後は必ず「反映待ち」になるが、これは正常系（赤いエラーにしない）。
 *
 * つなぎ先がまだ無い人（ドメインだけ買った人）には、サービス一覧の最後に
 * 「まだ用意していない」を置き、何を用意するか・例・順番・いま決めなくてよい
 * 理由を案内する。ここが無いと、その人はどの選択肢にも当てはまらず、「あとで
 * 設定する」で追い出されるだけになる。⚠️ この選択でもレコードは保存しない。
 *
 * サービスの mode は 2 種類ある:
 *   - 'records'  : レシピのレコードを保存する
 *   - 'ns-guide' : ⚠️ レコードを保存しない。空配列の保存は「全部消す」保存に
 *                  なるので、NS変更モードへの案内と警告だけを出す (§6.3.3e)。
 */
import { useId, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowRight, ClipboardPaste, ExternalLink, Loader2, Wrench } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { saveDnsRecords } from '../../api/dnsApi'
import { Field } from '../../components/Field'
import { DnsCheckPanel } from '../dns/DnsCheckPanel'
import { delegationFromStatuses } from '../dns/dnsCheckStatus'
import { PasteDialog } from '../dns/PasteDialog'
import type { DnsRecord } from '../dns/dnsRecordTypes'
import { NS_CHANGE_WARNING } from '../mypage/mypageMessages'
import { Input } from '@/components/ui/input'
import { StatusBanner } from '../../components/StatusBanner'
import {
  NO_DOUBLE_CHARGE_MESSAGE,
  ORDER_FAILED_MESSAGE,
  ORDER_FAILED_NO_CHARGE_MESSAGE,
  ORDER_NOT_FOUND_MESSAGE,
  ORDER_STATUS_UNAVAILABLE_MESSAGE,
  PROVISIONING_MESSAGE,
  RETRYING_MESSAGE,
} from '../orders/orderMessages'
import { useOrderPolling } from '../orders/useOrderPolling'
import { EasyPageHeader } from './EasyStepActions'
import {
  EASY_DNS_PLAN_OPTIONS,
  EASY_NO_TARGET_SERVICE_ID,
  EASY_PASTE_SERVICE_ID,
  dnsPlanLabel,
  missingRecipeInputs,
  plainRecordLabel,
  previewRecords,
  serviceById,
  servicesForPlan,
} from './easyDnsPlans'
import {
  CONNECT_TARGET_STEPS,
  DNS_ACQUIRED_NOTE,
  DNS_APPLY_ACTION,
  DNS_CHECK_DONE_ACTION,
  DNS_CHECK_DONE_NOTE,
  DNS_DETAILS_NOTE,
  DNS_DETAILS_SUMMARY,
  DNS_HEADING,
  DNS_INPUT_REQUIRED_ERROR,
  DNS_LATER_HINT,
  DNS_MANUAL_LINK,
  DNS_NO_TARGET_BODY,
  DNS_NO_TARGET_DISCLOSURE,
  DNS_NO_TARGET_HEADING,
  DNS_NO_TARGET_MAIL_EXAMPLES,
  DNS_NO_TARGET_OPTION_DESCRIPTION,
  DNS_NO_TARGET_OPTION_LABEL,
  DNS_NO_TARGET_SAFE_NOTE,
  DNS_NO_TARGET_SKIP_HINT,
  DNS_NO_TARGET_WEB_EXAMPLES,
  DNS_OUTCOME_HEADING,
  DNS_OUTCOME_NOTHING_ELSE,
  DNS_OUTCOME_PASTED_SERVICE,
  DNS_NS_GUIDE_ACTION,
  DNS_NS_GUIDE_DESCRIPTION,
  DNS_NS_GUIDE_FRESH_NOTE,
  DNS_NS_GUIDE_LATER_NOTE,
  DNS_NS_GUIDE_NOTE_HEADING,
  DNS_PASTE_ADOPTED_NOTE,
  DNS_PASTE_OPEN_ACTION,
  DNS_PASTE_OPTION_DESCRIPTION,
  DNS_PASTE_OPTION_LABEL,
  DNS_PASTE_REQUIRED_ERROR,
  DNS_PLAN_ANSWER_PREFIX,
  DNS_PLAN_CHANGE_ACTION,
  DNS_PLAN_QUESTION,
  DNS_SAVED_MESSAGE,
  DNS_SAVED_WAIT_BODY,
  DNS_SAVED_WAIT_HEADING,
  DNS_SAVE_FAILED_MESSAGE,
  DNS_SERVICE_QUESTION,
  DNS_SERVICE_REQUIRED_ERROR,
  DNS_SKIP_ACTION,
  dnsOutcomeMailSentence,
  dnsOutcomeWebSentence,
} from './easyMessages'
import { defaultDnsPlanFor } from './purposeOptions'
import { EASY_DONE_PATH, type EasyDnsPlanKind } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyGate } from './useEasyGate'

/**
 * 「使いみち」として選び直せるのは実際の用途 3 つだけ。
 * 'later' は用途ではなく離脱（別ボタン）、'recommended' は既定が解決済みなので
 * ここに並べる意味がない — どちらも選択肢から外して判断を 1 つ減らす。
 */
const USAGE_PLAN_OPTIONS = EASY_DNS_PLAN_OPTIONS.filter(
  (option) => option.kind === 'web' || option.kind === 'mail' || option.kind === 'both',
)

const PLAN_ACCORDION_VALUE = 'plan'

/**
 * 保存するレコードが「どの名前を変えるのか」を、重複なく人間が読める形で返す。
 * ⚠️ ここがサービス名ではなくレコードから作られていることが重要 — レシピを
 * 足したり値を変えたりしても、確認文が実態からずれない。
 */
function affectedHostNames(records: DnsRecord[], domainName: string): string[] {
  const hosts: string[] = []
  for (const record of records) {
    const host = record.name === '@' ? domainName : `${record.name}.${domainName}`
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

function OrderProgress({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-6" role="status">
          <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </CardContent>
    </Card>
  )
}

/** 使いみちの選択肢（既定の変更と、目的が「まだ決まっていない」ときの初回選択）。 */
function UsagePlanChoices({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string
  value: string
  onChange: (next: EasyDnsPlanKind) => void
}) {
  return (
    <RadioGroup
      aria-label={DNS_PLAN_QUESTION}
      value={value}
      onValueChange={(next) => onChange(next as EasyDnsPlanKind)}
      className="space-y-3"
    >
      {USAGE_PLAN_OPTIONS.map((option) => (
        <div key={option.kind} className="flex items-start gap-3">
          <RadioGroupItem value={option.kind} id={`${idPrefix}-plan-${option.kind}`} className="mt-0.5" />
          <Label
            htmlFor={`${idPrefix}-plan-${option.kind}`}
            className="flex cursor-pointer flex-col items-start gap-0.5 font-normal"
          >
            <span className="font-medium">{option.label}</span>
            <span className="text-[13px] leading-relaxed text-muted-foreground">{option.description}</span>
          </Label>
        </div>
      ))}
    </RadioGroup>
  )
}

/**
 * 「つなぐ先がまだ無い」人への答え。
 *
 * ここが無いと、ドメインだけ買った人はどの選択肢にも当てはまらず、「あとで
 * 設定する」で追い出されるだけになる。何を用意するのか・例・順番・いま決めなく
 * ていい理由の 4 点だけを、DNS の語を使わずに置く。
 */
function NoTargetGuide() {
  return (
    <div className="space-y-3 bg-grass-1/60 p-3">
      <p className="text-sm font-medium">{DNS_NO_TARGET_HEADING}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_NO_TARGET_BODY}</p>
      <ul className="list-none space-y-1 p-0 text-[13px] leading-relaxed text-muted-foreground">
        <li>{DNS_NO_TARGET_WEB_EXAMPLES}</li>
        <li>{DNS_NO_TARGET_MAIL_EXAMPLES}</li>
      </ul>
      <ol className="list-none space-y-2 p-0">
        {CONNECT_TARGET_STEPS.map((step, index) => (
          <li key={step} className="flex items-start gap-2.5 bg-card px-3 py-2">
            <span className="flex size-5 shrink-0 items-center justify-center bg-grass-2 text-[12px] font-bold text-green-deep">
              {index + 1}
            </span>
            <span className="text-[13px] leading-relaxed">{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_NO_TARGET_SAFE_NOTE}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_NO_TARGET_SKIP_HINT}</p>
    </div>
  )
}

export function EasyDnsPage() {
  const gate = useEasyGate('dns')
  const idPrefix = useId()
  const navigate = useNavigate()
  const { session, chooseDnsPlan, chooseDnsService, setDnsInput, setStepError, stepErrors } = useEasy()
  const { order, error: orderError } = useOrderPolling(session.orderId ?? '')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /* 保存できたレコード（＝確認フェーズの入力）。null のあいだは設定フェーズ。
     「保存した」という事実はセッションに載せない（§6.2.3: 事実は保存しない）。 */
  const [savedRecords, setSavedRecords] = useState<DnsRecord[] | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pastedRecords, setPastedRecords] = useState<DnsRecord[] | null>(null)
  const [openPlan, setOpenPlan] = useState('')

  if (gate) return gate

  const domainName = session.domainName

  if (orderError === 'not-found') {
    return (
      <div className="space-y-6">
        <EasyPageHeader title={DNS_HEADING} />
        <StatusBanner tone="error">{ORDER_NOT_FOUND_MESSAGE}</StatusBanner>
        <Button asChild>
          <Link to="/">ドメイン検索へ戻る</Link>
        </Button>
      </div>
    )
  }

  if (orderError === 'unavailable') {
    return (
      <div className="space-y-6">
        <EasyPageHeader title={DNS_HEADING} />
        <StatusBanner tone="error">{ORDER_STATUS_UNAVAILABLE_MESSAGE}</StatusBanner>
      </div>
    )
  }

  if (order?.state === 'failed') {
    return (
      <div className="space-y-6">
        <EasyPageHeader title="注文状況" />
        <StatusBanner tone="error">{ORDER_FAILED_MESSAGE}</StatusBanner>
        <Card>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed">{ORDER_FAILED_NO_CHARGE_MESSAGE}</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link to={`/orders/${encodeURIComponent(session.orderId ?? '')}`}>くわしい状況を見る</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/">ドメイン検索へ戻る</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!order || order.state !== 'done') {
    return (
      <div className="space-y-6">
        <EasyPageHeader title={DNS_HEADING} lede="ドメインの登録が終わるまでお待ちください。" />
        {order?.state === 'retrying' ? (
          <StatusBanner tone="info">
            {RETRYING_MESSAGE} {NO_DOUBLE_CHARGE_MESSAGE}
          </StatusBanner>
        ) : null}
        <OrderProgress message={order ? PROVISIONING_MESSAGE : '注文状況を確認しています…'} />
      </div>
    )
  }

  /* 使いみちはステップ1の目的から決まる。セッションに明示的な選択があればそれが
     優先されるが、無くても null にはならない — 初心者に同じ質問を 2 回させない。 */
  const plan = session.dnsPlan ?? defaultDnsPlanFor(session.purpose)
  /* 目的が「まだ決まっていない」ときだけ、使いみちが未定のまま来る。 */
  const planUndecided = plan === 'later'
  const services = planUndecided ? [] : servicesForPlan(plan)
  /* 一覧に Web とメールが混ざるのは「両方に使用する」のときだけ。混ざらないなら
     種別のバッジは全件同じ語になるので出さない。 */
  const mixedCategories = new Set(services.map((service) => service.category)).size > 1
  /* 「一覧にない」は DnsRecipe ではないので serviceById では引けない (§6.3.3c)。 */
  const pasteSelected = session.dnsServiceId === EASY_PASTE_SERVICE_ID
  /* 「まだ用意していない」。レコードは 1 件も無いので保存させない。 */
  const noTargetSelected = session.dnsServiceId === EASY_NO_TARGET_SERVICE_ID
  const selectedService = session.dnsServiceId ? serviceById(session.dnsServiceId) : undefined
  const nsGuide = selectedService?.mode === 'ns-guide'
  const missing = selectedService ? missingRecipeInputs(selectedService, session.dnsInputs) : []
  /* 保存するレコード。null は「まだ保存してはいけない」の意味（ns-guide・入力未完・
     未読み取り）。空配列で saveDnsRecords を呼ぶと全置換で全消しになる。 */
  const records = pasteSelected
    ? pastedRecords
    : selectedService
      ? previewRecords(selectedService, session.dnsInputs)
      : null

  /* 確定ボタンの手前に出す「何が起きるか」。折りたたみを開かなくても必ず読める
     位置に置くため、レコードそのものから 1 行を組み立てる（固定文は持たない）。 */
  const outcomeRecords = records && records.length > 0 ? records : null
  const outcomeServiceName = selectedService?.service ?? DNS_OUTCOME_PASTED_SERVICE
  const outcomeSentence = outcomeRecords
    ? outcomeRecords.some((record) => record.type === 'MX')
      ? dnsOutcomeMailSentence(domainName, outcomeServiceName)
      : dnsOutcomeWebSentence(affectedHostNames(outcomeRecords, domainName).join(' と '), outcomeServiceName)
    : null

  const nsChangePath = `/domains/${encodeURIComponent(domainName)}/dns?mode=ns`
  const manualPath = `/domains/${encodeURIComponent(domainName)}/dns`

  function handlePlanChange(next: EasyDnsPlanKind) {
    setStepError('dns', null)
    setSaveError(null)
    setPastedRecords(null)
    chooseDnsPlan(next)
    setOpenPlan('')
  }

  function handleServiceChange(next: string) {
    setStepError('dns', null)
    setSaveError(null)
    // 別のサービスへ移ったら、前に読み取った案内文の内容は持ち越さない。
    if (next !== EASY_PASTE_SERVICE_ID) setPastedRecords(null)
    /* 既定のまま進んだ人の使いみちを、ここで初めてセッションに確定させる。
       確定させておかないと、あとで同じ使いみちを選び直したときに
       chooseDnsPlan が「変わった」と判断してサービスの選択を捨ててしまう。 */
    if (session.dnsPlan === null) chooseDnsPlan(plan)
    chooseDnsService(next)
    if (next === EASY_PASTE_SERVICE_ID) setPasteOpen(true)
  }

  function handleAdoptPasted(adopted: DnsRecord[]) {
    setPastedRecords(adopted)
    setPasteOpen(false)
    setStepError('dns', null)
  }

  /** 「あとで設定する」。DNS は書かずに完了画面へ送る（使いみちだけ記録する）。 */
  function handleSkip() {
    setStepError('dns', null)
    chooseDnsPlan('later')
    navigate(EASY_DONE_PATH, { replace: true })
  }

  async function handleApply() {
    if (planUndecided) {
      setStepError('dns', DNS_SERVICE_REQUIRED_ERROR)
      return
    }
    if (!selectedService && !pasteSelected) {
      setStepError('dns', DNS_SERVICE_REQUIRED_ERROR)
      return
    }

    // ⚠️ ns-guide と「まだ用意していない」はレコードを持たない。
    //    ボタン自体出していないが、保険で止める（空配列の保存＝全消し）。
    if (nsGuide || noTargetSelected) return
    if (records === null || records.length === 0) {
      setStepError('dns', pasteSelected ? DNS_PASTE_REQUIRED_ERROR : DNS_INPUT_REQUIRED_ERROR)
      return
    }
    if (missing.length > 0) {
      setStepError('dns', DNS_INPUT_REQUIRED_ERROR)
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      // 全置換セマンティクス（既存 dnsApi の契約）。取得直後なので既存レコードは無い。
      const result = await saveDnsRecords(domainName, records)
      setStepError('dns', null)
      // 完了画面へは飛ばさない。同じ画面で「つながったか確認する」へ移る (§6.3.3d)。
      setSavedRecords(result.records)
    } catch {
      setSaveError(DNS_SAVE_FAILED_MESSAGE)
      setStepError('dns', DNS_SAVE_FAILED_MESSAGE)
    } finally {
      setSaving(false)
    }
  }

  /* ---- フェーズ2: 確認 (§6.3.3d) ---------------------------------------
     保存直後は必ず「反映待ち」。これは正常系なので success/info の色で出し、
     赤いエラーにはしない。初心者が「壊れた」と思って設定をいじり壊す。 */
  if (savedRecords) {
    return (
      <div className="space-y-6">
        {/* ⚠️ リード文を置かない。すぐ下の成功バナー（「つなぐ設定を保存しました」）と
            その下のカード（「これで見えるようになりますか？」）が同じことを言う。 */}
        <EasyPageHeader title={DNS_HEADING} />

        <StatusBanner tone="success">{DNS_SAVED_MESSAGE}</StatusBanner>

        {/* 初心者がこの瞬間に抱く唯一の疑問（「もう見えるの？」）に先に答える。 */}
        <Card>
          <CardHeader>
            <CardTitle>{DNS_SAVED_WAIT_HEADING}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-muted-foreground">{DNS_SAVED_WAIT_BODY}</p>
          </CardContent>
        </Card>

        <DnsCheckPanel
          domainName={domainName}
          records={savedRecords}
          /* かんたんモードの注文はネームサーバーを付けずに登録する (§6.2.6) ので、
             ここへ来た時点のドメインは基本的に未委任。それでも決め打ちにせず
             注文の status を根拠にする — 「見えるはず」を画面が勝手に名乗ると、
             マイページの「まだインターネットに公開されていません」と割れる。 */
          delegation={order.domain ? delegationFromStatuses(order.domain.statuses) : 'none'}
          variant="easy"
          recordLabel={plainRecordLabel}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" onClick={() => navigate(EASY_DONE_PATH, { replace: true })}>
            {DNS_CHECK_DONE_ACTION}
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button variant="link" className="h-auto p-0 text-[13px] font-medium" asChild>
            <Link to={manualPath}>
              <Wrench aria-hidden="true" />
              {DNS_MANUAL_LINK}
              <ExternalLink aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {/* 「反映待ち」のまま完了してよい、と言い切る。言わないと進めなくなる。 */}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_CHECK_DONE_NOTE}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 注文済みなので「戻る」先は無い（手前へ戻しても再注文はさせない）ため、
          EasyStepNav ごと置かない。通常モードの DNS 画面への出口は本文の
          {DNS_MANUAL_LINK} のリンクが持つ（manualPath）。 */}
      {/* ⚠️ ここにリード文を置かない。すぐ下のカードの問いかけ（「サイトやメールは、
          どこにありますか？」）と、取得完了の帯（「あとは、つなぎ先を選ぶだけ」）が
          同じことを言うので、読む行が 1 本増えるだけになる。 */}
      <EasyPageHeader title={DNS_HEADING} />

      <StatusBanner tone="success">
        <span className="font-mono">{domainName}</span> {DNS_ACQUIRED_NOTE}
      </StatusBanner>

      {saveError || stepErrors.dns ? (
        <StatusBanner tone="error">{saveError ?? stepErrors.dns}</StatusBanner>
      ) : null}

      {planUndecided ? (
        /* 目的が「まだ決まっていない」ときだけ、ここで使いみちを聞く。 */
        <Card>
          <CardHeader>
            <CardTitle>{DNS_PLAN_QUESTION}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_LATER_HINT}</p>
            <UsagePlanChoices idPrefix={idPrefix} value="" onChange={handlePlanChange} />
            {/* 使いみちが決まらないのは、たいてい「つなぐ先がまだ無い」から。 */}
            <Accordion type="single" collapsible className="bg-grass-1/60 px-3">
              <AccordionItem value="no-target">
                <AccordionTrigger>{DNS_NO_TARGET_DISCLOSURE}</AccordionTrigger>
                <AccordionContent className="pb-4">
                  <NoTargetGuide />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{DNS_SERVICE_QUESTION}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 使いみちは目的から決まっている。答えとして読ませ、違うときだけ開く。 */}
            {/* 答え済みの 1 行。答えと「変える」を 2 段に積まず、同じ行に置く
                （この行は判断ではなく、すでに決まっていることの読み上げ）。 */}
            <Accordion
              type="single"
              collapsible
              value={openPlan}
              onValueChange={setOpenPlan}
              className="bg-grass-1/60 px-3"
            >
              <AccordionItem value={PLAN_ACCORDION_VALUE}>
                <div className="flex flex-wrap items-center justify-between gap-x-4">
                  <p className="text-[13px] leading-relaxed">
                    <span className="text-muted-foreground">{DNS_PLAN_ANSWER_PREFIX}：</span>
                    <span className="font-medium">{dnsPlanLabel(plan)}</span>
                  </p>
                  <AccordionTrigger className="w-auto flex-none py-2 text-[13px]">
                    {DNS_PLAN_CHANGE_ACTION}
                  </AccordionTrigger>
                </div>
                <AccordionContent className="pb-4">
                  <UsagePlanChoices idPrefix={idPrefix} value={plan} onChange={handlePlanChange} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* ⚠️ ここに「まだ用意していないときは…」の前置きを置かない。
                一覧の最後にその選択肢そのものが出ているので、同じことの言い換えを
                選択肢の手前で読ませることになる。 */}
            <RadioGroup
              aria-label={DNS_SERVICE_QUESTION}
              value={session.dnsServiceId ?? ''}
              onValueChange={handleServiceChange}
              className="grid gap-2 sm:grid-cols-2"
            >
              {/* ⚠️ サービス名だけを出す。以前は 1 件ずつに説明文（「◯◯ にデプロイ
                  したサイトをこのドメインで公開します。」）を付けていたが、8 件が
                  ほぼ同じ定型文で、選ぶ材料にならないまま一覧の高さを 2 倍にしていた。
                  自分が使っているサービスは名前で分かる。 */}
              {services.map((service) => (
                <Label
                  key={service.id}
                  htmlFor={`${idPrefix}-svc-${service.id}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 bg-grass-1/60 px-3 py-2.5 font-normal transition-colors',
                    session.dnsServiceId === service.id && 'bg-grass-2',
                  )}
                >
                  <RadioGroupItem value={service.id} id={`${idPrefix}-svc-${service.id}`} />
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                    {service.service}
                    {/* 種別のバッジは、一覧に 2 種類が混ざるとき（使いみち＝両方）
                        だけ意味を持つ。全件が同じ種別なら 8 回同じ語を出すだけ。 */}
                    {mixedCategories ? (
                      <Badge variant="secondary">{service.category === 'mail' ? 'メール' : 'Webサイト'}</Badge>
                    ) : null}
                  </span>
                </Label>
              ))}

              {/* §6.3.3c: 一覧にないサービスの逃げ道。ここが無いと袋小路になる。
                  ⚠️ 逃げ道の 2 択は全幅で並べる。サービスの升目に半分の幅で混ぜると
                  「9 個目のサービス」に見えてしまい、当てはまる人が見つけられない。 */}
              <div
                className={cn(
                  'flex items-start gap-3 bg-grass-1/60 p-3 transition-colors sm:col-span-2',
                  pasteSelected && 'bg-grass-2',
                )}
              >
                <RadioGroupItem
                  value={EASY_PASTE_SERVICE_ID}
                  id={`${idPrefix}-svc-${EASY_PASTE_SERVICE_ID}`}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`${idPrefix}-svc-${EASY_PASTE_SERVICE_ID}`}
                  className="flex min-w-0 cursor-pointer flex-col items-start gap-0.5 font-normal"
                >
                  <span className="font-medium">{DNS_PASTE_OPTION_LABEL}</span>
                  <span className="text-[13px] leading-relaxed text-muted-foreground">
                    {DNS_PASTE_OPTION_DESCRIPTION}
                  </span>
                </Label>
              </div>

              {/* つなぐ先がまだ無い人の居場所。ここが無いと選択肢に当てはまらない。 */}
              <div
                className={cn(
                  'flex items-start gap-3 bg-grass-1/60 p-3 transition-colors sm:col-span-2',
                  noTargetSelected && 'bg-grass-2',
                )}
              >
                <RadioGroupItem
                  value={EASY_NO_TARGET_SERVICE_ID}
                  id={`${idPrefix}-svc-${EASY_NO_TARGET_SERVICE_ID}`}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`${idPrefix}-svc-${EASY_NO_TARGET_SERVICE_ID}`}
                  className="flex min-w-0 cursor-pointer flex-col items-start gap-0.5 font-normal"
                >
                  <span className="font-medium">{DNS_NO_TARGET_OPTION_LABEL}</span>
                  <span className="text-[13px] leading-relaxed text-muted-foreground">
                    {DNS_NO_TARGET_OPTION_DESCRIPTION}
                  </span>
                </Label>
              </div>
            </RadioGroup>

            {/* ⚠️ レコードは作らない。案内だけを出し、保存ボタンは下で隠す。 */}
            {noTargetSelected ? <NoTargetGuide /> : null}

            {/* ⚠️ ns-guide はレコードを保存しない (§6.3.3e)。案内と警告だけを出す。 */}
            {nsGuide && selectedService ? (
              <div className="space-y-3 bg-grass-1/60 p-3">
                <p className="text-sm font-medium">{DNS_NS_GUIDE_NOTE_HEADING}</p>
                <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_NS_GUIDE_DESCRIPTION}</p>
                {selectedService.nsGuideNote ? (
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {selectedService.nsGuideNote}
                  </p>
                ) : null}
                {/* ⚠️ NS_CHANGE_WARNING は通常モードと共有の正文なので書き換えない。
                    ただしこの場面では「まだ止まるものが無い」ので、赤い error では
                    なく info で出し、事実の一文を必ず添える（追記であって改変ではない）。 */}
                <StatusBanner tone="info">
                  <p>{NS_CHANGE_WARNING}</p>
                  <p>{DNS_NS_GUIDE_FRESH_NOTE}</p>
                </StatusBanner>
                {/* 出口を 1 本にしない。ここで「あとで」を出さないと、ウィザードは
                    6/6 で捨てられ、完了画面（ステップ7）に誰も到達しない。 */}
                <div className="flex flex-wrap items-center gap-3">
                  <Button asChild>
                    <Link to={nsChangePath}>
                      {DNS_NS_GUIDE_ACTION}
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                  <Button type="button" variant="outline" onClick={handleSkip}>
                    {DNS_SKIP_ACTION}
                  </Button>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_NS_GUIDE_LATER_NOTE}</p>
              </div>
            ) : null}

            {pasteSelected ? (
              <div className="space-y-3 bg-muted/40 p-3">
                <Button type="button" variant="outline" onClick={() => setPasteOpen(true)}>
                  <ClipboardPaste aria-hidden="true" />
                  {DNS_PASTE_OPEN_ACTION}
                </Button>
                {pastedRecords && pastedRecords.length > 0 ? (
                  <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_PASTE_ADOPTED_NOTE}</p>
                ) : null}
              </div>
            ) : null}

            {!nsGuide && selectedService?.inputs?.length ? (
              <div className="space-y-4 bg-muted/40 p-3">
                {selectedService.inputs.map((input) => (
                  <Field
                    key={input.key}
                    label={input.label}
                    controlId={`${idPrefix}-input-${input.key}`}
                    hint={input.help}
                    error={missing.includes(input.key) && stepErrors.dns ? DNS_INPUT_REQUIRED_ERROR : undefined}
                  >
                    {({ controlId, describedBy }) => (
                      <Input
                        id={controlId}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={input.placeholder}
                        aria-describedby={describedBy}
                        value={session.dnsInputs[input.key] ?? ''}
                        onChange={(event) => setDnsInput(input.key, event.target.value)}
                      />
                    )}
                  </Field>
                ))}
              </div>
            ) : null}

            {/* 専門用語は「詳細を見る」の中だけ。開かなければ A/CNAME/MX は出てこない。
                つなぎ先が無い／NSごと預けるときは、書き込む設定自体が無いので出さない。 */}
            {/* ⚠️ つなぎ先を選ぶ前は出さない。まだ何も書き込まれないのに
                「詳細を見る（書き込まれる設定）」が置いてあると、開いた人は
                「上の項目を入力すると…」という答えにならない答えを読むことになる。 */}
            {nsGuide || noTargetSelected || (!selectedService && !pasteSelected) ? null : (
              <Accordion type="single" collapsible className="bg-grass-1/60 px-3">
                <AccordionItem value="records">
                  <AccordionTrigger>{DNS_DETAILS_SUMMARY}</AccordionTrigger>
                  <AccordionContent className="space-y-3">
                    <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_DETAILS_NOTE}</p>
                    {records === null ? (
                      <p className="text-[13px] text-muted-foreground">
                        上の項目を入力すると、書き込まれる内容がここに表示されます。
                      </p>
                    ) : (
                      <ul className="list-none space-y-2 p-0">
                        {records.map((record, index) => (
                          <li
                            key={`${record.type}-${record.name}-${record.value}-${index}`}
                            className="bg-card px-3 py-2"
                          >
                            <p className="text-[13px] font-medium">{plainRecordLabel(record.type)}</p>
                            <p className="font-mono text-[12.5px] break-all text-muted-foreground">
                              {record.name} → {record.value}
                              {record.priority !== undefined ? `（優先度 ${record.priority}）` : ''}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </CardContent>
        </Card>
      )}

      {/* 主要ボタンは常に 1 つ。「あとで設定する」は用途の選択肢ではなく離脱操作
          なので、ラジオではなくボタンとして常に押せる場所に置く。 */}
      {/* ⚠️ 折りたたみ（詳細を見る）だけに置いてはいけない。入力欄を持たない
          サービスでは、選んでも画面が何も変わらないまま確定させることになる。 */}
      {nsGuide || noTargetSelected || !outcomeSentence ? null : (
        <div className="space-y-1 bg-grass-1/60 px-3 py-2.5">
          <p className="text-sm font-medium">{DNS_OUTCOME_HEADING}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{outcomeSentence}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_OUTCOME_NOTHING_ELSE}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {nsGuide || planUndecided || noTargetSelected ? null : (
          /* まだ何も選んでいない状態で押せると、返ってくるのは赤い注意だけ。
             すぐ上のラジオが未回答なのは見て分かるので、押せなくしておく。 */
          <Button
            type="button"
            size="lg"
            onClick={() => void handleApply()}
            disabled={saving || (!selectedService && !pasteSelected)}
          >
            {saving ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                処理中…
              </>
            ) : (
              DNS_APPLY_ACTION
            )}
          </Button>
        )}
        {/* ns-guide のときは案内の中に置いてある（同じボタンを 2 つ出さない）。 */}
        {nsGuide ? null : (
          <Button type="button" variant="outline" onClick={handleSkip}>
            {DNS_SKIP_ACTION}
          </Button>
        )}
        <Button variant="link" className="h-auto p-0 text-[13px] font-medium" asChild>
          <Link to={manualPath}>
            <Wrench aria-hidden="true" />
            {DNS_MANUAL_LINK}
            <ExternalLink aria-hidden="true" />
          </Link>
        </Button>
      </div>

      {/* 既存の貼り付けパーサをそのまま再利用する（parseDnsPaste は複製しない）。 */}
      <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} onAdopt={handleAdoptPasted} />
    </div>
  )
}
