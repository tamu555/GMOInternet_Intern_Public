/**
 * ステップ2の検索窓。検索フォーム（/easy/name）と検索結果（/easy/name/results）が
 * **同じ部品を同じ位置に**置く。
 *
 * 2 画面で見た目も位置も揃えているのが要で、これがあるおかげで「検索する」を
 * 押した瞬間の切り替わりが「別のページへ飛ばされた」ではなく「結果が出た」と
 * 読める（結果の画面からの再検索も、フォームへ戻らずその場でできる）。
 *
 * この部品が持つのは入力中の値と形式チェックだけ。検索の実行（候補の生成と
 * 画面遷移）は呼び出し側のページが持つ — 何が起きるかはページごとに違うので、
 * ここに navigate を書くと 2 つの画面の事情がこのファイルに漏れる。
 */
import { useId, useState, type FormEvent } from 'react'
import { Loader2, Search } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { normalizeDomainLabel, validateDomainLabel } from '../domains/validation'
import {
  NAME_JARGON_NOTE,
  NAME_OWN_INPUT_LABEL,
  SEARCH_CONDITIONS_SUMMARY,
  SEARCH_NOTE_LABEL,
  SEARCH_NOTE_PLACEHOLDER,
} from './easyMessages'

export function EasySearchForm({
  defaultLabel,
  defaultNote,
  submitLabel,
  busy = false,
  /** 「ラベル」の用語補足を出すか（§1.4 の併記は 1 度だけでよいので検索の画面だけ）。 */
  showJargonNote = false,
  onSearch,
}: {
  defaultLabel: string
  defaultNote: string
  submitLabel: string
  busy?: boolean
  showJargonNote?: boolean
  onSearch: (label: string, note: string) => void
}) {
  const idPrefix = useId()
  const [label, setLabel] = useState(defaultLabel)
  const [note, setNote] = useState(defaultNote)
  const [error, setError] = useState<string | undefined>(undefined)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = normalizeDomainLabel(label)
    setLabel(normalized)

    // 空のままでも探せる（目的から候補を作る）。入っているときだけ形式を見る。
    if (normalized === '') {
      setError(undefined)
      onSearch('', note)
      return
    }
    const validation = validateDomainLabel(normalized)
    setError(validation)
    if (validation) return
    onSearch(normalized, note)
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* トップページの検索窓と同じ形（入力＋ボタンを 1 つの箱に）。 */}
      <div>
        <label htmlFor={`${idPrefix}-own`} className="sr-only">
          {NAME_OWN_INPUT_LABEL}
        </label>
        <div className="flex flex-wrap gap-1.5 rounded-lg bg-card p-1.5 shadow-soft sm:flex-nowrap">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3">
            <Search className="size-5 shrink-0 text-grass" aria-hidden="true" />
            <Input
              id={`${idPrefix}-own`}
              className="h-12 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 font-mono text-base focus-visible:border-0 focus-visible:ring-0 md:text-base"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="my-bakery"
              aria-describedby={error ? `${idPrefix}-own-error` : undefined}
              aria-invalid={error ? true : undefined}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onBlur={() => setLabel(normalizeDomainLabel(label))}
            />
          </div>
          <Button
            type="submit"
            size="lg"
            className="h-12 w-full shrink-0 rounded-md px-6 sm:w-auto"
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Search aria-hidden="true" />
            )}
            {submitLabel}
          </Button>
        </div>
        {error ? (
          <p id={`${idPrefix}-own-error`} role="alert" className="mt-2 text-[13px] font-medium text-destructive">
            {error}
          </p>
        ) : null}
        {/* §1.4: 平易な言い換えのあとに、専門用語も 1 度だけ渡しておく。
            入力欄が「何を入れる欄なのか」の説明なので、見出しの下ではなく
            欄の直下に置く（読む文が見出しの下に 2 本積まれるのを避ける）。 */}
        {showJargonNote ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{NAME_JARGON_NOTE}</p>
        ) : null}
      </div>

      {/* 細かい条件は初期表示では畳んでおく（開けば今までどおり入力できる）。 */}
      <Accordion
        type="single"
        collapsible
        defaultValue={defaultNote ? 'conditions' : undefined}
        className="bg-grass-1/60 px-3"
      >
        <AccordionItem value="conditions">
          <AccordionTrigger>{SEARCH_CONDITIONS_SUMMARY}</AccordionTrigger>
          <AccordionContent className="space-y-2 pb-4">
            <Label htmlFor={`${idPrefix}-note`}>{SEARCH_NOTE_LABEL}</Label>
            <Textarea
              id={`${idPrefix}-note`}
              placeholder={SEARCH_NOTE_PLACEHOLDER}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </form>
  )
}
