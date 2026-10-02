/**
 * User-facing wording for the assistant chat feature (spec browser-ai.md).
 * Kept in one module so the spec-fixed phrasings cannot drift per component -
 * mirrors `features/dns/dnsMessages.ts` / `features/domains/domainMessages.ts`.
 */

/** §2.2 対象外の質問への固定回答。 */
export const OUT_OF_SCOPE_MESSAGE =
  'このAIでは、ドメインの購入やDNS設定など、\nこのサービスの操作方法のみご案内しています。\n\nドメインについて困っていることがあれば教えてください。'

/** §11.5 AI出力のスキーマ検証に失敗したときに表示する固定メッセージ。 */
export const DECISION_VALIDATION_FAILED_MESSAGE =
  '申し訳ありません。\nうまく案内先を判断できませんでした。\n\nもう少し具体的に、\n何をしたいか教えてください。'

/** §12.4 SUSPICIOUS 判定時の固定回答。LLMには渡さず、この文言をそのまま表示する。 */
export const SUSPICIOUS_INPUT_MESSAGE =
  'このAIでは、本サービス内のドメイン購入や\nDNS設定についてのみご案内しています。'

/** §6.4 モデル準備中カードの見出し。 */
export const MODEL_PREPARING_TITLE = 'AIを準備しています'
/** §6.4 モデル準備中カードの補足1: 初回のみ端末に保存されること。 */
export const MODEL_PREPARING_FIRST_TIME_NOTE = '初回のみAIモデルをお使いの端末へ保存します。'
/** §6.4 モデル準備中カードの補足2: 完了後に自動で使えるようになること。 */
export const MODEL_PREPARING_AUTO_START_NOTE = '準備が完了すると自動的に利用できます。'

/** §16 WebGPU非対応・enabled=false（ModelStatus 'UNSUPPORTED'）。 */
export const MODEL_UNSUPPORTED_MESSAGE =
  'この端末ではAIアシスタントを利用できません。かんたんモードから同じ操作をご案内します。'
/** §16 UNSUPPORTED 時の誘導ボタン（/easy/goal への固定リンク。Manifestを経由しない）。 */
export const OPEN_EASY_MODE_BUTTON_LABEL = 'かんたんモードを開く'

/** §16 モデルDL失敗（ModelStatus 'ERROR'）。再試行は CHECKING から。 */
export const MODEL_LOAD_FAILED_MESSAGE = 'AIの準備に失敗しました。通信環境を確認してもう一度お試しください。'
/** §16 モデルDL失敗時の再試行ボタン。 */
export const RETRY_BUTTON_LABEL = '再試行'

/** §16 端末の空き容量不足（再試行なし）。 */
export const MODEL_STORAGE_INSUFFICIENT_MESSAGE = '端末の空き容量が不足しているためAIを準備できません。'

/** §17.2 低速回線（saveData / 2g / 3g）検出時の同意案内本文。 */
export const SLOW_CONNECTION_CONSENT_MESSAGE = '初回のみ約 350MB を端末へ保存します'
/** §17.2 低速回線同意ボタン。押下後に DOWNLOADING へ進む。 */
export const CONSENT_TO_DOWNLOAD_BUTTON_LABEL = '保存して準備する'

/** §16 生成タイムアウト（60秒、送信時点から計測）。abort 後にこのメッセージを表示する。 */
export const GENERATION_TIMEOUT_MESSAGE = '時間内に回答できませんでした。'

/** §9.5 requiresDomain のルートで PageContext.domain が無いとき、reply に添える一文。 */
export const DOMAIN_SELECTION_REQUIRED = '一覧から対象のドメインを選んでください。'

/** §13.4 トップ画面の起動導線の呼びかけ文。「設定値」ではなく「手順」と言い切る
 *  こと（下の DNS_VALUE_MASKED_LINE のとおり、具体的なDNS設定値は本AIの
 *  対象外）。 */
export const ASSISTANT_LAUNCHER_PROMPT = '名前の候補も、設定の手順も聞けます。'
/** §13.4 起動導線ボタン。 */
export const ASSISTANT_LAUNCHER_BUTTON_LABEL = 'AIに相談する'

/** §13.1 Navigation Card のボタン文言テンプレート。 */
export function navigationCtaLabel(title: string): string {
  return `${title}へ進む`
}

/** §13.2 チャットモーダルの見出し。 */
export const ASSISTANT_MODAL_TITLE = 'AIアシスタント'

/** §7.5 タブ操作: 新しい会話を作る。 */
export const NEW_CONVERSATION_BUTTON_LABEL = '新規チャット'
/** §7.5 タブ操作: 表示中の会話を削除する。 */
export const DELETE_CONVERSATION_BUTTON_LABEL = 'チャットを削除'
/** §7.5 タブ操作: すべての会話を削除する。 */
export const DELETE_ALL_CONVERSATIONS_BUTTON_LABEL = '会話をすべて削除'

/** ChatInput の入力欄プレースホルダ。 */
export const CHAT_INPUT_PLACEHOLDER = '知りたいことや、やりたいことを入力してください'

/** §12.3 入力上限500文字に対する残り文字数表示。 */
export function remainingCharsLabel(remaining: number): string {
  return `残り${remaining}文字`
}

/** §6.5 同一オリジンの別タブが初回DL中のときの簡易排他表示。 */
export const DOWNLOAD_IN_PROGRESS_ELSEWHERE_MESSAGE = '別のタブで準備中です。'

/** §12.7 / FR-16: a line that looked like a DNS value was replaced. */
export const DNS_VALUE_MASKED_LINE =
  '（設定値はこのAIでは案内しません。DNS設定画面の「レシピ」機能をご利用ください）'

/** §6.4.1 モデル未準備のあいだに送信し、順番待ちで保存されたメッセージへ添えるヒント。 */
export const MESSAGE_STATUS_PENDING_HINT = '順番待ちです。モデルの準備が完了すると自動で送信します。'

/** メッセージの送信・生成に失敗したときのヒント（`status: "failed"`）。 */
export const MESSAGE_STATUS_FAILED_HINT = '送信に失敗しました。'

/** §17.4 回答をストリーミング生成中であることを示すヒント。 */
export const MESSAGE_STREAMING_HINT = '回答を作成しています…'

/** ChatInput 入力欄のアクセシブルラベル（視覚的には非表示、placeholder が代わりに見える）。 */
export const CHAT_INPUT_LABEL = 'AIアシスタントへのメッセージ'

/** ChatInput 送信ボタンのアクセシブルラベル。 */
export const CHAT_INPUT_SEND_BUTTON_LABEL = '送信'

/** MessageList: ユーザー発言の話者ラベル（スクリーンリーダー向け、視覚的には非表示）。 */
export const USER_MESSAGE_ROLE_LABEL = 'あなた'

/** MessageList: AI発言の話者ラベル（スクリーンリーダー向け、視覚的には非表示）。 */
export const ASSISTANT_MESSAGE_ROLE_LABEL = 'AIアシスタント'

/** §7.5 ConversationTabs 全体のアクセシブルラベル。 */
export const CONVERSATION_TABS_LABEL = '会話の切り替え'

/** §6.4.2 モデル準備中プログレスバーのアクセシブルラベル。 */
export const MODEL_PROGRESS_LABEL = 'モデル準備の進捗'

/** §13.1 Navigation Card の注意事項（Playbook.warnings）の見出し。 */
export const NAVIGATION_CARD_WARNINGS_LABEL = 'ご注意'

/** MessageList: 会話にまだ発言が無いときの案内文。 */
export const EMPTY_CONVERSATION_HINT = 'まだメッセージはありません。下の入力欄から質問してみましょう。'

/** ConversationTabs: まだ最初の発言がなく、自動タイトルが決まっていないタブの表示名（§7.5）。 */
export const NEW_CONVERSATION_DEFAULT_TITLE = '新しいタブ'

/**
 * ConversationTabs のタブに表示する名前。§7.5 の自動タイトルは最初のユーザー
 * 発言が来るまで空なので、それまでは `NEW_CONVERSATION_DEFAULT_TITLE` を出す。
 * 空文字はストア側で「まだ名前が決まっていない会話」を表す番兵でもあるため、
 * ストアの値は書き換えず表示側だけで補う。
 */
export function conversationDisplayTitle(title: string): string {
  return title.trim() === '' ? NEW_CONVERSATION_DEFAULT_TITLE : title
}

/*
 * v1.4 additions below this line (design contract §3 Quick Actions, §4.2
 * domain candidates, §5 sources/search-query). Appended, not interleaved,
 * so the pre-v1.4 copy above is untouched.
 */

/** v1.4 §3: `AssistantSlot` value 'other' - shared by every SET_SLOT action's display-name map so the wording matches wherever 'other' shows up. */
export const SLOT_VALUE_OTHER_LABEL = 'その他'

/** v1.4 §3: SUGGEST_DOMAINS Quick Action button. */
export const SUGGEST_DOMAINS_ACTION_LABEL = 'ドメイン候補を探す'

/** v1.4 §3/§5.2: RUN_WEB_SEARCH Quick Action button - names the destination engine before the click, same transparency principle as DocSourceCard. */
export function runWebSearchActionLabel(engineName: string): string {
  return `${engineName}で検索する`
}

/** v1.4 §5.1: DocSourceCard's fixed "opens an external site" note. */
export const EXTERNAL_SITE_OPEN_NOTICE = '外部サイトが開きます'

/** v1.4 §5.1/§5.2: shown near every external link (DocSourceCard and the search-query button) - the destination is not part of this service. */
export const EXTERNAL_LINK_DISCLAIMER =
  'リンク先はこのサービスの外部のサイトです。内容は各サービス提供元の責任で運営されています。'

/** v1.4 §5.1/§5.2: names the destination host before the user clicks (same transparency for curated docs and the search-engine button). */
export function externalDestinationNote(hostname: string): string {
  return `${hostname} を開きます（外部サイト）`
}

/** v1.4 §5.1: DocSourceCard list heading. */
export const DOC_SOURCES_HEADING = '出典'

/** v1.4 §4.2: rule-based candidates heading (primary, shown first). */
export const RULE_BASED_CANDIDATES_HEADING = 'おすすめ候補'

/** v1.4 §4.2: AI-proposed candidates heading (secondary, clearly separated from the rule-based list). */
export const AI_SUGGESTED_CANDIDATES_HEADING = 'AI提案'

/** v1.4 §4.2: DomainCandidateCard availability label - state 'available'. */
export const DOMAIN_AVAILABLE_LABEL = '空きあり'

/** v1.4 §4.2: DomainCandidateCard availability label - state 'taken'. */
export const DOMAIN_TAKEN_LABEL = '取得済み'

/** v1.4 §4.2: DomainCandidateCard availability label - state 'unknown' (registry did not answer). */
export const DOMAIN_AVAILABILITY_UNKNOWN_LABEL = '確認できませんでした'

/** v1.4 §4.2: honest fallback when the SUGGEST_DOMAINS action's `searchDomains` call fails outright - never a fabricated availability claim. */
export const SUGGEST_DOMAINS_FAILED_MESSAGE =
  '候補の空き状況を確認できませんでした。ドメイン検索画面から確認してください。'

/** v1.4 §5.2: heading above the copyable search-query text. */
export const SEARCH_QUERY_HEADING = '検索クエリ'

/** v1.4 §5.2: button that copies the search query text to the clipboard. */
export const COPY_SEARCH_QUERY_BUTTON_LABEL = 'コピー'

/** v1.4 §5.2: transient confirmation shown on the copy button right after a successful clipboard write. */
export const SEARCH_QUERY_COPIED_LABEL = 'コピーしました'

/** v1.4 §4.2: placeholder assistant message content while the §8.4 SUGGEST_DOMAINS click is in flight (fetchSupportedTlds/searchDomains). */
export const DOMAIN_CANDIDATES_LOADING_MESSAGE = 'ドメイン候補の空き状況を確認しています…'

/** v1.4 §4.2: assistant message content once SUGGEST_DOMAINS produced at least one available candidate. */
export const DOMAIN_CANDIDATES_READY_MESSAGE = 'ドメインの候補をご案内します。'

/** v1.4 §4.2: assistant message content when the availability check succeeded but found no available candidate (distinct from the degraded/failed case). */
export const DOMAIN_CANDIDATES_EMPTY_MESSAGE =
  '条件に合う空きドメインが見つかりませんでした。ドメイン検索画面で他のキーワードもお試しください。'

/** v1.4 §4.2: DomainCandidateList - the 申し込む button. */
export const DOMAIN_CANDIDATE_ORDER_BUTTON_LABEL = '申し込む'

/** v1.4 §4.2: shown in place of the 申し込む button when `AssistantDomainCandidate.orderable` is false (the TLD has no pricing entry). */
export const DOMAIN_CANDIDATE_NOT_ORDERABLE_NOTE = 'このTLDは現在お申し込みいただけません。'

/*
 * "Never dead-end" fallback additions below this line (routing/ruleBasedIntent.ts,
 * useAssistantChat.ts's applyFallback, actions.ts's fallbackActions). Appended,
 * not interleaved, so the copy above stays untouched.
 */

/**
 * Short, honest note prefixed to a reply built from `routing/ruleBasedIntent.ts`'s
 * deterministic guess rather than the model - shown whenever the model's own
 * output could not be parsed/validated but a rule-based guess still produced
 * a usable answer, so the user is never told a simplified answer came from
 * full understanding of their message.
 *
 * ⚠️ Reworded after a browser report. The old text was 「うまく聞き取れなかったので、
 * 簡単な案内でお答えします。」 - "I could not make out what you said" - which is a
 * claim about the USER'S message, and it was false: 「Webサイト作りたい」 was
 * understood perfectly, by `classifyIntent`, and answered correctly. What
 * failed was the model, an internal detail the user cannot see and did not
 * cause. Because a 0.6B model's wire-format output fails often (§0.4.4 決定
 * 14・17〜19・21・22), that false apology was landing on a large share of
 * otherwise-correct answers and reading as "this assistant is broken".
 *
 * The replacement keeps the honesty the prefix exists for - it still says this
 * is the simplified path, so a user is never told a rule-based answer came
 * from full understanding - without blaming the user for a failure that was
 * ours.
 */
export const RULE_BASED_FALLBACK_PREFIX = 'かんたんな案内でお答えします。'

/**
 * `fallbackActions`' generic shortcut buttons (`actions.ts`) - each button's
 * label doubles as the exact phrase re-sent through `sendMessage` when
 * clicked (reusing `SET_SLOT`'s existing "re-send `action.label`" behaviour;
 * see `useAssistantChat.ts`'s `runAction`), so these must stay natural,
 * self-contained sentences a user could have typed themselves.
 */
export const FALLBACK_SHORTCUT_PUBLISH_WEBSITE_LABEL = 'Webサイトを公開したい'
export const FALLBACK_SHORTCUT_SETUP_EMAIL_LABEL = 'メールを使いたい'
export const FALLBACK_SHORTCUT_SEARCH_DOMAIN_LABEL = 'ドメインを探したい'
export const FALLBACK_SHORTCUT_EXPLAIN_TERMS_LABEL = '用語を知りたい'

/**
 * `POST_PURCHASE_NEXT_STEPS`' branch buttons (`actions.ts`'s
 * `nextStepBranchActions`). Same mechanism and the same constraint as the
 * fallback shortcuts above - each label is also the user-visible sentence the
 * turn is answered as - but a different situation: these are shown when the
 * intent WAS understood ("you have the domain and want to know what's next")
 * and only the concrete goal is missing, so they name the four goals the
 * service can actually carry out from here.
 *
 * `NEXT_STEP_EXPLAIN_DNS_LABEL` is deliberately part of the same set: the
 * reported request was to be able to move into 「DNSの話」 from this question,
 * and a user who does not yet know what DNS is cannot pick between the other
 * three.
 */
export const NEXT_STEP_CONNECT_WEBSITE_LABEL = 'Webサイトを公開したい'
export const NEXT_STEP_SETUP_EMAIL_LABEL = '独自ドメインのメールを使いたい'
export const NEXT_STEP_EXPLAIN_DNS_LABEL = 'DNSの仕組みを知りたい'
export const NEXT_STEP_VIEW_DOMAIN_LABEL = '取得したドメインの設定状況を見たい'

/**
 * v1.4 "never dead-end" revision: appended by `useAssistantChat.ts`'s
 * `runAction` when a `SUGGEST_DOMAINS` click has no keyword to search with
 * (no validated Playbook slot value, and `routing/domainLabelHints.ts` found
 * nothing in the conversation's first message) - asked instead of silently
 * calling `suggestDomains` with an empty list. Deliberately the same wording
 * as `routing/playbooks.ts`'s `KEYWORD_SLOT_QUESTION` (not imported directly
 * - `playbooks.ts` is owned by another wave) so the user sees one consistent
 * question regardless of which path asked it.
 */
export const SUGGEST_DOMAINS_ASK_KEYWORD_MESSAGE =
  'どんなサイトやサービスのためのドメインをお探しですか？キーワードを教えてください（例: パン屋, カフェ）。'

/*
 * v1.5 "ask what kind of site" revision below this line (team-lead report:
 * the assistant should ask what the site is FOR, with concrete examples and
 * one-click purpose buttons, instead of only asking for a bare keyword).
 * Appended, not interleaved, so the copy above stays untouched -
 * `SUGGEST_DOMAINS_ASK_KEYWORD_MESSAGE` is superseded by the message below as
 * the text `useAssistantChat.ts`'s `runAction` actually appends for the
 * SUGGEST_DOMAINS empty-keywords case, but is kept exported/unremoved per
 * this module's append-only convention.
 */

/**
 * v1.5: supersedes `SUGGEST_DOMAINS_ASK_KEYWORD_MESSAGE` as the message
 * `useAssistantChat.ts`'s `runAction` appends for a SUGGEST_DOMAINS click
 * with no keyword - asks what the site is FOR, with concrete examples, and is
 * always paired with `actions.ts`'s `purposeShortcutActions()` one-click
 * purpose buttons (`routing/domainLabelHints.ts`'s `PURPOSE_SUGGESTIONS`) so
 * a beginner does not have to type an answer.
 */
export const SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE =
  'どんなサイトを作りますか？（例: ポートフォリオ / ブログ / お店 / 会社 / 写真）'

/*
 * "This is AI" notice below this line (team-lead request, verbatim user
 * report: 「AIだからっていう注意書きを見えるところ（チャット欄の下とか）に入れよう。」) - a
 * persistent, always-visible disclosure near `ChatInput` (see the comment on
 * where it is rendered in `ChatInput.tsx`), not inside the scrolling
 * `MessageList`, so it can never scroll out of view. Appended, not
 * interleaved, per this module's append-only convention.
 */

/**
 * Short, beginner-facing disclosure that a reply is AI-generated and can be
 * wrong. Deliberately points the user at the one thing that IS reliable -
 * what the screen itself shows - rather than a bare "AI can make mistakes"
 * hedge, which would be true but give the user nothing to act on.
 */
export const AI_GENERATED_CONTENT_NOTICE =
  'AIの回答には誤りが含まれることがあります。操作は画面の表示内容を確かめてから行ってください。'

/*
 * v1.7 "show me more candidates" additions. Appended, not interleaved, per the
 * append-only convention above.
 */

/**
 * Quick Action attached to a candidate list, offering the NEXT page of
 * candidates. Distinct wording from `SUGGEST_DOMAINS_ACTION_LABEL`
 * (「ドメイン候補を探す」): by this point candidates are already on screen, so
 * "search for candidates" would read as if nothing had happened yet.
 *
 * ⚠️ The button exists so the user never has to guess that typing works. The
 * reported failure was 「さらに見たい」 typed after a candidate list, which
 * dead-ended at §11.5's fixed apology - §30's rule is that the app offers the
 * next step itself rather than waiting to be asked.
 */
export const SUGGEST_MORE_DOMAINS_ACTION_LABEL = '別の候補を見る'

/**
 * Shown when another page was requested but the search genuinely has nothing
 * left that this screen can order. Distinct from
 * `DOMAIN_CANDIDATES_EMPTY_MESSAGE` ("we found nothing at all"): here the user
 * HAS seen candidates, so the honest statement is that these were the last
 * ones - never an invented extra suggestion to fill the space.
 */
export const DOMAIN_CANDIDATES_NO_MORE_MESSAGE =
  'これ以上の候補は見つかりませんでした。別のキーワードでも探せます。'

/*
 * v1.7 "check the domain the user actually asked about" additions.
 */

/** Answer for a specific domain the user named, verified available. `price` is the first-year figure. */
export function askedDomainAvailableMessage(domain: string, priceJpy: number | null): string {
  const price = priceJpy === null ? '' : `（初年度 ¥${priceJpy.toLocaleString('ja-JP')}）`
  return `${domain} は取得できます${price}。`
}

/**
 * Answer for a domain that is already registered.
 *
 * Deliberately followed by alternatives rather than left as a bare "no": the
 * user asked because they want A domain, and 取得済み alone ends the
 * conversation on a wall (§35's "never dead-end").
 */
export function askedDomainTakenMessage(domain: string): string {
  return `${domain} はすでに取得されています。近い名前の候補をお探しできます。`
}

/**
 * ⚠️ Neither "available" nor "taken" may be claimed when the registry did not
 * answer. §31's honesty rule cuts both ways - inventing a "taken" is as wrong
 * as inventing availability.
 */
export function askedDomainUnknownMessage(domain: string): string {
  return `${domain} の空き状況を確認できませんでした。ドメイン検索画面でもう一度お試しください。`
}

/** Quick Action offered beside a 取得済み answer - seeded with the same label the user asked about. */
export const SUGGEST_ALTERNATIVES_ACTION_LABEL = '近い名前の候補を見る'
