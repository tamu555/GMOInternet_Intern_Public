import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <p className="text-6xl font-bold text-muted-foreground/40" aria-hidden="true">
        404
      </p>
      <h1 className="text-2xl font-bold tracking-tight">ページが見つかりません</h1>
      <p className="text-sm text-muted-foreground leading-relaxed">
        お探しの画面は存在しないか、まだ実装されていません。
      </p>
      <Button asChild>
        <Link to="/">ドメイン検索へ</Link>
      </Button>
    </div>
  )
}
