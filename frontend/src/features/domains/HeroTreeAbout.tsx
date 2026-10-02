/**
 * 木の下に置く「この木について」。押すと、どのマーカーが何を意味するかの
 * 対応表が開く。
 *
 * 未ログインでも読めることが大事で、そこが主な役目でもある — 取得前の人に
 * 「取ると木がこうなる」を見せる。ログイン後は「いま何件あるか」も出るので、
 * 凡例と現状の両方を1枚で読める。
 *
 * ⚠️ 表は「マーカー／期限の帯／いま」だけ（2026-08-28）。以前あった
 * 「出る場所」「なぜそれか」の列は削った — 凡例に要るのは絵と意味の対応で、
 * 置き場所や作り手の意図は読み手の判断を助けない。列を戻さないこと。
 */
import { HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MARKER_KINDS, MARKER_ORDER, type MarkerKind } from './heroTreeMarkerKind'
import { MarkerArt, MarkerSparkle } from './heroTreeMarkers'

/** 表の中の1つぶん。木の上と同じ絵をそのまま小さく出す。 */
function Sample({ kind }: { kind: MarkerKind }) {
  return (
    // overflow-visible: 金の実の光線は 0-100 の箱を意図的にはみ出す。
    <svg viewBox="-14 -14 128 128" className="size-9 shrink-0 overflow-visible" aria-hidden="true" focusable="false">
      <MarkerArt kind={kind} urgent={kind === 'soon'} />
      {MARKER_KINDS[kind].premium ? <MarkerSparkle /> : null}
    </svg>
  )
}

export function HeroTreeAbout({ counts }: { counts: Partial<Record<MarkerKind, number>> }) {
  const hasDomains = Object.keys(counts).length > 0

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-primary">
          <HelpCircle />
          この木について
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>この木について</DialogTitle>
          <DialogDescription>
            ドメインを取得すると、この木に実や生きものが増えます。1件が1つ。何が出るかは
            更新期限までの距離で決まります。カーソルを合わせる（キーボードなら Tab）と、
            そのドメインの名前と状態が出ます。
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>マーカー</TableHead>
                <TableHead className="whitespace-nowrap">期限の帯</TableHead>
                {hasDomains ? <TableHead className="text-right whitespace-nowrap">いま</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {MARKER_ORDER.map((kind) => {
                const meta = MARKER_KINDS[kind]
                return (
                  <TableRow key={kind}>
                    <TableCell>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <Sample kind={kind} />
                        <b className="font-bold">{meta.label}</b>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{meta.band}</TableCell>
                    {hasDomains ? (
                      <TableCell className="text-right font-en whitespace-nowrap">
                        {counts[kind] ? `${counts[kind]}件` : '—'}
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        <p className="bg-grass-1 p-3 text-sm">
          <b className="font-bold">プレミアムドメインは金の実になります。</b>
          <span className="text-muted-foreground">
            {' '}
            まわりが小さく光ります。形は同じままなので、期限の読み方は変わりません。
          </span>
        </p>
        <p className="text-xs text-ink-faint">
          木に出るのは最大40件までで、超えたぶんは数だけ木の下に出ます。全件と手続きはマイページから。
        </p>
      </DialogContent>
    </Dialog>
  )
}
