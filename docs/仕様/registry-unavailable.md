# レジストリ一時接続不能（503）対応 仕様

**最終更新**: 2026-08-27
**ステータス**: 実装済み（サーキットブレーカー＋dev注入スイッチ＋poll告知メンテナンス）
**親ドキュメント**: `registrar-spec-draft.md`（チーム作成の仕様書草案・公開版では非収録） §6.9

記法は親ドキュメント §0.2 に従う（✅ 確定 / 🔬 要実測 / 🤔 未決 / ⚠️ 落とし穴）。

---

## 1. 背景と前提

✅ **前提（2026-08-26 改訂）**

- HTTP 503 は「Service Unavailable」であり、**メンテナンスとは断定できない**（過負荷・再起動・デプロイでも返る）。旧版の「503=メンテナンス」という前提はこの改訂で撤回した
- ただし503には**「リクエストは処理されずに拒否された＝未実行」**という重要な性質があり、これは原因によらず成り立つ（`transport`＝実行されたか不明、との決定的な違い）
- 検出はリクエスト駆動。メンテナンス予定を事前照会するエンドポイントは存在しない

**ユーザーに伝えるべきこと（ゴール）**

> 「このTLDのレジストリにはいま接続できない状態が続いているので、一時的に購入できない」

- 断定できないこと（メンテナンスかどうか）は言わない。分かっていること（接続できない状態が続いている）だけを言う — §6.7 の正直原則
- 該当TLDを検索結果・TLD一覧から**消さない**
- 影響を受けないレジストリのTLDは通常どおり検索・購入できる（部分縮退）

✅ **追補（2026-08-27）**: 「メンテナンスと断定できる正のシグナル」を1つだけ導入した。レジストリ自身が**pollキューで事前に告知したメンテナンス窓**である（§3.5）。503からの推定は引き続き禁止のまま、告知があった場合だけ表示を「メンテナンス中」へ昇格する — 旧 §9 M-2 が予期していた昇格の実現。

## 2. 設計原則

1. **単発の503では判断しない**。ブリップ（瞬間的な503）と持続的な接続不能は別物。1リクエストの中では既存の短いリトライ（冪等コマンドのみ3回・計1秒弱）だけを行い、**60秒の判定はリクエストをまたいだサーキットブレーカー**（§3）が行う
2. **2段階の表示**。判定前の503は既存の「？ 確認できませんでした」（本当に分からないだけ）。判定後だけ「⏳ 一時的に購入できません」に昇格する。**強い主張には強い根拠**
3. **叩き続けない**。接続不能と判定したレジストリへはリクエストを発行せず即答（fail fast）。復帰は30秒ごとのプローブが自動で検知する
4. **部分縮退**。片方のレジストリの接続不能が、もう片方のTLDの検索・購入を巻き込まない

## 3. サーキットブレーカー（BRIDGE層）

実装: `functions/src/bridge/registryHealth.ts` ＋ `eppClient.ts` 組込み。

### 3.1 状態と遷移

Firestore `counters/registryHealth_{registry}`（レジストリ単位・全インスタンス共有）:

```
{ state: "ok" | "unavailable", consecutive503, firstFailureAt, lastFailureAt, lastProbeAt }
```

```
        503（成功を挟まず）が firstFailureAt から 60秒以上継続
  ok ────────────────────────────────────────────────────▶ unavailable
   ◀────────────────────────────────────────────────────
        30秒ごとのプローブ（実リクエスト1本）が成功
```

- ✅ 定数: `OUTAGE_WINDOW_MS = 60_000` / `PROBE_INTERVAL_MS = 30_000`
- **最初の503は絶対に回路を開かない**（その503自身のタイムスタンプが窓の起点になるため）。ブリップは昇格しない
- 503以外の**応答があった**失敗（業務エラーの4xx含む）は「到達可能」の証拠としてストリークをリセットする。タイムアウト・応答なしはヘルス判定の対象外（🤔 将来 transport も混ぜる判断はあり得る）
- ヘルス記録の失敗は常に「閉」側に倒す（ヘルス機構自体がコマンドを壊さない）

### 3.2 EppClient の振る舞い

- `send()` 冒頭でゲート照会: **open → レジストリに触れず即 throw**（`RegistryError{kind:"serviceUnavailable", circuitOpen:true}`、RegistryLog に "circuit open" と記録）。probe → 1本だけ通す
- `attempt()` の結果: 503 → `record503()`（回路が開いたら throw する error に `circuitOpen:true`）／応答あり → `recordSuccess()`
- `classify()`: `503 → "serviceUnavailable"`。retryable は transport 同様 true（冪等コマンドのみ再送。503=未実行なので安全）

### 3.3 エラー分類（改訂後）

| kind | 意味 | retryable | circuitOpen |
|---|---|---|---|
| `transport` | ネットワーク断・タイムアウト・503以外の5xx。**実行されたか不明** | ✅ | — |
| `serviceUnavailable` | 503。**未実行が保証される** | ✅ | 単発=false / 判定済み=true |

⚠️ **落とし穴**: 変更系で503を `transport` と同一視すると `updateMirrors` のリコンサイル（「更新結果を確認できませんでした」）に不要に落ちる。503は未実行なので、そのまま「時間をおいて再度」と案内してよい。

## 3.5 告知メンテナンス（poll通知・2026-08-27追加）

実装: `functions/src/bridge/registryMaintenance.ts` ＋ `domain/maintenanceNotifications.ts` ＋ `eppClient.ts` / `pollWorker.ts` 組込み。

### 3.5.1 シグナルと前提

- レジストリはメンテナンス開始**前**に poll メッセージで告知する（実ダウン中は poll 自体が503のため、告知は必然的に事前受信）
- 🔬 **メッセージ形式は未文書化**（両レジストリの OpenAPI が定める msgType は `domain:transfer` のみ）。ハンドラは `transferNotifications.ts` の未文書形式フォールバックと同じ流儀で防御的に読む:
  - 型判定: 正規化 msgType の完全一致（`registry:maintenance` 等の想定綴り）＋**キーワードフォールバック**（生 msgType に `/mainten|メンテ|保守/i`）
  - 窓: `windowStart/startAt/…/start/from` と `windowEnd/endAt/…/end/until` を寛容にパース（ISO / 空白区切り / epoch 秒・ミリ秒）
  - 終了通知: `op/status/…` が end 系（`completed`/`resumed` 等）なら解除。⚠️ `extended`（延長）を終了と誤読しない（裸の "end" は完全一致か接尾辞のみ）
  - 生ペイロードは `pollMessages` と `rawPayload` に残る → 実測後に判定条件だけ調整できる

### 3.5.2 状態とライフサイクル

Firestore `counters/registryMaintenance_{registry}`:

```
{ active, windowStart, windowEnd, msgId, msgType, note, rawPayload, announcedAt, lastProbeAt, clearedAt, clearedBy }
```

```
告知受信 ──▶ active（開始前: 通常運転のまま）
  窓内（now < windowEnd）: 全コマンド即答で拒否・プローブなし・poll もスキップ
  窓明け（now ≥ windowEnd）: ゲート解放 → 最初の実応答（poll 含む）で解除（clearedBy: "contact"）
  終了時刻なし: 30秒ごとのプローブのみ通し、成功で解除
  終了通知受信: 即解除（clearedBy: "notification"）
```

- **回路ブレーカーと独立**（`circuitOpen` とは別フラグ）。窓内はそもそもリクエストを発行しないので、無駄な再接続・60秒判定は発生しない — 本仕様の主目的
- 開始前の疎通成功は告知を取り消す証拠にならない（解除しない）
- 窓明け後にまだ落ちていれば通常の503→回路判定に戻る（告知時間を過ぎた「メンテナンス中」は主張しない — 正直原則）
- 判定エラーは常に「なし」側に倒す（メンテナンス機構自体がコマンドを壊さない）

### 3.5.3 poll ワーカーとの関係

- 窓内の drain は `stoppedBecause: "maintenance"` で即終了（エラー扱いにしない）
- 窓明け後の最初の poll（2分周期）が復旧プローブを兼ね、成功すれば解除される

## 4. エラー伝搬の共通契約（API層 → フロント）

- `toHttpsError()`: `serviceUnavailable` → `HttpsError("unavailable", "レジストリに接続できない状態です。しばらく時間をおいてから再度お試しください。")`。**`details: {reason:"registry-unavailable", registry}` は `circuitOpen` のときだけ**付与（単発503は generic な接続失敗と区別しない — 断定しないため）
- 告知メンテナンス（`RegistryError.maintenance`）はさらに強い主張として先に判定: `HttpsError("unavailable", "レジストリがメンテナンス中のため、現在この操作を行えません。", {reason:"registry-maintenance", registry, until})`（`until` は告知された終了時刻、なければ null）
- フロント `ApiErrorKind`: `'registryUnavailable'` / `'registryMaintenance'`（`callable.ts` が details マーカーで判別、後者は `maintenanceUntil` を保持）。マーカーなしの `unavailable` は従来どおり `'network'`

## 5. ドメイン検索画面

### 5.1 バックエンド `searchDomains`

- `Promise.allSettled` で部分縮退（実装済み）
- rejected グループのうち **`maintenance` のもの**は `maintenance: string[]` へ、**`circuitOpen` のもの**は `unavailable: string[]` へ names を積む。単発503や他の失敗は欠落させ、フロントが「？」に折る

```jsonc
{ "results": [...], "unsupported": [...], "unavailable": ["example.xyz", ...],
  "maintenance": ["example.shop", ...], "maintenanceUntil": "2026-08-30T03:00:00Z" | null }
```

### 5.2 フロントの第4・第5状態

`DomainAvailabilityState = 'available' | 'taken' | 'unknown' | 'unavailable' | 'maintenance'`

| フェーズ | 表示 |
|---|---|
| 判定前（単発503） | 「？ 確認できませんでした」（既存の unknown） |
| 判定後（回路オープン） | 「**⏳ 一時購入不可**」セル（選択不可）＋凡例＋infoバナー |
| 告知メンテナンス窓内 | 「**🔧 メンテナンス中**」セル（選択不可）＋凡例＋infoバナー（終了予定時刻つき） |

### 5.3 文言（実装済み）

| 場面 | 文言 |
|---|---|
| セル | ⏳ 一時購入不可（aria: 「{domain} はレジストリに接続できないため一時的に購入できません」） |
| 凡例 | ⏳ 一時的に購入できません（レジストリ接続不能） |
| バナー | ただいま一部のレジストリに接続しづらい状況です。該当するTLD（⏳）は表示していますが、一時的に購入できません。時間をおいて改めてお試しください。 |
| 共通（ApiError既定 / toHttpsError） | レジストリに接続できない状態です。しばらく時間をおいてから再度お試しください。 |
| 簡単モード候補バッジ | ⏳ 一時的に取得できません |
| セル（メンテナンス） | 🔧 メンテナンス中（aria: 「{domain} はレジストリがメンテナンス中のため購入できません」） |
| バナー（メンテナンス） | 一部のレジストリがメンテナンス中です。該当するTLD（🔧）の検索結果は表示できず、購入もできません。〔終了予定: {時刻}。〕終了後に改めてお試しください。 |
| 共通（メンテナンス） | レジストリがメンテナンス中のため、現在この操作を行えません。（注文フローは `registryMaintenance`/`registryUnavailable` をこの確定文言で表示） |
| 簡単モード候補バッジ（メンテナンス） | 🔧 メンテナンス中のため取得できません |

### 5.4 TLD一覧の維持

- 接続不能中は `hello` も503になるが、TLD→レジストリのマップはFirestoreミラー＋プロセスキャッシュで維持される（`registryRouter.ts`）。静的フォールバックは実測済み22TLD
- ⚠️ **落とし穴（2026-08-27 実機で発見・修正済み）**: hello が**片方だけ**成功すると、`buildTldMap` が縮んだマップ（成功側のTLDのみ）を構築してミラーを上書きし、接続不能側のTLDが一覧から消えていた。対策: hello に失敗したレジストリのTLDは**前回マップ（プロセスキャッシュ→ミラー）から引き継いで**マージし、そのマージ結果をミラーする。次に hello が成功した時点で実データに更新される（回帰テスト: `registryRouter.test.ts`「keeps an unreachable registry's TLDs」）

## 6. その他の影響箇所

- **候補提案**: 検証済み候補は `available` のみ表示のため、⏳のTLDは混ざらない
- **簡単モード**: `checkCandidates` は「空きゼロの原因がすべて unavailable/taken」のときだけ候補ラベルを `unavailable` にする。選択ボタンは無効化
- **新規登録/更新（決済前ブロック）・変更系・移管・Poll・会員登録**: 旧版 §6 の方針を踏襲（文言のみ「接続できない状態」表記に変更）。回路オープン中はどの操作も即答で弾かれるため、決済前ブロックは自然に成立する
- 登録後のNS付与（`domain:update`、親 v0.3.4 案A）が503でも、案Aの原則どおり注文は `done` のまま `Order.result.nameserverError` に記録

## 7. dev注入スイッチ

親 §10.2「BRIDGE層の故障注入スイッチ」・§12 デモの実体。実装済み。

**残留対策（2026-08-27追加）**: エミュレータFirestoreの状態は全ブランチ共有で、export/importボリューム経由でコンテナ再起動もまたぐ（古いスナップショットから復活することさえある）。無期限のdevフラグは「誰も触っていないのに503/メンテ中」事故を起こすため、**dev注入は必ず自動失効する**設計に統一した。失効判定は読み取り時に行う（FirestoreのTTLポリシー・追加read/write/deleteは使わない）。

### 7.1 503強制返却（`devForceRegistry503`）

- **callable `devForceRegistry503`**（`functions/src/api/devForceRegistry503.ts`）: `get`/`set`。フラグは `counters/devForce503`。**エミュレータ外では `failed-precondition` で拒否**。認証不要（検索画面は公開）
- **自動失効**: ON時に `{registry}ExpiresAt`（30分後、`FORCE_503_TTL_MS`）を刻印。読み取り時に期限切れ＝OFF扱い。**expiresAtのない旧形式フラグ（古いエミュレータexportの復活形）もOFF扱い**で自己修復する。応答の `expiresAt` をパネルが「〜HH:mm 自動OFF」と表示
- **`eppClient.attempt()`**: フラグONなら fetch せず `httpStatus=503` を合成（`"simulated 503 (dev switch)"`）。2段判定・RegistryLog・ヘルス判定が実経路のまま働くので、**60秒後に回路が開く過程までデモできる**
- **モックパネル**（`MockControlPanel.tsx`）: 「レジストリ障害シミュレーション（503を強制返却）」セクション。レジストリごとのスイッチ＋回路状態（「接続不能と判定済み」）表示。この項目はMSWでなく実バックエンドへの注入である旨を注記

**デモ手順**: パネルで kitaqnic をON → 検索（「？」）→ 60秒後に再検索（「⏳」＋バナー）→ OFF → 30秒以内のプローブで自動復帰。

### 7.2 メンテナンス告知注入（`devRegistryMaintenance`・2026-08-27追加）

外部モックAPIのモード切替に頼らず、§3.5 の告知メンテナンスを検証するためのスイッチ。

- **callable `devRegistryMaintenance`**（`functions/src/api/devRegistryMaintenance.ts`）: `get`/`set`/`clear`。`set` は `registry` と `durationMinutes`（1〜180）を取り、**poll告知が書くのと同一の記録** `counters/registryMaintenance_{registry}` に「今から durationMinutes 分」の窓を書く（`msgType: "dev:maintenance"`）。ゲート・`searchDomains`・🔧表示が実経路のまま働く。エミュレータ外拒否は §7.1 と同じ
- **消し忘れ対策は構造で担保**: 検証用の窓は必ず終了時刻を持つため、放置しても窓明けで自動解除（§3.5.2 のライフサイクルそのまま）。`clear` で即時解除も可能
- **状態表示は副作用なし**: `get` は `maintenanceSummary()`（読み取り専用）を使う。`checkMaintenanceGate` 経由だと無期限窓のプローブ枠を消費してしまう（§3.5.3 の二重ゲート罠）ため使わない
- **モックパネル**: 「メンテナンス告知シミュレーション（🔧表示の検証）」セクション。窓の長さ（5/15/30/60分）＋レジストリごとの開始/解除ボタン＋「メンテナンス中（〜HH:mm）」表示

**キャッシュ修正（2026-08-27）**: `checkMaintenanceGate` はプロセス内キャッシュ `lastKnownInactive` による早期return を廃止し、毎回Firestoreを読む（回路ブレーカーの `checkGate` と同じ方針）。窓は**別プロセス**（pollワーカー・devパネル）が記録するため、キャッシュ済みの「メンテナンスなし」が新しい窓をコールドスタートまで隠すバグがあった。キャッシュは `noteRegistryAnswered` の成功ホットパス専用に戻した。

## 8. テスト（実装済み）

- `test/integration/registryHealth.test.ts` — 60秒窓で回路が開く／オープン中はHTTP0本で即答／30秒後のプローブ成功で自動復帰。60秒待ちはFirestoreの `firstFailureAt` を過去に直接シードして代替
- `test/integration/eppClient.test.ts` — 単発503: `serviceUnavailable`・retryable・`circuitOpen=false`・冪等リトライ3回
- `test/integration/searchDomains.test.ts` — 単発503は `unavailable[]` に載らず欠落／回路オープンで載る（もう片方は無傷・追加リクエスト0本）／両系オープン
- `test/integration/devForce503.test.ts` — get/set、BRIDGE内で完結（実HTTPが飛ばない）、エミュレータ外拒否、**自動失効**（ONで30分後のexpiresAt刻印／期限切れはOFF扱い／expiresAtなしの旧形式もOFF扱い）
- `test/integration/devRegistryMaintenance.test.ts` — 窓を開くとHTTP0本で `maintenance:true`／解除で復帰／状態読み取りはプローブ枠を消費しない／引数検証／エミュレータ外拒否
- `test/integration/registryMaintenance.test.ts` — 窓内はHTTP0本で即答（`maintenance:true`）／**別プロセスが記録した窓もコールドスタートなしで見える**／開始前は通常運転／窓明けの疎通で解除／終了時刻なしは30秒プローブ／drainの `stoppedBecause:"maintenance"`／poll通知からの窓記録（キーワードフォールバック含む）／終了通知で解除／`searchDomains` の `maintenance[]`
- `test/unit/maintenanceNotifications.test.ts` — 綴り・窓フィールド・epoch・ネスト・終了判定（`extended` を終了と誤読しない）のパース網羅
- フロント: 検索フローの⏳/🔧表示・バナー、パネルのスイッチが callable を呼ぶこと、`callable.test.ts` の details マーカー判別
- スタブレジストリの注入は `stub.force503 = true`（旧 `maintenance` スイッチを改名。**503はこの用途専用、一時的transport障害の注入は500**）

## 9. 未決事項（TBD）

| # | 内容 | 現時点の判断 |
|---|---|---|
| M-1 | 実レジストリの503ボディ形式 | 🔬 実測。実装はHTTPステータスのみで分類（ボディ非依存）にしてある |
| M-2 | ~~`Retry-After` ヘッダの有無~~ | ✅ **解決（2026-08-27）**: poll告知メンテナンス（§3.5）で昇格を実現。終了予定時刻は告知ペイロードから取得 |
| M-7 | 実レジストリのメンテナンス通知の実形式（msgType・ペイロード） | 🔬 実測待ち。ハンドラはキーワード＋寛容パースで受け、生ペイロードを保存済み。実測したら `MAINTENANCE_POLL_MSG_TYPES`・キー一覧を確定形に絞る |
| M-3 | 検索前のプロアクティブ表示（トップページのバナー） | ヘルス状態はFirestoreにあるので `listTlds` に相乗せ可能。第2段 |
| M-4 | カート内ドメインへの⏳警告表示 | 第2段 |
| M-5 | タイムアウト・他5xxもヘルス判定に混ぜるか | 完全沈黙型の障害はtimeoutで来るため価値あり。判定閾値を分けて検討 |
| M-6 | 60秒/30秒の妥当性 | デモ・実測で調整。定数は `registryHealth.ts` に集約済み |
