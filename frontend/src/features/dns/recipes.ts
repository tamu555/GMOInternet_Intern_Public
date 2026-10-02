/**
 * レシピ（プリセット）方式 (spec §6.3.3b): 主要サービスごとのレコードテンプレ。
 *
 * 「新サービスの追加＝JSON追加のみ」が設計思想なので、レシピはすべてデータで
 * 持ち、ロジックは applyRecipe のプレースホルダ置換だけに留める。
 *
 * ⚠️ ここにある IP アドレス・ホスト名は各サービスが公開している一般的な設定値
 * だが、サービス側の都合でいつでも変わりうる。値がおかしいと報告されたら
 * まずこのファイルを疑い、公式ドキュメントの現行値に更新すること。
 */
import type { DnsRecord, DnsRecordType } from './dnsRecordTypes'

export type RecipeInput = {
  key: string
  label: string
  placeholder: string
  help?: string
}

/** A record template: `value` may contain '{key}' placeholders (see inputs). */
type RecipeRecordTemplate = {
  type: DnsRecordType
  name: string
  value: string
  ttl?: number
  priority?: number
}

export type DnsRecipe = {
  id: string
  service: string
  category: 'web' | 'mail'
  description: string
  /**
   * 'records': このサービスは当サービスのDNSにレコードを書く（レシピ本来の形）。
   * 'ns-guide': このサービスは通常NS変更で使う — レコードは持たず、NS変更モード
   * への誘導文（nsGuideNote）だけを持つ（§6.3.3a の分岐を跨がせない）。
   */
  mode: 'records' | 'ns-guide'
  inputs?: RecipeInput[]
  records?: RecipeRecordTemplate[]
  nsGuideNote?: string
}

export const DNS_RECIPES: DnsRecipe[] = [
  {
    id: 'vercel',
    service: 'Vercel',
    category: 'web',
    description: 'Vercel にデプロイしたサイトをこのドメインで公開します。',
    mode: 'records',
    records: [
      { type: 'A', name: '@', value: '76.76.21.21' },
      { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' },
    ],
  },
  {
    id: 'netlify',
    service: 'Netlify',
    category: 'web',
    description: 'Netlify にデプロイしたサイトをこのドメインで公開します。',
    mode: 'records',
    inputs: [
      {
        key: 'sitename',
        label: 'Netlify のサイト名',
        placeholder: 'my-site',
        help: 'Netlify の管理画面に表示される「my-site.netlify.app」の my-site の部分です。',
      },
    ],
    records: [
      { type: 'A', name: '@', value: '75.2.60.5' },
      { type: 'CNAME', name: 'www', value: '{sitename}.netlify.app' },
    ],
  },
  {
    id: 'github-pages',
    service: 'GitHub Pages',
    category: 'web',
    description: 'GitHub Pages で公開しているサイトをこのドメインで表示します。',
    mode: 'records',
    inputs: [
      {
        key: 'username',
        label: 'GitHub のユーザー名',
        placeholder: 'octocat',
        help: 'GitHub の「octocat.github.io」の octocat の部分です。',
      },
    ],
    records: [
      { type: 'A', name: '@', value: '185.199.108.153' },
      { type: 'A', name: '@', value: '185.199.109.153' },
      { type: 'A', name: '@', value: '185.199.110.153' },
      { type: 'A', name: '@', value: '185.199.111.153' },
      { type: 'CNAME', name: 'www', value: '{username}.github.io' },
    ],
  },
  {
    id: 'shopify',
    service: 'Shopify',
    category: 'web',
    description: 'Shopify で作ったネットショップをこのドメインで公開します。',
    mode: 'records',
    inputs: [
      {
        key: 'shopname',
        label: 'Shopify のショップ名',
        placeholder: 'my-shop',
        help: 'Shopify 管理画面に表示される「my-shop.myshopify.com」の my-shop の部分です。',
      },
    ],
    records: [
      { type: 'A', name: '@', value: '23.227.38.65' },
      { type: 'CNAME', name: 'www', value: '{shopname}.myshopify.com' },
    ],
  },
  {
    id: 'custom-server',
    service: '独自サーバー',
    category: 'web',
    description: '自分で用意したサーバー（VPS・レンタルサーバなど）でこのドメインを使います。',
    mode: 'records',
    inputs: [
      {
        key: 'ip',
        label: 'サーバのIPアドレス',
        placeholder: '203.0.113.10',
        help: '契約したサーバの管理画面に表示されるIPv4アドレスです。分からないときはサーバの提供元にお問い合わせください。',
      },
    ],
    records: [
      { type: 'A', name: '@', value: '{ip}' },
      { type: 'A', name: 'www', value: '{ip}' },
    ],
  },
  {
    id: 'google-workspace',
    service: 'Google Workspace',
    category: 'mail',
    description: 'Gmail（Google Workspace）でこのドメインのメールを送受信します。',
    mode: 'records',
    records: [
      { type: 'MX', name: '@', value: 'smtp.google.com', priority: 1 },
      { type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all' },
    ],
  },
  {
    id: 'microsoft-365',
    service: 'Microsoft 365',
    category: 'mail',
    description: 'Outlook（Microsoft 365）でこのドメインのメールを送受信します。',
    mode: 'records',
    inputs: [
      {
        key: 'mxtoken',
        label: 'MX トークン',
        placeholder: 'example-com',
        help: 'Microsoft 365 管理センターのDNS設定画面に表示される「example-com.mail.protection.outlook.com」の先頭部分です。',
      },
    ],
    records: [
      { type: 'MX', name: '@', value: '{mxtoken}.mail.protection.outlook.com', priority: 0 },
      { type: 'TXT', name: '@', value: 'v=spf1 include:spf.protection.outlook.com -all' },
    ],
  },
  {
    id: 'sakura-rental',
    service: 'さくらのレンタルサーバ',
    category: 'web',
    description: 'さくらのレンタルサーバで公開しているサイトをこのドメインで表示します。',
    mode: 'records',
    inputs: [
      {
        key: 'ip',
        label: 'サーバのIPアドレス',
        placeholder: '203.0.113.10',
        help: 'さくらのコントロールパネル「サーバ情報」に表示されるIPv4アドレスです。',
      },
    ],
    records: [
      { type: 'A', name: '@', value: '{ip}' },
      { type: 'A', name: 'www', value: '{ip}' },
    ],
  },
  {
    id: 'xserver',
    service: 'エックスサーバー',
    category: 'web',
    description: 'エックスサーバーでこのドメインを使います。',
    mode: 'ns-guide',
    nsGuideNote:
      'エックスサーバーは自社のネームサーバー（ns1.xserver.jp など）へ切り替えて使うのが標準の設定方法です。レコードをここに書くのではなく、NS変更モードで案内されたネームサーバーを設定してください。',
  },
  {
    id: 'cloudflare',
    service: 'Cloudflare',
    category: 'web',
    description: 'Cloudflare（CDN・DNS）でこのドメインを管理します。',
    mode: 'ns-guide',
    nsGuideNote:
      'Cloudflare は登録時に割り当てられる専用のネームサーバー（xxx.ns.cloudflare.com）へ切り替えて使います。レコードをここに書くのではなく、NS変更モードで Cloudflare に表示された2つのネームサーバーを設定してください。',
  },
]

/**
 * Fills the '{key}' placeholders and returns the concrete records. A recipe
 * without records ('ns-guide') yields []. Throws when a placeholder is left
 * unfilled — the UI enforces required inputs, this is a defensive guard, not
 * a user-facing error path.
 */
export function applyRecipe(recipe: DnsRecipe, inputs: Record<string, string>): DnsRecord[] {
  if (!recipe.records) return []
  return recipe.records.map((template) => {
    const value = template.value.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, key: string) => {
      const filled = inputs[key]?.trim()
      if (!filled) {
        throw new Error(`recipe "${recipe.id}": input "${key}" is required but was not provided`)
      }
      return filled
    })
    return {
      type: template.type,
      name: template.name,
      value,
      ...(template.ttl !== undefined ? { ttl: template.ttl } : {}),
      ...(template.priority !== undefined ? { priority: template.priority } : {}),
    }
  })
}
