import { useState, type ComponentProps, type ReactNode } from 'react'
import { Field } from '../../components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * パスワード入力＋表示/非表示の切り替えボタン。ラベルや誤り表示は持たない
 * 「入力欄そのもの」なので、`Field` で組む画面（ログイン）からも
 * react-hook-form の `FormControl` で組む画面（会員登録）からも同じものを使える。
 *
 * 切り替えは必ず往復できること。押すたびに
 *   input[type]  password ⇄ text
 *   アイコン      斜線あり ⇄ 斜線なし
 *   aria-label   表示 ⇄ 隠す
 *   aria-pressed false ⇄ true
 * の4つが揃って反転する。アイコンだけが変わって「戻せるボタン」に見えない、
 * という状態を作らないために、ホバーとフォーカスでは必ず面を出す
 * （ghost のままだと押せる場所だと分からず、一方通行の操作に見える）。
 *
 * このボタンは動かない。押した瞬間に図形が動くと、目を凝らして入力している
 * ときほど気が散るためで、そのために3つ止めてある:
 *   - lucide の Eye ⇄ EyeOff を使わない（後述の EyeGlyph を参照）
 *   - Button 基底の `active:translate-y-px`（押し込みで1px下がる）を戻す
 *   - `transition-all` を切り、面の出入りを補間ではなく即時にする
 * 状態は斜線が担うので、`aria-pressed` で背景を反転させることもしない。
 *
 * `FormControl` は Slot で子に id / aria-describedby / aria-invalid を流し込む。
 * ここで受けた props はすべて内側の <input> にそのまま渡すので、どちらの
 * 組み方でも説明文と誤りメッセージの読み上げが繋がる。
 */
/**
 * 目のアイコン。伏せているあいだだけ斜線が1本増える。
 *
 * lucide の EyeOff は「Eye に線を足したもの」ではなく、輪郭を隙間の空いた2本の
 * 弧に、瞳を部分弧に描き直した別のグリフである。そのため Eye ⇄ EyeOff を差し
 * 替えると図形全体が描き替わり、ボタンが動いたように見える。ここでは目の形を
 * 両状態で完全に同一にし（lucide v1.34.0 の `eye` の path をそのまま持ってきて
 * いる）、差分を斜線1本だけに閉じ込めている。
 */
function EyeGlyph({ slashed }: { slashed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
      {slashed ? <path d="m3 3 18 18" /> : null}
    </svg>
  )
}

export function PasswordInput({ className, disabled, ...props }: ComponentProps<typeof Input>) {
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="relative">
      <Input
        {...props}
        disabled={disabled}
        /* type は常に revealed から導く。呼び出し側から type を渡されても
           上書きする（渡された type="password" が固定されると戻せなくなる）。 */
        type={revealed ? 'text' : 'password'}
        className={cn('pr-10', className)}
      />
      {/* 中央寄せは flex で行う。以前は `top-1/2 -translate-y-1/2` だったが、
          Button 基底の `active:translate-y-px` が同じ `--tw-translate-y` を
          上書きするため、押しているあいだだけ中央寄せの -50% が消えて、
          ボタンがボタン1つ分ほど下へ落ちていた。transform を配置に使わなければ
          そもそも奪われない。 */}
      <span className="absolute inset-y-0 right-1 flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          /* `translate-y-0!` は基底の押し込み1pxを打ち消すため。important が要る
             のは、同じ active: 変種の同じユーティリティ同士で、どちらが後に
             出力されるかがクラスの記述順では決まらないから。 */
          className="text-muted-foreground transition-none hover:bg-accent hover:text-foreground active:translate-y-0!"
          onClick={() => setRevealed((current) => !current)}
          aria-pressed={revealed}
          aria-label={revealed ? 'パスワードを隠す' : 'パスワードを表示'}
          /* ホバーで用途が出るようにする。aria-label と同じ文言で、
             マウスの人にも「もう一度押せば戻る」ことが分かるようにしている。 */
          title={revealed ? 'パスワードを隠す' : 'パスワードを表示'}
          disabled={disabled}
        >
          <EyeGlyph slashed={!revealed} />
        </Button>
      </span>
    </div>
  )
}

export function PasswordField({
  idPrefix,
  label = 'パスワード',
  hint,
  value,
  onChange,
  error,
  disabled = false,
  autoComplete,
}: {
  idPrefix: string
  label?: string
  hint?: ReactNode
  value: string
  onChange: (value: string) => void
  error?: string
  disabled?: boolean
  autoComplete: 'new-password' | 'current-password'
}) {
  const controlId = `${idPrefix}-password`

  return (
    <Field label={label} controlId={controlId} hint={hint} error={error}>
      {({ describedBy }) => (
        <PasswordInput
          id={controlId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoComplete={autoComplete}
          disabled={disabled}
        />
      )}
    </Field>
  )
}
