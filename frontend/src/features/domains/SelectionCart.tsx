/**
 * 選択した商品 sidebar for the search result table.
 *
 * Selections survive re-searches (the cart may mix domains from several
 * labels). "次へ進む" carries every selected domain in the query string
 * (?domain=a.com&domain=b.com) so the URL stays an honest record of the
 * selection, but the application form (FIG.1 right half) processes one
 * domain per order - with 2+ items the cart says so up front instead of
 * silently dropping the rest.
 */
import { Link } from 'react-router-dom'
import { ShoppingCart, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { formatYen, getTldPricingOrDefault, threeYearTotalYen } from './tldData'

function proceedPath(selected: string[]): string {
  const params = new URLSearchParams()
  for (const domain of selected) params.append('domain', domain)
  return `/domains/new?${params.toString()}`
}

function threeYearTotalFor(domain: string): string {
  const tld = domain.slice(domain.indexOf('.'))
  return formatYen(threeYearTotalYen(getTldPricingOrDefault(tld)))
}

export function SelectionCart({
  selected,
  onRemove,
  onClear,
}: {
  selected: string[]
  onRemove: (domain: string) => void
  onClear: () => void
}) {
  return (
    <aside aria-label="選択した商品" className="lg:sticky lg:top-20">
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="size-4 text-primary" aria-hidden="true" />
            選択した商品
            <Badge variant="secondary" className="ml-auto">
              {selected.length}件
            </Badge>
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-3">
          {selected.length === 0 ? (
            <p className="py-4 text-center text-sm leading-relaxed text-muted-foreground">
              一覧の ◯「選択する」を押すと、ここに追加されます。
            </p>
          ) : (
            <ul className="space-y-2">
              {selected.map((domain) => {
                const total = threeYearTotalFor(domain)
                return (
                  <li
                    key={domain}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-mono text-sm break-all">{domain}</span>
                      {total ? (
                        <span className="text-xs text-muted-foreground">3年間の合計 {total}</span>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground"
                      aria-label={`${domain} を選択から外す`}
                      onClick={() => onRemove(domain)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-3">
          {selected.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onClear}
            >
              すべての選択を削除
            </Button>
          ) : null}

          {selected.length > 1 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              申込フォームは1件ずつのため、「次へ進む」ではまず最初の1件の申込に進みます。
            </p>
          ) : null}

          {selected.length > 0 ? (
            <Button asChild className="w-full">
              <Link to={proceedPath(selected)}>次へ進む</Link>
            </Button>
          ) : (
            <Button type="button" className="w-full" disabled>
              次へ進む
            </Button>
          )}
        </CardFooter>
      </Card>
    </aside>
  )
}
