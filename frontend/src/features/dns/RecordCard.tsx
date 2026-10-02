/**
 * レコード1件の入力カード。表形式をやめてカードにしているのは、
 * 「種別 → 何ができるか → 何を入れるか」を上から順に読ませたいから
 * （表は列見出しを何度も往復させるので、DNSを知らない人には読めない）。
 *
 * 画面上の情報量を減らすため、TTL は既定で畳み、優先度は MX のときだけ出す。
 * ラベルは用語ツールチップ側に持たせ、入力欄自体は aria-label で名前を持つ
 * （テストが getByLabelText('値') で引くのと同じ経路）。
 */
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { RecordFieldErrors } from './dnsValidation'
import {
  ADVANCED_RECORD_TYPES,
  COMMON_RECORD_TYPES,
  DNS_TYPE_GUIDES,
  displayHost,
} from './dnsGuide'
import type { DnsRecordType } from './dnsRecordTypes'
import type { DraftRow } from './draftRows'
import { TermTooltip } from './TermTooltip'

const INPUT_CLASS =
  'h-10 w-full rounded-md border border-input bg-card px-3 font-mono text-[13px] placeholder:text-ink-hint'

const FIELD_LABEL_CLASS = 'text-[13px] font-semibold text-foreground'

function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-1 text-xs font-semibold text-destructive">
      {message}
    </p>
  )
}

function typeOptionLabel(type: DnsRecordType): string {
  return `${type} — ${DNS_TYPE_GUIDES[type].purpose}`
}

export function RecordCard({
  index,
  row,
  domainName,
  errors,
  disabled,
  onPatch,
  onTouch,
  onRemove,
}: {
  index: number
  row: DraftRow
  domainName: string
  /** すでに「見せてよい」ものだけに絞られたエラー（触れる前は出さない）。 */
  errors: RecordFieldErrors
  disabled: boolean
  onPatch: (patch: Partial<DraftRow>) => void
  onTouch: (field: keyof RecordFieldErrors) => void
  onRemove: () => void
}) {
  const guide = DNS_TYPE_GUIDES[row.type]
  const [ttlOpen, setTtlOpen] = useState(row.ttl.trim() !== '')

  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold text-muted-foreground">レコード {index + 1}</p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="行を削除"
          className="-mt-1.5 -mr-1.5 size-8"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="mt-1.5 flex flex-col gap-1.5">
        <span className={FIELD_LABEL_CLASS}>このレコードで何をしますか？</span>
        {/* jsdomテストとキーボード操作を優先してネイティブ select
            （NameserverDialog の raw input と同じ割り切り）。 */}
        <select
          aria-label="種別"
          className="h-10 w-full rounded-md border border-input bg-card px-2.5 text-[13px]"
          value={row.type}
          disabled={disabled}
          onChange={(event) => {
            const nextType = event.target.value as DnsRecordType
            onTouch('type')
            onPatch({
              type: nextType,
              // MX 以外に優先度は無い — 種別を離れたら消す。
              ...(nextType !== 'MX' ? { priority: '' } : {}),
            })
          }}
        >
          <optgroup label="よく使う設定">
            {COMMON_RECORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeOptionLabel(type)}
              </option>
            ))}
          </optgroup>
          <optgroup label="くわしい人向け">
            {ADVANCED_RECORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeOptionLabel(type)}
              </option>
            ))}
          </optgroup>
        </select>
        {errors.type ? <FieldError message={errors.type} /> : null}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{guide.summary}</p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <TermTooltip term="recordName" className={FIELD_LABEL_CLASS} />
          <input
            aria-label="名前"
            type="text"
            className={cn(INPUT_CLASS, 'mt-1.5', errors.name && 'border-destructive')}
            placeholder="@（空欄ならドメインそのもの）"
            value={row.name}
            disabled={disabled}
            onChange={(event) => onPatch({ name: event.target.value })}
            onBlur={() => onTouch('name')}
          />
          {errors.name ? (
            <FieldError message={errors.name} />
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              設定されるアドレス:{' '}
              <span className="font-mono font-semibold text-foreground">
                {displayHost(row.name, domainName)}
              </span>
              <span className="mt-0.5 block">{guide.nameHint}</span>
            </p>
          )}
        </div>

        <div>
          <TermTooltip term="recordValue" className={FIELD_LABEL_CLASS} />
          <input
            aria-label="値"
            type="text"
            className={cn(INPUT_CLASS, 'mt-1.5', errors.value && 'border-destructive')}
            placeholder={guide.valuePlaceholder}
            value={row.value}
            disabled={disabled}
            onChange={(event) => onPatch({ value: event.target.value })}
            onBlur={() => onTouch('value')}
          />
          {errors.value ? (
            <FieldError message={errors.value} />
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {guide.valueLabel}を入力します。
              <span className="mt-0.5 block">
                例: <span className="font-mono">{guide.valuePlaceholder}</span>
              </span>
            </p>
          )}
        </div>
      </div>

      {row.type === 'MX' ? (
        <div className="mt-4 sm:max-w-[16rem]">
          <TermTooltip term="priority" className={FIELD_LABEL_CLASS} />
          <input
            aria-label="優先度"
            type="text"
            inputMode="numeric"
            className={cn(INPUT_CLASS, 'mt-1.5', errors.priority && 'border-destructive')}
            placeholder="10"
            value={row.priority}
            disabled={disabled}
            onChange={(event) => onPatch({ priority: event.target.value })}
            onBlur={() => onTouch('priority')}
          />
          {errors.priority ? (
            <FieldError message={errors.priority} />
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              指定がなければ 10 と入力してください。
            </p>
          )}
        </div>
      ) : null}

      {/* TTL は初期表示から外す（§ 必要な項目だけ見せる）。値が入っている行は開いた状態で始まる。 */}
      <div className="mt-3">
        <button
          type="button"
          aria-expanded={ttlOpen}
          className="inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setTtlOpen((open) => !open)}
        >
          {ttlOpen ? (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5" />
          )}
          詳しい設定（TTL）
        </button>
        {ttlOpen ? (
          <div className="mt-2 sm:max-w-[16rem]">
            <TermTooltip term="ttl" className={FIELD_LABEL_CLASS}>
              TTL（秒）
            </TermTooltip>
            <input
              aria-label="TTL（秒）"
              type="text"
              inputMode="numeric"
              className={cn(INPUT_CLASS, 'mt-1.5', errors.ttl && 'border-destructive')}
              placeholder="3600"
              value={row.ttl}
              disabled={disabled}
              onChange={(event) => onPatch({ ttl: event.target.value })}
              onBlur={() => onTouch('ttl')}
            />
            {errors.ttl ? (
              <FieldError message={errors.ttl} />
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">空欄のままで問題ありません。</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
