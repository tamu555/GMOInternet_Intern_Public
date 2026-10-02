/**
 * Stand-in for the screens that are out of scope here (normal mode / easy mode).
 * They exist so the protected routes named in FIG.8 are actually routable.
 */
import { Construction } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

export function PlaceholderPage({ title, path, note }: { title: string; path: string; note: string }) {
  return (
    <div className="flex justify-center py-10">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-none bg-accent">
            <Construction className="size-5 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">{path}</code>{' '}
            は認証が必要な保護ルートです。ここに到達できていれば、
            セッション確認が完了して「認証済み」になっています。
          </p>
          <Separator />
          <div className="space-y-1.5">
            <h2 className="text-sm font-medium">この画面について</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{note}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
