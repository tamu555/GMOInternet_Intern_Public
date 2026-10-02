# 空き待ち通知（空いたらお知らせ） 仕様

**最終更新**: 2026-08-27
**ステータス**: 実装済み
**関連ドキュメント**: [`registry-unavailable.md`](./registry-unavailable.md)（メンテナンス・接続不能の表示）、親 `registrar-spec-draft.md`（チーム作成の仕様書草案・公開版では非収録） §6.7（正直原則）

記法は親ドキュメント §0.2 に従う（✅ 確定 / 🔬 要実測 / 🤔 未決 / ⚠️ 落とし穴）。

---

## 1. 背景と設計判断

✅ **前提**: いま購入できないドメインは3種類ある。

1. **使用中**（他者が登録済み・2302）
2. **🔧 メンテナンス中**（レジストリが poll で告知した窓の内側。空きの確認自体ができない）
3. **⏳ 一時購入不可**（503が60秒継続し回路オープンと判定。同じく確認不能）

当初案は「メンテナンス中でも注文を受け付け、窓明けに自動プロビジョニングする」だったが、
**空きが確認できないまま疑似決済させる**ことになり、§6.7 の正直原則と衝突する
（取れなかったら返金扱い＝「支払ったのにドメインがない」の変種を自ら作る）。

✅ **採用した設計**: 決済を伴わない「**空き待ち通知**」に一本化する。

- 登録時に**課金も予約も発生しない**。バックエンドが空きを再確認し、確認でき次第マイページで知らせる
- 決済は常に「空きが確認できた状態」からの**通常の注文フロー**でのみ発生する
- 上記3種類すべてを同じ UX で扱える（ユーザーにとってはどれも「いま買えない。空いたら教えて」）

⚠️ **通知は取得を保証しない**。同じ名前を複数人が監視でき、通知後は早い者勝ち。
このため「空きが確認できました」には**必ず**「空き状況は変動する場合があります」を添える
（`WATCH_AVAILABILITY_CAVEAT`、mypageMessages.ts）。「？ 確認できませんでした」（単発の通信失敗）には
ボタンを出さない — 名前についての事実ではなく通信の失敗であり、約束できることがないため。

## 2. データモデル

Firestore `watches/{uid}__{domainName}`（注文と同じ複合キー規律。二重登録防止であって
「1ドメイン1人」ではない — uid が違えば別ドキュメント）:

```
{ uid, domainName, registry, state, createdAt, updatedAt,
  expiresAt, lastCheckedAt, availableAt }
```

状態機械（実装: `functions/src/domain/watches.ts`）:

```
watching ──(check: 空き)──▶ available ──(check: また使用中)──▶ watching
   │                            │
   │                            └─(本人が取得済み)──▶ fulfilled
   ├─(本人が取得済み)──▶ fulfilled
   ├─(expiresAt 経過)──▶ expired      ※読み取り時にも判定（遅延書き込み）
   └─(本人が解除)──▶ cancelled
```

- ✅ 定数: `MAX_ACTIVE_WATCHES = 10`（1会員の watching+available 上限）/
  `WATCH_TTL_DAYS = 30`（自動失効）/ `SWEEP_MIN_INTERVAL_MS = 60_000`
- `available` からまた使用中に戻ったら **watching に再武装**する（通知は取り下げ、次に空いたらまた知らせる）
- 使用中の名前は `domains` ミラーを1件読んで**本人の取得か**を判定し、本人なら `fulfilled`
  （「他のお客様が取得」と誤解させない）

## 3. 巡回スイープ（`runWatchSweep`）

- **経路は2つ**: ①5分周期の `pollWorker`（`onSchedule`、`force: true` でスロットル無視）
  ②`drainPollQueue` callable（エミュレータ・デモ用。マイページが読み込みごとに叩くため
  **60秒スロットル**が必須 — Firestore読み取り増加とレジストリ負荷の再発防止）
- レジストリごとに独立して `domain:check`（25件ずつ、`clTRID: APP-WATCH-*`）。
  片系の障害はもう片系の監視を止めない（searchDomains と同じ部分縮退）
- ⚠️ **メンテナンス窓・回路オープン中のレジストリはスキップ**する。判定は EppClient の
  実ゲートに任せる（最初の check が HTTP 0本で即 throw → `skipped: [{registry, reason}]`）。
  状態照会に `checkMaintenanceGate` を使わないこと（無期限窓のプローブ枠を消費する
  「二重ゲート罠」、registry-unavailable.md §7.2）
- 窓明け後の最初のスイープが復旧後の空き確認を兼ねる — メンテナンス起因の空き待ちは
  ここで自然に解決する

## 4. API（callable）

| callable | request | answer | 備考 |
|---|---|---|---|
| `addWatch` | `{domainName}` | `{watch, alreadyWatching}` | 登録済みは冪等応答。上限超過は `failed-precondition`。非対応TLDは `invalid-argument` |
| `listWatches` | `{}` | `{watches}` | cancelled は返さない。新しい順 |
| `cancelWatch` | `{domainName}` | `{ok}` | 未登録は `not-found` |

いずれも要ログイン（`requireActiveUser`）。`addWatch` のみ TLD ルーティングのため
`REGISTRY_SECRETS` を宣言する。

## 5. UI

### 5.1 検索画面（DomainSelectTable / DomainSearchPage）

- 「✕ 使用中」「🔧 メンテナンス中」「⏳ 一時購入不可」のセルに **「空いたら通知」ボタン**を表示
  （登録済みなら「空き待ち登録済み」）。「？」には出さない（§1）
- 未ログインでクリック → `returnTo` を保存して `/login` へ（RequireAuth と同じ流儀）
- 登録成功 → 上部バナー「{domain} を空き待ちに登録しました。購入できる状態を確認でき次第、
  マイページでお知らせします。」

### 5.2 マイページ（MyPage）

- `available` の watch → **通知バナー**「空き待ちのドメインが購入できるようになりました」
  ＋変動注意文言＋「購入手続きへ進む」（`/domains/new?domain=X` = 通常の申込フォーム）＋「空き待ちを解除」
- `watching` / `expired` → 「空き待ち通知」一覧（確認中/期限切れの表示＋解除ボタン）
- `fulfilled` は一覧に出さない（保有ドメイン一覧そのものが答え）
- 既存の 30秒ポーリング `load()` に相乗り（新しいポーリングは増やさない）。`load()` 冒頭の
  `drainPollQueue` がサーバー側スイープ（スロットル付き）を兼ねる

## 6. デモ手順（エミュレータ）

1. **メンテナンス起因**: モックパネルで `devRegistryMaintenance` の窓を開く → 検索で 🔧 →
   「空いたら通知」→ 窓を `clear` → マイページを開く（drain がスイープを起動）→ 通知バナー
2. **使用中起因**: 別アカウントで対象ドメインを廃止 → `expireGracePeriod` 相当の解放を待つ
   （スタブ/実レジストリの猶予期間に依存）→ スイープで `available`

## 7. テスト

- `functions/test/integration/watches.test.ts` — 登録の冪等性／非対応TLD拒否／10件上限／
  watching→available→watching の往復／fulfilled 判定／メンテナンス窓のレジストリを
  **HTTP 0本で**スキップ（他系は継続）／TTL失効はレジストリに問い合わせない／
  スロットル（force で無視）／解除と一覧／終了済み watch の再登録
- フロント: fakeBackend に `addWatch`/`listWatches`/`cancelWatch` ハンドラと
  `markWatchAvailable()`（スイープの再現）を追加

## 8. 未決事項（TBD）

| # | 内容 | 現時点の判断 |
|---|---|---|
| W-1 | 通知からのワンクリック購入（申込フォームの事前入力強化） | 現状は通常フォームへの遷移のみ。第2段 |
| W-2 | 実レジストリでの解放タイミング（purge後にcheckがavail=trueになるまでのラグ） | 🔬 実測待ち |
| W-3 | 空き確認の通知チャネル追加（メールは実送信なしのため対象外） | マイページ表示のみで確定（当面） |
