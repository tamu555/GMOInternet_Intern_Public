/**
 * テンプレート選択ダイアログ (§6.3.3b): サービスを選ぶだけでレコード案を一括投入。
 * mode:'ns-guide' のサービス（Cloudflare 等）はレコードを持たず、§6.3.3a の
 * 分岐を跨がないよう NS変更モードへの誘導だけを出す。
 */
import { ArrowLeft, Info } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { applyRecipe, DNS_RECIPES, type DnsRecipe } from './recipes'
import type { DnsRecord } from './dnsRecordTypes'

const CATEGORY_LABELS = { web: 'Webサイト', mail: 'メール' } as const

type RecipeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdopt: (records: DnsRecord[]) => void
  onSwitchToNsMode: () => void
}

export function RecipeDialog({ open, onOpenChange, onAdopt, onSwitchToNsMode }: RecipeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix はクローズ中 DialogContent をアンマウントするので、選択状態は
          開くたびに初期化される（NameserverDialog と同じ構造）。 */}
      <DialogContent className="sm:max-w-lg">
        <RecipeDialogBody onAdopt={onAdopt} onSwitchToNsMode={onSwitchToNsMode} />
      </DialogContent>
    </Dialog>
  )
}

function RecipeDialogBody({ onAdopt, onSwitchToNsMode }: Omit<RecipeDialogProps, 'open' | 'onOpenChange'>) {
  const [selected, setSelected] = useState<DnsRecipe | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})

  if (!selected) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>テンプレートから選ぶ</DialogTitle>
          <DialogDescription>
            使いたいサービスを選ぶだけで、必要なレコードをまとめて用意します。
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
          {DNS_RECIPES.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className="flex flex-col items-start gap-1 rounded-lg border border-input bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent"
              onClick={() => {
                setSelected(recipe)
                setInputs({})
              }}
            >
              <span className="flex items-center gap-2 text-sm font-bold">
                {recipe.service}
                <Badge variant="secondary">{CATEGORY_LABELS[recipe.category]}</Badge>
              </span>
              <span className="text-[13px] text-muted-foreground">{recipe.description}</span>
            </button>
          ))}
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          使っているサービスが見つからないときは、このまま閉じて「案内文を貼り付ける」をお試しください。
        </p>
      </>
    )
  }

  if (selected.mode === 'ns-guide') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{selected.service}</DialogTitle>
          <DialogDescription>{selected.description}</DialogDescription>
        </DialogHeader>
        <Alert variant="info">
          <Info />
          <AlertTitle>このサービスはネームサーバー変更で設定します</AlertTitle>
          <AlertDescription>
            <p>{selected.nsGuideNote}</p>
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            <ArrowLeft />
            一覧へ戻る
          </Button>
          <Button onClick={onSwitchToNsMode}>NS変更モードへ</Button>
        </DialogFooter>
      </>
    )
  }

  const requiredInputs = selected.inputs ?? []
  const allFilled = requiredInputs.every((input) => (inputs[input.key] ?? '').trim() !== '')
  // 全入力が揃ったときだけプレビューを作る（applyRecipe は未入力で throw する）。
  const preview = allFilled ? applyRecipe(selected, inputs) : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>{selected.service}</DialogTitle>
        <DialogDescription>{selected.description}</DialogDescription>
      </DialogHeader>

      {requiredInputs.length > 0 ? (
        <div className="flex flex-col gap-3">
          {requiredInputs.map((input) => (
            <label key={input.key} className="flex flex-col gap-1.5 text-sm font-semibold">
              {input.label}
              <input
                type="text"
                className="h-10 rounded-md border border-input bg-card px-3 font-mono text-sm font-normal placeholder:text-ink-hint"
                placeholder={input.placeholder}
                value={inputs[input.key] ?? ''}
                onChange={(event) =>
                  setInputs((current) => ({ ...current, [input.key]: event.target.value }))
                }
              />
              {input.help ? (
                <span className="text-xs font-normal text-muted-foreground">{input.help}</span>
              ) : null}
            </label>
          ))}
        </div>
      ) : null}

      <div>
        <p className="text-sm font-semibold">作成されるレコード案</p>
        {preview ? (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {preview.map((record, index) => (
              <li key={index} className="rounded-md bg-muted px-3 py-2 font-mono text-[13px]">
                {record.type} {record.name} → {record.value}
                {record.priority !== undefined ? `（優先度 ${record.priority}）` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-muted-foreground">上の項目を入力するとプレビューが表示されます。</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => setSelected(null)}>
          <ArrowLeft />
          一覧へ戻る
        </Button>
        <Button disabled={!preview} onClick={() => preview && onAdopt(preview)}>
          レコード案に追加
        </Button>
      </DialogFooter>
    </>
  )
}
