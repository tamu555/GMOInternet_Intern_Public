/**
 * ステップ1: 目的の選択（/easy/goal）。
 *
 * この画面でユーザーに求める判断は「何に使うか」の 1 つだけ。
 *   - 最初に見せる選択肢は 3 つ（残りは「ほかの目的から選ぶ」の中）
 *   - 目的の自由入力は検索画面（/easy/name）の「くわしい条件を指定する」へ移した。
 *     ここで一緒に聞くと 1 画面に 2 つの判断が並んでしまうため。
 *   - 選択肢より前に置く文はリード文の 1 本だけ。
 *
 * ここは「かんたん」を名乗るフローの 1 枚目なので、見出し・選択肢・次へが
 * 1 画面に収まる高さに保つ（選択肢の行は 1 行 1 択の高さまで詰める）。
 * ここで選んだ目的は、名前の候補・末尾の並び・ステップ6の使いみちの既定値を
 * すべて決める。だから「あとで聞かれない」ことをリード文で先に約束しておく。
 *
 * ⚠️ 選択肢の前後に説明文を足さない（2026-08-28 に、料金・ログインの予告と
 * 「取っただけでは表示されない」の 2 本を削除した）。1 枚目でまだ何も選んで
 * いない人にとって、読む文が増えることそのものが離脱の理由になる。
 */
import { useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { StatusBanner } from '../../components/StatusBanner'
import { EasyPageHeader, EasyStepActions, EasyStepNav } from './EasyStepActions'
import {
  GOAL_HEADING,
  GOAL_LEDE,
  ACTION_BACK_TO_CONFIRM,
  GOAL_MORE_ACTION,
  GOAL_POPULAR_BADGE,
  GOAL_REQUIRED_ERROR,
  RESUME_BANNER,
} from './easyMessages'
import { EASY_PURPOSE_OPTIONS, EASY_PURPOSE_PRIMARY_COUNT, type EasyPurposeOption } from './purposeOptions'
import { easyStepDef, type EasyPurposeKind } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyReturn } from './useEasyReturn'

const PRIMARY_OPTIONS = EASY_PURPOSE_OPTIONS.slice(0, EASY_PURPOSE_PRIMARY_COUNT)
const MORE_OPTIONS = EASY_PURPOSE_OPTIONS.slice(EASY_PURPOSE_PRIMARY_COUNT)

/** 選択肢 1 件。RadioGroup の外に置いて、再レンダーで作り直されないようにする。 */
function PurposeOptionRow({
  option,
  controlId,
  selected,
  popular = false,
}: {
  option: EasyPurposeOption
  controlId: string
  selected: boolean
  popular?: boolean
}) {
  const Icon = option.icon
  return (
    <div
      className={cn(
        'flex items-center gap-3 bg-card px-4 py-3 shadow-soft transition-colors',
        selected && 'bg-grass-1',
      )}
    >
      <RadioGroupItem value={option.kind} id={controlId} />
      <Label
        htmlFor={controlId}
        className="min-w-0 flex-1 cursor-pointer flex-col items-stretch gap-0.5 py-1"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-bold">
          <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          {option.label}
          {popular ? <Badge variant="secondary">{GOAL_POPULAR_BADGE}</Badge> : null}
        </span>
        {/* §1.4「用語は消さず併記」: 何を選ぼうとしているかを 1 行で補う。 */}
        <span className="text-[12.5px] leading-relaxed font-normal text-muted-foreground">
          {option.description}
        </span>
      </Label>
    </div>
  )
}

export function EasyGoalPage() {
  const idPrefix = useId()
  const navigate = useNavigate()
  const { session, choosePurpose, setStepError, stepErrors } = useEasy()
  /* 確認画面の「変更」から来たか。来ていれば、選び直したあとは確認画面へ直帰する
     （使いみちは名前や末尾の空き状況に影響しないので、寄り道させる理由がない）。 */
  const returnTo = useEasyReturn()

  const [purpose, setPurpose] = useState<EasyPurposeKind | null>(session.purpose)
  /* エラーは選択肢の上に出るが「次へ」は最下部にある。モバイルでは押しても
     画面が変わらないように見えるので、出したエラーまで視界を運ぶ。 */
  const errorRef = useRef<HTMLDivElement>(null)

  const resuming = session.label !== '' || session.tld !== ''
  /* 畳んだ側に保存済みの目的があるなら開いた状態で描く（選択が見えないまま
     「選び直してください」と言われる状態を作らない）。 */
  const startExpanded = MORE_OPTIONS.some((option) => option.kind === session.purpose)

  function handleNext() {
    if (!purpose) {
      setStepError('goal', GOAL_REQUIRED_ERROR)
      // バナーは次の描画で初めて存在するので 1 フレーム待つ。jsdom には
      // scrollIntoView が無いのでオプショナル呼び出しにしてある。
      requestAnimationFrame(() => {
        errorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      })
      return
    }
    setStepError('goal', null)
    choosePurpose(purpose, session.purposeNote)
    navigate(easyStepDef(returnTo ?? 'name').path)
  }

  return (
    <div className="space-y-5">
      {/* 1 ステップ目には本来「戻る」先が無いが、確認画面から修正しに来た人には
          「やっぱりやめる」戻り先がある。そのときだけ戻る導線を出す。 */}
      <EasyStepNav backTo={returnTo ? easyStepDef(returnTo).path : undefined} />

      <EasyPageHeader title={GOAL_HEADING} lede={GOAL_LEDE} />

      {resuming ? <StatusBanner tone="info">{RESUME_BANNER}</StatusBanner> : null}
      {stepErrors.goal ? (
        <div ref={errorRef}>
          <StatusBanner tone="error">{stepErrors.goal}</StatusBanner>
        </div>
      ) : null}

      <RadioGroup
        aria-label={GOAL_HEADING}
        value={purpose ?? ''}
        onValueChange={(value) => {
          setPurpose(value as EasyPurposeKind)
          setStepError('goal', null)
        }}
        className="gap-2"
      >
        {PRIMARY_OPTIONS.map((option, index) => (
          <PurposeOptionRow
            key={option.kind}
            option={option}
            controlId={`${idPrefix}-${option.kind}`}
            selected={purpose === option.kind}
            popular={index === 0}
          />
        ))}

        {/* 優先度の低い 3 件は畳む。消したのではなく、開けば同じ形で選べる。 */}
        <Accordion
          type="single"
          collapsible
          defaultValue={startExpanded ? 'more' : undefined}
          className="bg-grass-1/60 px-3"
        >
          <AccordionItem value="more">
            <AccordionTrigger className="py-3">{GOAL_MORE_ACTION}</AccordionTrigger>
            <AccordionContent className="grid gap-2 pb-3">
              {MORE_OPTIONS.map((option) => (
                <PurposeOptionRow
                  key={option.kind}
                  option={option}
                  controlId={`${idPrefix}-${option.kind}`}
                  selected={purpose === option.kind}
                />
              ))}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </RadioGroup>

      <EasyStepActions onNext={handleNext} nextLabel={returnTo ? ACTION_BACK_TO_CONFIRM : undefined} />
    </div>
  )
}
