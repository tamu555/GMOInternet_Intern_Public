/**
 * Granular field components for the application form (FIG.1 右半分).
 *
 * Split one-component-per-§6.2.6-row on purpose (spec §1.2 マスク方式): the
 * future easy-mode wizard hides a field by NOT RENDERING its component while
 * the form state keeps its default value - never by display:none, and never
 * by dropping the value from the payload. Each component here is therefore
 * independently omittable; none of them owns state.
 */
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AuthUser } from '../../auth/authTypes'
import { Field } from '../../components/Field'
import { REGISTRATION_YEAR_OPTIONS } from './orderDefaults'
import { AUTH_INFO_MAX_LENGTH, type NameserverMode } from './orderFormModel'

/**
 * Native <select> kept on purpose: tests read it via getByLabelText(...).toHaveValue().
 * Styled to match shadcn <Input>, with the default chevron replaced by lucide.
 */
const SELECT_CLASS =
  'h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm'

/**
 * Native checkbox/radio kept on purpose: Radix Checkbox/RadioGroup depend on
 * ResizeObserver, which the jsdom test environment does not provide. The
 * native controls are restyled with accent-primary instead.
 */
const CHECK_CLASS = 'mt-0.5 size-4 shrink-0 accent-primary'

function SelectChevron() {
  return (
    <ChevronDown
      className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    />
  )
}

export function RegistrationYearsField({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string
  value: number
  onChange: (years: number) => void
  disabled?: boolean
}) {
  return (
    <Field label="登録期間" controlId={`${idPrefix}-years`}>
      {({ controlId, describedBy }) => (
        <div className="relative">
          <select
            id={controlId}
            className={SELECT_CLASS}
            aria-describedby={describedBy}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(Number(event.target.value))}
          >
            {REGISTRATION_YEAR_OPTIONS.map((years) => (
              <option key={years} value={years}>
                {years}年
              </option>
            ))}
          </select>
          <SelectChevron />
        </div>
      )}
    </Field>
  )
}

export function AutoRenewField({
  idPrefix,
  checked,
  onChange,
  disabled,
}: {
  idPrefix: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={`${idPrefix}-auto-renew`}
        className={CHECK_CLASS}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <Label htmlFor={`${idPrefix}-auto-renew`} className="font-normal leading-snug">
        自動更新（期限が近づくと自動で1年ずつ更新します）
      </Label>
    </div>
  )
}

export function NameserverSection({
  idPrefix,
  mode,
  onModeChange,
  customNameservers,
  onCustomNameserverChange,
  error,
  disabled,
}: {
  idPrefix: string
  mode: NameserverMode
  onModeChange: (mode: NameserverMode) => void
  customNameservers: [string, string]
  onCustomNameserverChange: (index: 0 | 1, value: string) => void
  error?: string
  disabled?: boolean
}) {
  const errorId = error ? `${idPrefix}-ns-error` : undefined
  return (
    <fieldset className="space-y-3" aria-describedby={errorId}>
      <legend className="text-sm leading-none font-medium">
        ネームサーバ（どのDNSに任せるかの指定）
      </legend>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <input
            id={`${idPrefix}-ns-none`}
            className={CHECK_CLASS}
            type="radio"
            name={`${idPrefix}-ns-mode`}
            checked={mode === 'none'}
            disabled={disabled}
            onChange={() => onModeChange('none')}
          />
          <Label htmlFor={`${idPrefix}-ns-none`} className="font-normal leading-snug">
            いまは設定しない（おすすめ：取得後にDNS設定画面から設定できます）
          </Label>
        </div>
        <div className="flex items-start gap-3">
          <input
            id={`${idPrefix}-ns-custom`}
            className={CHECK_CLASS}
            type="radio"
            name={`${idPrefix}-ns-mode`}
            checked={mode === 'custom'}
            disabled={disabled}
            onChange={() => onModeChange('custom')}
          />
          <Label htmlFor={`${idPrefix}-ns-custom`} className="font-normal leading-snug">
            他社のネームサーバを指定する
          </Label>
        </div>
      </div>

      {mode === 'custom' ? (
        <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-3">
          {([0, 1] as const).map((index) => (
            <Field
              key={index}
              label={`ネームサーバ${index + 1}${index === 0 ? '' : '（任意）'}`}
              controlId={`${idPrefix}-ns-${index + 1}`}
            >
              {({ controlId, describedBy }) => (
                <Input
                  id={controlId}
                  type="text"
                  placeholder={`ns${index + 1}.example.com`}
                  aria-describedby={[describedBy, errorId].filter(Boolean).join(' ') || undefined}
                  value={customNameservers[index]}
                  disabled={disabled}
                  onChange={(event) => onCustomNameserverChange(index, event.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="text-[13px] font-medium text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

export function AuthInfoField({
  idPrefix,
  value,
  onChange,
  onRegenerate,
  error,
  disabled,
}: {
  idPrefix: string
  value: string
  onChange: (value: string) => void
  onRegenerate: () => void
  error?: string
  disabled?: boolean
}) {
  return (
    <Field
      label="認証コード（authInfo）"
      controlId={`${idPrefix}-auth-info`}
      hint={`他社への移管（引っ越し）時に使うパスフレーズです。1〜${AUTH_INFO_MAX_LENGTH}文字。自動生成された値のままで問題ありません。`}
      error={error}
    >
      {({ controlId, describedBy }) => (
        <div className="flex flex-wrap gap-2">
          <Input
            id={controlId}
            className="flex-1 basis-52 font-mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button type="button" variant="outline" onClick={onRegenerate} disabled={disabled}>
            自動生成し直す
          </Button>
        </div>
      )}
    </Field>
  )
}

/**
 * registrant is always the member's own contact (spec §5.1: one contact per
 * member, reused across every domain), so it renders as a read-only card.
 * admin / tech / billing default to "same as registrant" (§6.2.6).
 */
export function ContactRolesSection({
  idPrefix,
  user,
  sameAsRegistrant,
  onSameAsRegistrantChange,
  disabled,
}: {
  idPrefix: string
  user: AuthUser
  sameAsRegistrant: boolean
  onSameAsRegistrantChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <span className="block text-sm leading-none font-medium">登録者（registrant）</span>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          会員のコンタクト情報を自動で使用します（会員1人につきコンタクトは1つです）。
        </p>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <span className="text-sm font-medium">{user.displayName}</span>
          <span className="text-sm text-muted-foreground">{user.email}</span>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <input
            id={`${idPrefix}-contacts-same`}
            className={CHECK_CLASS}
            type="checkbox"
            checked={sameAsRegistrant}
            disabled={disabled}
            onChange={(event) => onSameAsRegistrantChange(event.target.checked)}
          />
          <Label htmlFor={`${idPrefix}-contacts-same`} className="font-normal leading-snug">
            admin・tech・billing に登録者と同じコンタクトを使用する（推奨）
          </Label>
        </div>
        {sameAsRegistrant ? null : (
          <ul className="space-y-2">
            {(['admin', 'tech', 'billing'] as const).map((role) => (
              <li key={role} className="flex items-center gap-3">
                <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{role}</span>
                <div className="relative flex-1">
                  <select
                    className={SELECT_CLASS}
                    value="member-contact"
                    disabled={disabled}
                    onChange={() => undefined}
                  >
                    <option value="member-contact">
                      {user.displayName}（{user.email}）
                    </option>
                  </select>
                  <SelectChevron />
                </div>
              </li>
            ))}
          </ul>
        )}
        {sameAsRegistrant ? null : (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            現在選択できるコンタクトは会員本人の1件のみです（§5.1）。
          </p>
        )}
      </div>
    </div>
  )
}
