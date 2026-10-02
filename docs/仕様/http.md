# HTTP通信・エラー判定 仕様書（EPPレジストリ Bridge層 Wire-level Contract）

**最終更新**: 2026-08-27
**ステータス**: 確定（`functions/src/bridge/` の実装コードから抽出。コードベース調査済み）
**対象**: レジストリ（Kitaqsign / Kitaqnic）とのEPP HTTP通信を担う BRIDGE 層における、HTTPステータスコードとEPP result codeの二段階判定ロジック、リトライ方針、監査ログ、および呼び出し元へのエラー変換契約。

## 0. 位置づけ

- 本書は `functions/src/bridge/eppClient.ts` を中心とする BRIDGE 層の実装を読み取って抽出した wire-level 仕様であり、実装と一致している（2026-08-27時点）。**実装を変更した場合は本書も同時に更新すること。**
- HTTP通信とレスポンス判定はこの `EppClient` に一本化されている。ファイル冒頭のコメント（`eppClient.ts:11-13`）に明記の通り、**BRIDGE層を経由せず `fetch` を直接呼んではいけない**という規約がある。
- 503（Service Unavailable）とサーキットブレーカーの詳細仕様は `docs/仕様/registry-unavailable.md` が正本である。本書は wire-level の分類・リトライ契約の観点からのみ 503 を扱う。
- 判定は2段階（`eppClient.ts:7` のコメント通り）で行われる。
  1. **HTTP層**: `response.status`（トランスポートレベルの成否）
  2. **EPP層**: レスポンスボディ内 `result.code`（レジストリのビジネス結果）
- 本書はこの2段階判定ロジック、HTTPステータス別の分岐、リトライ・監査ログ・エラー変換の契約を定義する。個々のEPPコマンド（`domain:create` 等）自体の業務仕様は対象外とする。

## 1. 全体構造

- `functions/src/bridge/eppClient.ts` の `EppClient` が、HTTP送信・タイムアウト・リトライ・2段階判定・監査ログ書き込みを一手に担う唯一の窓口。
- `functions/src/bridge/registryClient.ts` の `BaseRegistryClient`（抽象クラス）が、EPPコマンドごとに `this.http.send()` を呼ぶラッパーを提供する。`kitaqsignClient.ts` の `KitaqsignClient` と `kitaqnicClient.ts` の `KitaqnicClient` はこれを継承し、レジストラ固有差分（hello・pollルート等）のみを上書きする。
- `functions/src/bridge/errors.ts` の `RegistryError` / `RegistryErrorKind` が、HTTPステータスとEPP result codeの二段階判定結果を集約するエラー型。
- `functions/src/api/httpsErrors.ts` の `toHttpsError()` が、`RegistryError.kind` をCallable Functions向けの `HttpsError` コードへ最終変換する。
- リトライ・タイムアウト設定は `functions/src/config/options.ts` に定義される（`registryTimeoutMs()`: デフォルト10秒、`REGISTRY_MAX_ATTEMPTS = 3`）。実際のリトライループは `EppClient.send()`（`eppClient.ts:174-197`）内にある。
- `EppClient.send()` はリトライループの前にサーキットブレーカーのゲート判定を行う（`eppClient.ts:140-172`）。`functions/src/bridge/registryHealth.ts` の `checkGate()` が `"open"`（レジストリ到達不能と判定済み）を返した場合、HTTP送信を一切行わずに `RegistryError(kind: "serviceUnavailable", circuitOpen: true, retryable: false)` を即座にthrowする（fail fast。復旧確認用のprobeのみ通過する）。詳細は `docs/仕様/registry-unavailable.md` を参照。
- 監査ログは `functions/src/bridge/registryLog.ts` の `writeRegistryLog()` が担い、成功/失敗を問わず毎回のHTTP試行をFirestoreの `RegistryLog` コレクションへ記録する。このログ書き込みは失敗してもコマンド自体を失敗させない fire-and-forget 方式である（`registryLog.ts:32-51`）。

## 2. 判定ロジック（2段階判定）

判定は `EppClient.attempt()`（`eppClient.ts:208-342`）内で、以下の変数によって行われる（`eppClient.ts:274-283`）。

```
transportOk = httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300
tolerated   = resultCode !== undefined && (request.tolerate ?? []).includes(resultCode)
ok = envelope !== undefined && resultCode !== undefined
     && (SUCCESS_CODES.includes(resultCode) || tolerated)
     && (transportOk || tolerated)
```

- **「HTTP 2xx かつ EPP result codeが1000/1001（またはコマンドごとに指定された `tolerate` コード）」で初めて成功とみなされる。** HTTPステータス単体では成功と判定されない。
- 判定関数は `classify(httpStatus, resultCode)`（`eppClient.ts:72-97`）。resultCode が先に評価され、resultCode が特定の値（`2302` / `2303` / `2202` / `2306` / `2304` のいずれか）であれば、**HTTPステータスの値に関わらずそちらが優先される**（`eppClient.ts:76-81`）。

## 3. HTTPステータスコード別の処理一覧

| HTTPステータス（or状態） | 発生条件 | コード内の処理 | 根拠 |
|---|---|---|---|
| 200〜299（2xx） | 正常応答、かつ resultCodeが1000/1001（`SUCCESS_CODES`） | `ok = true`。`EppSuccess<T>` を呼び出し元に返す。RegistryLogに `ok: true` で記録。`recordSuccess()` でレジストリ健全性の連続失敗カウントをリセット | `eppClient.ts:60-63, 274-283, 302-312` |
| 2xx だが resultCode が失敗系（tolerate外） | 例: 2xxでも `result.code` が2302等で `tolerate` 未指定の場合 | `ok = false`。`classify()` がresultCode優先で判定（`objectExists` / `objectNotFound` / `authFailed` / `policyViolation` / `statusProhibited` のいずれか）。`RegistryError` をthrow、`retryable = (kind === "transport" || kind === "serviceUnavailable")` なので基本非retryable | `eppClient.ts:76-97, 326-341` |
| 401 Unauthorized | Basicゲート/APIキー拒否 | `classify()` が `"unauthorized"` を返す。`RegistryError.retryable = false`。httpsErrors側で `HttpsError("internal", ...)`（内部設定不備として扱い、詳細をユーザーに漏らさない） | `eppClient.ts:87`; `httpsErrors.ts:160-164` |
| 403 Forbidden | 認証は通るがこのレジストラは対象オブジェクトを操作不可（例: `domain:restore` でスポンサー登録機関でない） | `classify()` → `"forbidden"`。非retryable。`domainLifecycle.ts:374-379` で個別にcatchし `DomainLifecycleError("notSponsored", ...)` に変換 → httpsErrorsで `permission-denied` | `eppClient.ts:88`; `errors.ts:41-47`; `domainLifecycle.ts:374-379`; `httpsErrors.ts:165-169` |
| 404 Not Found | 対象オブジェクトが存在しない（EPP 2303と同義に扱われる） | `classify()` → `"objectNotFound"`。`domain:info` などの呼び出し元で「null」として扱われる場合あり（`domainLifecycle.ts:83` の `safeInfo()`）。httpsErrorsでは `HttpsError("not-found", ...)` | `eppClient.ts:89`; `domainLifecycle.ts:83-`; `httpsErrors.ts:140-144` |
| 409 Conflict | オブジェクト重複（EPP 2302と同義に扱われる） | `classify()` → `"objectExists"`。`domain:create` / `contact:create` ではEPP result 2302の方が主経路（`tolerate` 指定で正常応答扱いされることが多い）ため、この分岐は主にEPP側でtolerate対象外だった場合の保険的経路 | `eppClient.ts:90` |
| 400 / 422 | リクエスト内容がレジストリに拒否された（バリデーションエラー） | `classify()` → `"validation"`。非retryable。httpsErrorsで `HttpsError("invalid-argument", ...)` | `eppClient.ts:91`; `httpsErrors.ts:145-150` |
| **503 Service Unavailable** | レジストリがゲートで拒否（過負荷・再起動・メンテ。**コマンドは実行されていないことが保証される**） | `classify()` → `"serviceUnavailable"`（`transport` とは別kind）。**retryable**であり、`idempotent: true` のコマンドは `transport` と同じ指数バックオフでリトライされる。加えて `record503()` がレジストリ単位の連続503を記録し、閾値超過でサーキットブレーカーが開く（`circuitOpen: true` が `RegistryError` に付与される）。httpsErrorsでは `HttpsError("unavailable", ...)` となり、`circuitOpen` 時のみ `details: {reason: "registry-unavailable"}` が付く。詳細は `docs/仕様/registry-unavailable.md` | `eppClient.ts:92-95, 319-322, 339-340`; `errors.ts:17-25`; `httpsErrors.ts:175-187` |
| 500以上（5xx。**503を除く**） | サーバ側エラー | `classify()` → `"transport"`。retryable。`idempotent: true` のコマンドに限り `REGISTRY_MAX_ATTEMPTS = 3` 回まで指数バックオフ（250ms, 500ms, ...）で自動リトライ（`eppClient.ts:174-197`）。最終的に失敗した場合はhttpsErrorsで `HttpsError("unavailable", ...)` | `eppClient.ts:96, 174-197`; `httpsErrors.ts:188-192` |
| HTTPステータス取得不能（ネットワーク断・タイムアウト・fetch例外） | `fetch()` 自体が例外（DNS失敗、接続拒否、`AbortController` によるタイムアウト） | `httpStatus === undefined` → `classify()` → `"transport"`。5xxと同様にidempotentコマンドはリトライ対象。タイムアウトは `registryTimeoutMs()`（既定10秒）で `AbortController.abort()` をトリガー（`eppClient.ts:241-242`） | `eppClient.ts:83, 229-267` |
| 2xx応答だがボディがJSONとして不正 | `response.text()` を `JSON.parse` した際に例外 | `envelope` は `undefined` のまま、`transportMessage` に非JSONボディの先頭200文字を格納。`resultCode` も `undefined` になるため、`ok` は必ず `false`。`classify(httpStatus, undefined)` はhttpStatusが2xxなら どの分岐にも一致せず `"unknown"` に落ちる（非retryable） | `eppClient.ts:253-261, 271, 97` |
| その他未分類の4xx/2xx（例: 402, 405, 408, 415, 429など） | resultCodeも特定できず、httpStatusも401/403/404/409/400/422/503のいずれでもなく500未満 | `classify()` の最終行 `return "unknown"` に到達。非retryable。httpsErrorsのswitchでは `default` 節に落ち、`HttpsError("internal", "処理できませんでした。")` | `eppClient.ts:97`; `httpsErrors.ts:193-194` |
| （HTTP以前）サーキットブレーカー open | 直近のリクエスト群で503が続き、`registryHealth.ts` がレジストリ到達不能と判定済み | `EppClient.send()` 冒頭の `checkGate()` が `"open"` を返し、**HTTP送信自体を行わず** `RegistryError(kind: "serviceUnavailable", circuitOpen: true, retryable: false)` を即throw（fail fast）。RegistryLogには `httpStatus: null` で記録。復旧確認のprobeリクエストのみ通過する | `eppClient.ts:140-172`; `registryHealth.ts`; `docs/仕様/registry-unavailable.md` |

## 4. 未処理・想定外のケース

- **3xx（リダイレクト）は明示的に想定されていない。** `fetch()` はデフォルトでリダイレクトを自動追跡するため、コード内に3xx専用分岐は存在しない（`eppClient.ts:198-206` にオプション指定なし、透過的に `"unknown"` 扱いに落ちる設計）。
- **429（Too Many Requests）専用の扱いがない。** レート制限応答は `classify()` のどの分岐にも一致せず `"unknown"` となり、リトライ対象外（`retryable` は `kind === "transport"` または `"serviceUnavailable"` のみtrue）。本来リトライすべきケースだが、現状は自動リトライされない。
- **HTTPは2xxでもresult.codeがEPP_RESULT定義（1000, 1001, 2302, 2303, 2202, 2304, 2306）以外の値**（例: 2000系構文エラー、2400系コマンド失敗など）は、`classify()` で拾われず `"unknown"` に落ちる。httpsErrors側もdefaultの `"internal"` にしかならず、業務的な意味がユーザーへ伝わらない。
- **406, 415（Accept/Content-Type不一致）や501/505など、より詳細な4xx/5xxのサブレンジも個別分岐がない**（406/415は"unknown"、5xxは種類を問わず一律"transport"扱い）。
- **リトライは `idempotent: true` のコマンドに限られる。** `domain:create` / `domain:update` / `domain:renew` / `domain:delete` / `contact:create` 等の非冪等コマンドは、5xxやネットワーク断が発生しても `EppClient.send()` 内では一切リトライされず（`maxAttempts = request.idempotent ? REGISTRY_MAX_ATTEMPTS : 1`、`eppClient.ts:174`）、即座に `RegistryError(kind: "transport")` がthrowされる。この場合の後続処理（再照会での整合性確認＝reconciliation）は `domain` レイヤー（例: `functions/src/domain/renewDomain.ts:358-413` の `handleRenewFailure()`、`functions/src/domain/domainLifecycle.ts` 各所）が担う。

## 5. EPP result codeとの関係（補足）

- HTTP 200/201（2xx）で応答が返ってきた後も、ボディ内 `result.code` が最終判定を決める。成功コードは `SUCCESS(1000)` / `SUCCESS_ACTION_PENDING(1001)` のみ（`types.ts:11-19`, `eppClient.ts:60-63`）。
- `EppRequest.tolerate`（`eppClient.ts:43`）でコマンドごとに「失敗扱いにしないresult.code」を明示的に指定できる。例:
  - `domain:create` は `2302 (OBJECT_EXISTS)` をtolerateし、`AlreadyExists` として正常応答扱い（呼び出し元で再照会フローへ、`registryClient.ts:429`）。
  - `contact:create` も同様に `2302` をtolerate（`registryClient.ts:718`）。
  - `host:create` は意図的に `2302` をtolerateしない（他人が作ったホストを誤って自分の所有物にしないため、`registryClient.ts:786` のコメント参照）。
- `classify()` でのresultCode優先分岐（`eppClient.ts:76-81`）: `2302 → objectExists`, `2303 → objectNotFound`, `2202 → authFailed`, `2306 → policyViolation`, `2304 → statusProhibited`。これらはHTTPステータスが何であれ優先的に適用される。
- `domain` レイヤー（`domainLifecycle.ts`, `renewDomain.ts`, `provisionDomain.ts`）は、`RegistryError.kind` が `"transport"` または（一部）`"unknown"` のような「レジストリが実際にコマンドを処理したか不明」なケースでのみ `domain:info` による再照会（reconciliation）を行う。バリデーション・権限・見つからない等の明示的な拒否は再照会せず即座に最終エラーとする設計（`renewDomain.ts:345-351` のコメントに明記）。

## 6. 改善策（所見）

- 429（レート制限）を `"transport"` 相当のretryable扱いに追加するか検討する価値がある（現状は自動リトライされず即座にエラー化される）。
- EPP result codeがEPP_RESULT定数外の値（2000/2001/2400系等）を返した場合の扱いを、ユーザー向けにより具体的な `HttpsError` コードへ振り分けるか検討する余地がある（現状は一律 `"internal"`）。
