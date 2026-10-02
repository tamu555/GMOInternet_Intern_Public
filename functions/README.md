# functions — API 層 / BRIDGE 層

ドメイン登録（create）のバックエンド。図は
[`docs/api-flow-diagrams.html`](../docs/api-flow-diagrams.html) の FIG.1 / FIG.2、
仕様は `registrar-spec-draft.md`（チーム作成の仕様書草案・公開版では非収録） §3〜§6。

## レイヤ構成

```
api/        Callable Functions（画面から直接呼ばれる境界）
domain/     ユースケース・Order 状態機械・入力制約
bridge/     レジストリ差分の吸収（ここだけが fetch を呼ぶ）
config/     リージョン・シークレット・Admin SDK
```

`bridge/` を経由しない `fetch` を書くと、2段判定（HTTP ステータス +
`result.code`）と RegistryLog がその呼び出しだけ失われる。必ず
`EppClient` を通すこと（仕様書 §4.4）。

## 公開している関数

| 関数 | 用途 | 認証 |
|---|---|---|
| `searchDomains` | `domain:check` を両レジストリへ振り分け | 必須 |
| `createOrder` | 注文作成 → contact → `domain:create` → NS 設定 | 必須 |
| `deleteDomain` | `domain:delete` → `pendingDelete` へ（FIG.4） | 必須 |
| `restoreDomain` | `domain:restore` → 猶予期間内の復旧（FIG.4） | 必須 |
| `requestTransfer` | 移管IN: `domain:transfer request`（authInfo 提示） | 必須 |
| `cancelTransfer` | 移管IN の取消: `domain:transfer cancel` | 必須 |
| `respondTransfer` | 移管OUT: `domain:transfer approve` / `reject` | 必須 |
| `listTransfers` | 進行中の移管一覧（Firestore のみ） | 必須 |
| `getTransferStatus` | 移管1件の状態（承認待ちのポーリング用） | 必須 |
| `drainPollQueue` | poll ワーカーを手動実行（開発・デモ用） | 必須 |

スケジュール実行の関数が1本。

| 関数 | トリガー | 用途 |
|---|---|---|
| `pollWorker` | `onSchedule`（5分毎） | 両レジストリの poll キューを消化（FIG.3） |

### `createOrder` のリクエスト

```ts
const createOrder = httpsCallable(functions, "createOrder");
await createOrder({
  domainName: "example.com",
  periodYears: 1,                       // 1〜10、既定 1
  nameservers: ["ns1.example.com"],     // 任意
  idempotencyKey: "form-session-uuid",  // 8〜64文字。必須
  contact: {name: "Taro Test", emailLocalPart: "taro"}, // 任意
});
```

`idempotencyKey` は**フォームを開いた時点でクライアントが1つ生成し、
送信ボタンを何度押しても同じ値を送る**こと。注文ドキュメントの ID が
`uid__idempotencyKey` なので、これが二重課金を止める本体になる。

### レスポンス

```ts
{
  orderId, orderSeq, priceYen,
  state,          // "done" | "retrying" | "failed"
  domainName, registry, crDate, exDate, nameservers,
  recovered,      // true = 2302 + info で「前回すでに成功していた」
  message,        // 画面にそのまま出せる日本語
}
```

`state` は例外ではなく戻り値で返る。「お金だけ取られてドメインが無い」を
防ぐのがこのフローの目的なので、失敗も注文の状態として持つ（§6.7）。

### `deleteDomain` / `restoreDomain`

```ts
await httpsCallable(functions, "deleteDomain")({domainName: "example.com"});
await httpsCallable(functions, "restoreDomain")({domainName: "example.com"});
```

どちらも同じ形を返す。

```ts
{
  domainName, registry,
  lifecycle,        // "active" | "pendingDelete" | "gone"
  status,           // レジストリの status 配列そのまま
  rgpStatus, exDate,
  alreadyInState,   // true = すでにその状態（レジストリを叩いていない）
  restoreFeeYen,    // delete 時のみ。復旧にかかる額（表示用・課金はしない）
  message,          // 画面にそのまま出せる日本語
}
```

`lifecycle` は**レジストリの `status` から導出**していて、アプリ側で
状態機械を持っていない。猶予期間の記述は2レジストリで食い違い
（kitaqnic だけ「45日」と明記）、`redemptionPeriod` はどちらの定義にも
存在しないので、独自に段階を作ると画面が実態と食い違う（仕様書 §6.5）。
「戻せる／もう戻せない」の2段階で表示すること。

削除の前に「Webサイトとメールが止まります」の影響明示を出すのは画面の責務
（§6.5）。バックエンドが担保するのは**所有権チェック**（§7.3）で、
他人のドメインには `not-found` を返す — 「存在するが他人のもの」と
返すと他会員の保有ドメインを探れてしまうため。

`restore` が断る理由は3つあり、呼び出し側で区別できるように分けてある。

| レジストリの応答 | Callable のコード | 意味 |
|---|---|---|
| 404 / 2303 | `not-found` | 猶予期間が終了した |
| 2304 | 成功扱い（`alreadyInState`）or `failed-precondition` | 復旧不要／できる状態でない |
| 403 | `permission-denied` | 他レジストラが管理している |

⚠️ 403 を `unauthorized` に丸めると「接続設定の不備」と表示されてしまう。
`bridge/eppClient.ts` の `classify()` で 401 と 403 を分けているのはこのため。

### 移管（§6.6）

```ts
// 移管IN — gaining 側。authInfo（AuthCode）で本人確認する
await httpsCallable(functions, "requestTransfer")({
  domainName: "wanted.com",
  authInfo: "移管元で発行した認証コード",
});
await httpsCallable(functions, "cancelTransfer")({domainName: "wanted.com"});

// 移管OUT — losing 側。承認すると取り消せない
await httpsCallable(functions, "respondTransfer")({
  domainName: "leaving.com",
  action: "approve",   // または "reject"
});

// 進行中の一覧 / 1件の状態
await httpsCallable(functions, "listTransfers")({});
await httpsCallable(functions, "getTransferStatus")({domainName: "wanted.com"});
```

5本とも同じ形を返す。

```ts
{
  domainName, registry,
  direction,      // "in" = 引き取る / "out" = 手放す
  state,          // "pending" | "completed" | "rejected" | "cancelled" | "failed"
  gainingRegistrar, losingRegistrar,
  requestedAt,    // ISO 8601
  autoApproveAt,  // requestedAt + 20分（§6.6.1）
  recovered,      // true = domain:info で結果を確認して確定させた
  message,        // 画面にそのまま出せる日本語
}
```

**`pending` は正常な休止状態**であって「処理中」ではない。決めるのは相手の
レジストラか、20分後のレジストリ自身（§6.6.1）。だから注文の状態機械
（`retrying` がある）ではなく専用の `transfers` コレクションを使う — こちらが
再試行する余地は無いので `retrying` は嘘になる。

`transfers/{uid}__{name}` を id にしてあるのが二重申請の防波堤で、フォームを
2回送っても同じドキュメントに当たって「すでに `pending`」を返し、レジストリ
には**1回しか行かない**。同時実行は `holderToken`（renew のリースと同じ
フェンシング）で1本に絞る。

⚠️ `requestTransfer` は**自分がまだ持っていないドメイン**を触る唯一の
Callable なので `assertOwnsDomain` が使えない。代わりの本人確認が authInfo
そのもの（レジストリが照合する）。呼び出し側が自分で持っているドメインを
指定した場合だけは `failed-precondition` で先に断る。

移管の4コマンドはどれも**自動リトライしない**。タイムアウト時は
`domain:info` の `pendingTransfer` を見て「届いたのか」を判定し
（`renewDomain.ts` と同じ2段構え）、判定できなければ claim だけ外して
`failed-precondition` を返す — 状態は書き換えない。「何も起きていない」と
言い切るほうが、実は移管が動いていたときに危険だから。

エラーの読み替えで一番大事なのは **2202（authInfo 不一致）**。ここを
`internal`「接続設定に問題があります」に落とすと、初心者が最も間違える箇所で
最も役に立たない表示になる（§6.7）。`invalid-argument` +
「認証コード（AuthCode）が違うようです」を返す。

⚠️ kitaqnic の Swagger は `transfer/request` の **HTTP 401 を "Invalid
authInfo"** と定義している。認証情報の不備と字面では区別できないため、
**この1エンドポイントに限り** 401 を AuthCode 誤りとして扱い、その旨を
`logger.error` に残している（`domain/transferDomain.ts`）。

### poll ワーカー（§3.7 / §3.8 / FIG.3）

レジストリは移管要求などの非同期通知をキューに積み、**最古の未ack を1件ずつ**
返す。ack するまで新しい通知は一切降ってこないので、画面を開いたときに叩く
方式だと誰かが ack を忘れた瞬間にキュー全体が止まる。だからバックグラウンドで
回す。

処理順が肝で、**永続化 → ack → 業務処理**の順に固定してある。

| 順 | 失敗したら |
|---|---|
| ① 永続化 | ack しない。レジストリが再送してくれる（消失しない） |
| ② ack | キューが進む。ここで止まると後続が全部詰まる |
| ③ 業務処理 | すでに永続化済みなので Firestore から再処理できる。**例外は握り潰す** |

③ を ② より先にやると、ハンドラのバグ1つで全員の通知が止まる。
② を ① より先にやると、クラッシュで通知が永久に失われる。

レジストリ差分（§3.8）は `Route` として1か所に閉じ込めてある。

| | Kitaqsign | Kitaqnic |
|---|---|---|
| poll:req | `GET /messages/poll` | `GET /messages` |
| poll:ack | `POST /messages/{id}/ack` | `DELETE /messages/{id}` |

呼び出し側は `pollMessage()` / `ackMessage(id)` しか知らない。各クライアントの
差分は `pollRoute()` / `ackRoute(id)` の数行だけで、それ以外のロジックは共通。

**移管の通知だけハンドラが付いている**（`domain/transferNotifications.ts`）。
それ以外の種別は今も `pollMessages` に保存して ack し、`handled: "unhandled"`
を付けて種別をログに出す。追加は `registerPollHandler(msgType, handler)` 1行。

⚠️ **`msgType` の実値はどちらの Swagger にも書かれていない**（型は `string`
のみ）。取り違えると移管通知が丸ごと `unhandled` に落ちるので、照合は
`normalisePollMsgType()` で大文字小文字と区切り文字を無視する
（`transfer.request` / `TRANSFER_REQUEST` / `transferRequest` が同じ鍵になる）。
payload も同様に `domain` / `domainName` / `name` / `objId` を順に探し、
`resData` 等に1段ネストしていても拾う。テスト6で実測できたら
`TRANSFER_POLL_MSG_TYPES` に足すこと。解釈できなかった通知は
**ack 済み・保存済み**のまま `msgType` と payload のキーをログに残すので、
後から再処理できる（キューは絶対に止めない）。

```ts
// 手動実行（onSchedule はエミュレータで発火しない）
await httpsCallable(functions, "drainPollQueue")({});            // 両方
await httpsCallable(functions, "drainPollQueue")({registry: "kitaqsign"});
```

⚠️ `drainPollQueue` は現状ログイン済みなら誰でも叩ける。運用者向けの操作なので、
公開前にカスタムクレームで絞ること。

⚠️ Cloud Scheduler の無料枠は月3ジョブ。`pollWorker` は**1ジョブで両レジストリ
を消化**する（それぞれ独立にドレインするので、片方が落ちても他方は動く）。
§3.7 の字面通りレジストリごとに1ジョブ立てたい場合は `onSchedule` を2本に
割るだけだが、期限監視 BATCH（§6.4）の分を残しておくこと。

## リージョンとシークレット

- Firestore が `asia-northeast2` なので Functions も同リージョンに固定
  （`config/options.ts`）。
- レジストリの認証情報は Secret Manager。`.secret.local.example` を
  `.secret.local` にコピーしてエミュレータで使う。計5本
  （`BASIC_GATE_USER` / `BASIC_GATE_PASSWORD` / `REGISTRAR_ID` /
  `KITAQSIGN_API_KEY` / `KITAQNIC_API_KEY`）。
  外側の Basic ゲートと registrarId は両レジストリ共通なので1本ずつ、
  API キーだけレジストリごとに発行されるので2本に分けてある。
- `POST /sessions/login` に**別のIDやパスワードは無い**（リクエストボディが
  存在せず、認証は上の3ヘッダのみ）。ステートレスなので呼ぶ必要もない。
- 外部ホストへ通信するため **Blaze プラン必須**（Spark では送信できない）。

## ローカルでの動かし方

```bash
npm --prefix functions install
npm --prefix functions run build
```

エミュレータは `docs/firebase/docker-compose.yml` から起動する。
`.secret.local` を置いてからコンテナを再起動する必要がある
（`defineSecret(...).value()` が空文字になるため）。

⚠️ **再起動だけでは古いビルドを読み続けることがある**: `firebase.json` の
`predeploy`（lint/build）は `firebase deploy` 実行時にしか走らず、
`emulators:start` では実行されない。`docs/firebase/docker-compose.yml` の
`command` は `npm --prefix functions run build` を毎回実行してから
`emulators:start` するように組んであるので、`docker compose restart` /
`docker restart registrar-firebase-emulators` だけで
`functions/src` の変更（シークレット名の変更を含む）が反映される。
それでも解決しない場合は、コンテナを作り直す
（`docker compose up -d --build`）こと。

## Firestore コレクション

| コレクション | 用途 |
|---|---|
| `orders/{uid}__{idempotencyKey}` | 注文と状態機械 |
| `domains/{uid}__{name}` | 登録済みドメイン（一覧画面の元データ） |
| `registryContacts/{uid}__{registry}` | 会員×レジストリのコンタクト |
| `registryLogs/{auto}` | clTRID / svTRID / 所要時間（§7.2） |
| `transfers/{uid}__{name}` | 進行中／終了した移管とその状態機械（§6.6） |
| `pollMessages/{registry}__{id}` | poll で受け取った通知（ack 前に保存） |
| `counters/{orders,users,tldMap}` | 採番と TLD ルーティングのミラー |

`firestore.rules` は全拒否なので、クライアントから直接読めない。
一覧・詳細も Callable を足して返すこと。

## テスト

追加依存なし。Node 標準のテストランナーを使う。

```bash
npm --prefix functions run test:docker    # 推奨。コンテナ内で全件
npm --prefix functions run test:registrar # ホストから。エミュレータ無しなら結合はスキップ
npm --prefix functions test               # auth の単体 + 上記
```

`test:unit` / `test:integration` は auth 側のスイート（`src/auth/*.test.ts` を
`lib/` から実行）。こちらのスイートは `test/` に置き、`tsconfig.test.json` で
`lib-test/` に分けてビルドする（`lib/` に混ぜるとデプロイ物に載るため）。

```
test/
  helpers/stubRegistry.ts   OpenAPI に合わせた疑似レジストリ。障害注入つき
  helpers/testEnv.ts        環境変数・Callable 呼び出し・エミュレータ検出
  helpers/firestoreCleanup.ts  テストデータの後片付けとカウンタ復元
  unit/                     I/O なし
  integration/              スタブ + Firestore エミュレータ
```

### 課金は発生しない

1. 結合テストは `FIRESTORE_EMULATOR_HOST` が無いと**動かない**
   （実プロジェクトにフォールバックしない）
2. プロジェクトIDが `demo-` 始まりで、firebase-tools が実サービスへの
   到達を拒否する
3. `testEnv.ts` が読み込み時に両レジストリのベースURLを閉じたポートへ
   固定するので、`useStubRegistries` を呼び忘れたテストは**本物に届く前に
   即失敗する**（レジストリの create/delete は実データに反映されるため）

### poll のテスト

`pollWorker.test.ts` は `pollMessages` コレクションを毎回空にしてから走る。
このコレクションを書くのは poll ワーカーだけなので普段は問題ないが、
エミュレータに手動で溜めた通知があると消える点に注意。

スタブは2つの方言を両方喋る（`stub.dialect = "kitaqnic"`）。障害注入は
`ackFails`（ack が 500）、`ackSilentlyDoesNothing`（ack が成功を返すのに
消えない＝一番厄介な詰まり方）、`pollFails`（poll が 500）。

⚠️ **503 は「一時接続不能」専用**（`docs/仕様/registry-unavailable.md`）。
レジストリ全体の503は `stub.force503 = true`（全リクエストが503）で注入
する。一時的な transport 障害を注入したいときは 500 を使うこと
（`failNextCreates` / `failNextContacts` のデフォルトも 500）。
サーキットブレーカーの60秒窓はテストでは待たず、`counters/
registryHealth_{registry}` の `firstFailureAt` を過去に直接シードする
（`registryHealth.test.ts` 参照）。実画面での注入は Emulator 起動中に
モックパネル（画面右下）の「レジストリ障害シミュレーション」から行う。

### 直列実行

`--test-concurrency=1` を付けている。結合テストのファイルは1つの Firestore
エミュレータと `counters/*` を共有しているので、並列だとあるファイルの
カウンタ復元が別ファイルの実行中に割り込む。外すと数回に1回落ちる。

## まだ入っていないもの

- リトライワーカー（`retrying` のまま残った注文を拾う BATCH）。
  注文に `attempts` を持たせてあるので、`onSchedule` から
  `provisionDomain` を呼べば繋がる。
- ドメイン一覧・詳細の取得系 Callable。`domains` は `lifecycle` を持って
  いるので、§6.5 の2区画分けはそのまま実装できる。ただし作成直後の
  ドメインは `status` が空配列（`domain:create` は status を返さないため）。
  色分け（§3.5）に実 status が要るなら、`domain:info` を引く
  `refreshDomain` を足すこと。
- 価格表（TBD #7）。`domain/pricing.ts` は仮の値。移管も同じで、
  `transfer/request` に `period` を**送っていない**（移管で `exDate` が伸びるか
  §12 テスト6 で未実測、料金枠も未定のため。レジストリ既定に任せている）。
- 移管の `msgType` 実値（テスト6）。上の poll ワーカーの節を参照。
