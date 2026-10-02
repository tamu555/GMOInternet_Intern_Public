/**
 * Public third-party license notice page (docs/仕様/browser-ai.md §19.2).
 *
 * Adding @mlc-ai/web-llm as a dependency creates an Apache-2.0 NOTICE
 * obligation, and the browser-in-tab AI assistant also downloads an
 * Apache-2.0 licensed model (Qwen3). This page reproduces the full license
 * texts, imported at build time from the repo-root `legal/` directory via
 * Vite's `?raw` import so the exact on-disk text ships unmodified.
 */
import { Card, CardContent } from '@/components/ui/card'
import thirdPartyNotices from '../../../legal/THIRD_PARTY_NOTICES.txt?raw'
import webLlmLicense from '../../../legal/WEBLLM_LICENSE.txt?raw'
import qwenLicense from '../../../legal/QWEN_LICENSE.txt?raw'

function LicenseSection({
  id,
  heading,
  subheading,
  body,
}: {
  id: string
  heading: string
  subheading?: string
  body: string
}) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <h2 id={id} className="scroll-mt-24 text-lg font-bold tracking-tight">
            {heading}
          </h2>
          {subheading ? <p className="text-sm text-muted-foreground">{subheading}</p> : null}
        </div>
        <pre className="max-h-[480px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">
          {body}
        </pre>
      </CardContent>
    </Card>
  )
}

export function ThirdPartyLicensesPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">第三者ライセンス</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          このサービスは、オープンソースソフトウェアと、お使いの端末（ブラウザ）内で動作する
          AIモデルを組み込んでいます。それぞれのライセンス条文を以下に全文掲載します。
        </p>
      </header>

      <LicenseSection
        id="notices-overview"
        heading="概要"
        subheading="対象コンポーネントの一覧（THIRD_PARTY_NOTICES.txt）"
        body={thirdPartyNotices}
      />

      <LicenseSection
        id="web-llm-license"
        heading="@mlc-ai/web-llm（Apache License 2.0）"
        subheading="ブラウザ内でAIモデルを実行するライブラリ"
        body={webLlmLicense}
      />

      <LicenseSection
        id="qwen-license"
        heading="Qwen（Apache License 2.0）"
        subheading="このサービスが利用するAIモデル（Qwen3-0.6B）のライセンス"
        body={qwenLicense}
      />
    </div>
  )
}
