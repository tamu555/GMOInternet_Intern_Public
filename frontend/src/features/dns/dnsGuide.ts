/**
 * 初心者向けの説明データ (§6.3.3): 用語のツールチップ文と、レコード種別ごとの
 * 「何ができるか / 何を入れるか」。
 *
 * 文言だけをここに集め、UI 側はレイアウトに徹する。新しい種別や用語が増えても
 * このファイルへの追記だけで済むようにしている（recipes.ts と同じ思想）。
 *
 * ⚠️ 説明は「専門用語を消す」のではなく「専門用語に短い言い換えを添える」
 * （§1.2）。用語そのものを画面から消すと、サービス側の案内文と対応が取れず
 * かえって迷う。
 */
import type { DnsRecord, DnsRecordType } from './dnsRecordTypes'

export type DnsTermId =
  | 'dns'
  | 'nameserver'
  | 'record'
  | 'recordName'
  | 'recordValue'
  | 'ttl'
  | 'priority'
  | 'hostname'
  | 'ipAddress'
  | 'propagation'

export type DnsTerm = {
  /** ツールチップの見出し。ボタンの aria-label にも使う。 */
  label: string
  /** 1〜2文の言い換え。ツールチップの幅（max-w-xs）に収まる長さに保つ。 */
  description: string
}

export const DNS_TERMS: Record<DnsTermId, DnsTerm> = {
  dns: {
    label: 'DNS',
    description:
      'ドメイン名（example.com）を、実際のサーバーの住所に変換するしくみです。インターネットの住所録だと考えてください。',
  },
  nameserver: {
    label: 'ネームサーバー',
    description:
      'このドメインの住所録を、どこの会社が管理するかの指定です。ns1.example.com のような形をしています。',
  },
  record: {
    label: 'レコード',
    description:
      '住所録に書く1行分の情報です。「どの名前へのアクセスを、どこへ案内するか」を1件ずつ登録します。',
  },
  recordName: {
    label: '名前',
    description:
      'ドメインのどの部分を設定するかです。空欄なら @（ドメインそのもの）、www と入れると www 付きのアドレスになります。',
  },
  recordValue: {
    label: '値',
    description:
      '案内先です。サービスから渡されたIPアドレスやホスト名を、そのままコピーして貼り付けてください。',
  },
  ttl: {
    label: 'TTL',
    description:
      '設定内容が世界中のDNSに一時保存される秒数です。空欄のままで問題ありません（通常は3600秒＝1時間）。',
  },
  priority: {
    label: '優先度',
    description:
      'メールの届け先が複数あるとき、どれを先に使うかの数字です。数字が小さいほど優先されます。',
  },
  hostname: {
    label: 'ホスト名',
    description: 'www.example.com のような、ドットを含むサーバーの名前です。',
  },
  ipAddress: {
    label: 'IPアドレス',
    description: 'サーバーに割り当てられた数字の住所です。203.0.113.10 のような形をしています。',
  },
  propagation: {
    label: '反映',
    description:
      '設定した内容が世界中のDNSに行き渡るまでの待ち時間です。通常は数分、長いときは48時間ほどかかります。',
  },
}

export type DnsTypeGuide = {
  /** 見出しに使う短い名前。 */
  title: string
  /** 「何ができるか」を専門用語なしで1行。選択肢の右側に出す。 */
  purpose: string
  /** 種別を選んだあとに出す2〜3文の説明。 */
  summary: string
  /** 「値」欄のラベル（種別によって入れるものが変わるため）。 */
  valueLabel: string
  valuePlaceholder: string
  /** 「名前」欄に添えるヒント。 */
  nameHint: string
  /**
   * 'common' はよく使う4種、'advanced' は上級者向け。select では optgroup で
   * 分け、初心者の目に入る選択肢を減らす。
   */
  group: 'common' | 'advanced'
}

export const DNS_TYPE_GUIDES: Record<DnsRecordType, DnsTypeGuide> = {
  A: {
    title: 'Aレコード',
    purpose: 'ホームページを表示する',
    summary:
      'このドメインを見た人を、指定したサーバーへ案内します。ホームページを公開するときの基本の設定です。サーバー会社から数字のIPアドレスを渡されたときはこれを選びます。',
    valueLabel: 'サーバーのIPアドレス（数字）',
    valuePlaceholder: '203.0.113.10',
    nameHint: '空欄なら example.com そのもの。www を付けたいときは www と入力します。',
    group: 'common',
  },
  CNAME: {
    title: 'CNAMEレコード',
    purpose: '別のホスト名に案内する',
    summary:
      'このドメインを、別のホスト名の別名にします。サービスから「◯◯.example.com を設定してください」と文字のあて先を渡されたときはこれを選びます。',
    valueLabel: '案内先のホスト名（文字）',
    valuePlaceholder: 'cname.example.com',
    nameHint: 'www など、別名にしたい部分を入力します。ドメインそのもの（@）には設定できません。',
    group: 'common',
  },
  MX: {
    title: 'MXレコード',
    purpose: 'メールを受け取る',
    summary:
      'このドメイン宛のメールを、どのメールサーバーへ届けるかを指定します。Gmail や Outlook で独自ドメインのメールを使うときに設定します。',
    valueLabel: 'メールサーバーのホスト名',
    valuePlaceholder: 'smtp.example.com',
    nameHint: 'メールアドレスの @ より後ろを設定します。通常は空欄のままで大丈夫です。',
    group: 'common',
  },
  TXT: {
    title: 'TXTレコード',
    purpose: '所有者の確認・迷惑メール対策',
    summary:
      'サービスから渡された文字列をそのまま登録します。ドメインの所有者確認や、メールのなりすまし防止（SPF）に使われます。意味を理解する必要はなく、渡された文字列を丸ごと貼り付けてください。',
    valueLabel: '登録する文字列',
    valuePlaceholder: 'v=spf1 include:_spf.example.com ~all',
    nameHint: '指定がなければ空欄のままで大丈夫です。',
    group: 'common',
  },
  AAAA: {
    title: 'AAAAレコード',
    purpose: 'ホームページを表示する（新しい形式）',
    summary:
      'Aレコードと同じ役割ですが、新しい形式のIPアドレス（IPv6）を使います。サーバー側がIPv6に対応していて、その形式のアドレスを渡されたときだけ使います。',
    valueLabel: 'サーバーのIPアドレス（IPv6）',
    valuePlaceholder: '2001:db8::1',
    nameHint: '空欄なら example.com そのもの。www を付けたいときは www と入力します。',
    group: 'advanced',
  },
  NS: {
    title: 'NSレコード',
    purpose: '一部の名前だけ別のDNSに任せる',
    summary:
      'サブドメインだけを別のDNSサービスに任せる、上級者向けの設定です。ドメイン全体の担当を変えたいときは、この画面ではなく「ネームサーバーを渡された」側の設定を使ってください。',
    valueLabel: 'ネームサーバーのホスト名',
    valuePlaceholder: 'ns1.example.com',
    nameHint: '任せたいサブドメイン名（例: sub）を入力します。',
    group: 'advanced',
  },
}

/** select の表示順。よく使う4種を先に出し、上級者向けは optgroup で分ける。 */
export const COMMON_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'CNAME', 'MX', 'TXT']
export const ADVANCED_RECORD_TYPES: readonly DnsRecordType[] = ['AAAA', 'NS']

/** '@' や空欄を実際のアドレス（FQDN）に開いて見せる。 */
export function displayHost(name: string, domainName: string): string {
  const trimmed = name.trim().toLowerCase()
  if (trimmed === '' || trimmed === '@') return domainName
  return `${trimmed}.${domainName}`
}

/**
 * 確認画面で使う「この1行が何をするか」の平易な言い換え。
 * 値が空のときは呼ばれない前提（保存前バリデーションを通ったものだけ渡す）。
 */
export function describeRecord(record: DnsRecord, domainName: string): string {
  const host = displayHost(record.name, domainName)
  switch (record.type) {
    case 'A':
    case 'AAAA':
      return `${host} を開いた人に、${record.value} のサーバーの内容を表示します。`
    case 'CNAME':
      return `${host} へのアクセスを ${record.value} に案内します。`
    case 'MX':
      return `${host} 宛のメールを ${record.value} に届けます（優先度 ${record.priority ?? '—'}）。`
    case 'TXT':
      return `${host} に「${record.value}」という文字列を登録します。`
    case 'NS':
      return `${host} の管理を ${record.value} に任せます。`
  }
}

/**
 * 保存済みの内容が「利用者にとって何を意味するか」の1文。
 *
 * ⚠️ 「2件のレコードが登録されています」は、初心者には 2 が多いのか少ないのか、
 * それで足りているのかが分からない。件数ではなく、ホームページ／メールが
 * つながる状態になっているかどうかを答える。
 */
export function summarizeConnections(records: DnsRecord[], domainName: string): string {
  const hasWeb = records.some((record) => record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME')
  const hasMail = records.some((record) => record.type === 'MX')

  if (records.length === 0) {
    return `いま、つなぎ先は1件も登録されていません。${domainName} と打っても、まだ何も表示されません。`
  }
  if (hasWeb && hasMail) {
    return `${domainName} は、ホームページの表示先とメールの届け先の両方がそろっています。`
  }
  if (hasWeb) {
    return `${domainName} を開いた人に、指定した場所のホームページを表示する設定になっています。`
  }
  if (hasMail) {
    return `${domainName} 宛のメールを、指定した場所に届ける設定になっています。`
  }
  return `${domainName} には、サービスから渡された確認用の情報だけが登録されています。ホームページやメールのつなぎ先はまだありません。`
}
