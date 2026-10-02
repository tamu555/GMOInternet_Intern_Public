/**
 * トップページ下部の機能紹介（かんたんモード / AIアシスタント / つなぐ）。
 *
 * ヒーロー〜結果見本までは「検索する前の不安」を取りに行く節で、この節はその
 * 続き — 「検索したあと、取ったあとはどうなるのか」に答える。ランディングの
 * 最後で初めて出てくる話なので、3つとも実物の語彙で書く：ステップ名は
 * `EASY_STEPS`、レコードの言い換えは `plainRecordLabel`、テンプレートの件数と
 * サービス名は `DNS_RECIPES` から取る。ここに文字列を直書きすると、機能が
 * 増減してもトップページだけが古いことを言い続けることになる。
 *
 * 見本（右カラム）は 結果見本 の節と同じ約束で作る: 実物と同じ言い回しを使い、
 * 「※ 表示は見本です」を必ず添える。押せる部品は置かない（見本の中の
 * ボタンらしきものは span で、フォーカスも押下もできない）。
 *
 * AI の節は `assistantEnabled()` が false のとき丸ごと消える。§6.1 のキル
 * スイッチが入ると `AssistantLauncher` はどこにも描画されないので、入口の
 * ない機能を宣伝する節だけが残ってしまうため。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Cable, Check, MessageCircleQuestionMark, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AssistantLauncher } from '../assistant/AssistantLauncher'
import {
  AI_GENERATED_CONTENT_NOTICE,
  DOMAIN_AVAILABLE_LABEL,
  RULE_BASED_CANDIDATES_HEADING,
} from '../assistant/assistantMessages'
import { assistantEnabled } from '../assistant/config/assistantConfig'
import { DNS_RECIPES } from '../dns/recipes'
import { plainRecordLabel } from '../easy/easyDnsPlans'
import { EASY_MODE_LABEL, EASY_MODE_TAGLINE } from '../easy/easyMessages'
import { EASY_STEPS } from '../easy/easyTypes'
import { formatYen, getTldPricing } from './tldData'

/** 見本パネル。節の地は --paper なので、見本だけカードに載せて浮かせる。 */
const ART_PANEL = 'bg-card p-5 shadow-soft sm:p-6'
/** 見本であることの断り書き。結果見本の節と同じ体裁。 */
const ART_NOTE = 'mt-4 text-[12px] leading-relaxed text-ink-faint'

function FeatureChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="mb-3.5 inline-flex items-center gap-1.5 bg-grass-2 px-3 py-1 font-heading text-[12.5px] font-bold text-green-darkest">
      {icon}
      {children}
    </span>
  )
}

function FeaturePoints({ points }: { points: string[] }) {
  return (
    <ul className="mb-6 list-none space-y-2.5 p-0">
      {points.map((point) => (
        <li key={point} className="flex gap-2.5 text-sm leading-relaxed">
          <Check className="mt-0.5 size-4 shrink-0 text-green-brand" aria-hidden="true" />
          <span className="text-balance">{point}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 1つの機能 = 説明カラム + 見本カラム。`flip` で見本を左に送り、3つ並べても
 * 同じ形が3回続かないようにする（並び順は DOM のままなので読み上げは
 * 「説明 → 見本」で一定）。
 */
function FeatureRow({ copy, art, flip = false }: { copy: ReactNode; art: ReactNode; flip?: boolean }) {
  return (
    <article className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)] lg:gap-14">
      <div className={flip ? 'lg:order-2' : undefined}>{copy}</div>
      <div className={flip ? 'lg:order-1' : undefined}>{art}</div>
    </article>
  )
}

/** かんたんモードの見本: 実物のステップ定義をそのまま並べる。 */
function EasyStepsArt() {
  return (
    <div className={ART_PANEL}>
      <p className="mb-4 font-heading text-[13px] font-bold text-ink-faint">
        ぜんぶで{EASY_STEPS.length}ステップ
      </p>
      <ol className="list-none space-y-1.5 p-0">
        {EASY_STEPS.map((step, index) => (
          <li key={step.id} className="flex items-center gap-3 px-1 py-1.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center bg-grass-1 font-heading text-[13px] font-black text-green-darkest"
            >
              {index + 1}
            </span>
            <span className="font-heading text-[15px] font-bold">{step.label}</span>
            <span className="ml-auto text-[11.5px] text-ink-faint">
              {step.requiresAuth ? 'ログイン後' : 'ログイン不要'}
            </span>
          </li>
        ))}
      </ol>
      <p className={ART_NOTE}>
        ※ 表示は見本です。ログインが必要になるのは
        {EASY_STEPS.findIndex((step) => step.requiresAuth) + 1}番目の「
        {EASY_STEPS.find((step) => step.requiresAuth)?.label}」からで、そこまでの入力は保存されます。
      </p>
    </div>
  )
}

/** AIアシスタントの見本: 質問1往復と、空き確認済みの候補。 */
function AssistantArt() {
  const candidates = [
    { domain: 'aoi-portfolio.site', tld: '.site' },
    { domain: 'aoi-works.com', tld: '.com' },
  ]
  return (
    <div className={ART_PANEL}>
      <div className="space-y-3">
        <p className="ml-auto w-fit max-w-[85%] bg-grass-2 px-4 py-2.5 text-[13.5px] leading-relaxed text-green-darkest">
          ポートフォリオ用の名前を考えて
        </p>
        <p className="w-fit max-w-[90%] bg-paper-2 px-4 py-2.5 text-[13.5px] leading-relaxed">
          どんな作品をのせますか？　名前の候補を、空き状況を確かめてからお出しします。
        </p>
      </div>

      <p className="mt-5 mb-2 font-heading text-[12.5px] font-bold text-ink-faint">
        {RULE_BASED_CANDIDATES_HEADING}
      </p>
      <ul className="list-none space-y-1.5 p-0">
        {candidates.map((candidate) => {
          const pricing = getTldPricing(candidate.tld)
          return (
            <li
              key={candidate.domain}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-paper-2 px-4 py-2.5"
            >
              <span className="font-en text-[14px] font-semibold text-green-darkest">{candidate.domain}</span>
              <span className="text-[11.5px] font-bold text-green-brand">◯ {DOMAIN_AVAILABLE_LABEL}</span>
              {pricing ? (
                <span className="font-en ml-auto text-[12.5px] text-ink-faint">
                  初年度 {formatYen(pricing.firstYearYen)}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className={ART_NOTE}>※ 表示は見本です。{AI_GENERATED_CONTENT_NOTICE}</p>
    </div>
  )
}

/**
 * つなぐの見本: 実物と同じ質問文 → サービスを選ぶ → 用意されるレコード。
 * サービス名もレコードの言い換えも `DNS_RECIPES` / `plainRecordLabel` 由来。
 * 値（IPアドレスなど）は出さない — テンプレートによっては `{key}` の
 * プレースホルダのままで、見本としては嘘になるため。
 */
function ConnectArt() {
  const webRecipes = DNS_RECIPES.filter((recipe) => recipe.category === 'web' && recipe.records?.length)
  const shown = webRecipes.slice(0, 3)
  const picked = shown[0]
  return (
    <div className={ART_PANEL}>
      <p className="mb-3 font-heading text-[13px] font-bold">サイトやメールは、どこにありますか？</p>
      <ul className="list-none space-y-1.5 p-0">
        {shown.map((recipe) => {
          const selected = recipe.id === picked?.id
          return (
            <li
              key={recipe.id}
              className={`flex items-center gap-2.5 px-4 py-2.5 text-[13.5px] ${
                selected ? 'bg-grass-1 font-bold' : 'bg-paper-2 text-muted-foreground'
              }`}
            >
              <span
                aria-hidden="true"
                className={`size-3.5 shrink-0 rounded-full ${selected ? 'bg-green-brand' : 'bg-grass-2'}`}
              />
              {recipe.service}
            </li>
          )
        })}
      </ul>

      {picked?.records?.length ? (
        <div className="mt-4 bg-paper-2 px-4 py-3.5">
          <p className="mb-2 font-heading text-[12.5px] font-bold text-ink-faint">作成されるレコード案</p>
          <ul className="list-none space-y-1 p-0">
            {picked.records.map((record) => (
              <li
                key={`${record.type}-${record.name}`}
                className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] leading-relaxed"
              >
                <span className="font-en text-green-darkest">{record.name}</span>
                <span className="text-muted-foreground">{plainRecordLabel(record.type)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={ART_NOTE}>
        ※ 表示は見本です。実際に書き込まれる値は、選んだサービスの案内にあわせて用意します。
      </p>
    </div>
  )
}

export function LandingFeatures({ className }: { className?: string }) {
  const showAssistant = assistantEnabled()
  const firstAuthStep = EASY_STEPS.findIndex((step) => step.requiresAuth)
  const publicStepCount = firstAuthStep < 0 ? EASY_STEPS.length : firstAuthStep

  return (
    <div className={className}>
      <div className="mb-9 lg:mb-12">
        <h2 className="mb-2.5 text-2xl font-black sm:text-[30px]">取ったあとまで、ぜんぶ案内します</h2>
        <p className="max-w-[46em] text-sm leading-relaxed text-muted-foreground text-balance">
          ドメインは、名前を決めて終わりではありません。つまずきやすいところに、それぞれ入口を用意しました。
        </p>
      </div>

      <div className="space-y-14 lg:space-y-20">
        {/* ── かんたんモード ─────────────────────────────────────── */}
        <FeatureRow
          copy={
            <div>
              <FeatureChip icon={<Sparkles className="size-3.5" aria-hidden="true" />}>
                {EASY_MODE_LABEL}
              </FeatureChip>
              <h3 className="mb-3 font-heading text-[22px] leading-snug font-black text-balance sm:text-[26px]">
                質問に答えるだけで、取得まで進めます
              </h3>
              <p className="mb-5 max-w-[38em] text-sm leading-loose text-muted-foreground text-balance">
                {EASY_MODE_TAGLINE}
                1つの画面でお聞きすることは1つだけ。「何に使いますか？」から順に答えていくと、名前の候補も末尾のおすすめも、選んだ目的に合わせて並びます。
              </p>
              <FeaturePoints
                points={[
                  '専門用語は消さずに、やさしい言い換えを添えています。通常モードへそのまま卒業できます。',
                  '認証コードや連絡先は自動で用意します。決めるのは名前と末尾だけです。',
                  `最初の${publicStepCount}ステップはログイン不要。入力は保存されるので、途中でログインしても続きから戻れます。`,
                ]}
              />
              <Button asChild>
                <Link to="/easy">
                  <Sparkles aria-hidden="true" />
                  {EASY_MODE_LABEL}を試す
                </Link>
              </Button>
            </div>
          }
          art={<EasyStepsArt />}
        />

        {/* ── AIアシスタント ─────────────────────────────────────── */}
        {showAssistant ? (
          <FeatureRow
            flip
            copy={
              <div>
                <FeatureChip icon={<MessageCircleQuestionMark className="size-3.5" aria-hidden="true" />}>
                  AIアシスタント
                </FeatureChip>
                <h3 className="mb-3 font-heading text-[22px] leading-snug font-black text-balance sm:text-[26px]">
                  わからないことは、その場で聞けます
                </h3>
                <p className="mb-5 max-w-[38em] text-sm leading-loose text-muted-foreground text-balance">
                  「ポートフォリオ用の名前を考えて」「メールを使えるようにしたい」——
                  思いついたまま書いて大丈夫です。空きを確かめた名前の候補や、次に開く画面をそのまま返します。
                </p>
                <FeaturePoints
                  points={[
                    'AIはお使いの端末（ブラウザ）の中で動きます。質問した内容がサーバーへ送られることはありません。',
                    '名前の候補は、レジストリに空きを確認できたものだけをお見せします。',
                    '「Webサイトを公開する」のように、手順を最後まで一緒に進めるガイドもあります。',
                  ]}
                />
                <AssistantLauncher variant="cta" />
              </div>
            }
            art={<AssistantArt />}
          />
        ) : null}

        {/* ── つなぐ（DNS設定） ──────────────────────────────────── */}
        <FeatureRow
          copy={
            <div>
              <FeatureChip icon={<Cable className="size-3.5" aria-hidden="true" />}>ドメインをつなぐ</FeatureChip>
              <h3 className="mb-3 font-heading text-[22px] leading-snug font-black text-balance sm:text-[26px]">
                DNSの設定は、選ぶか貼るかで終わります
              </h3>
              <p className="mb-5 max-w-[38em] text-sm leading-loose text-muted-foreground text-balance">
                取ったドメインをサイトやメールにつなぐところまで、この中で終わります。「DNSレコード」を知らなくても、使っているサービスを選ぶか、届いた案内文をそのまま貼り付けるだけです。
              </p>
              <FeaturePoints
                points={[
                  `テンプレートは${DNS_RECIPES.length}種類。選ぶだけで、必要なレコードをまとめて用意します。`,
                  '案内文を貼り付けると、種別・名前・値を読み取ります。読み取れなかった行も隠しません。',
                  '保存したあとは「つながったか確認する」で、いま実際にどう見えているかを調べられます。',
                ]}
              />
              <p className="text-[12.5px] leading-relaxed text-ink-faint">
                ※ 設定はあとから何度でもやり直せます。取得するときに決めなくても大丈夫です。
              </p>
            </div>
          }
          art={<ConnectArt />}
        />
      </div>
    </div>
  )
}
