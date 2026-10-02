# 認証 API 仕様書（Wire-level Contract）

**最終更新**: 2026-08-27
**ステータス**: 確定（`functions/src/auth/` の実装コードから抽出。エミュレータ検証済み。v1.1 で実装とのずれを解消。2026-08-27: Auth Blocking Functions 撤去と `requireActiveUser` 追加、`searchDomains` の認証不要化を反映）
**対象**: [`docs/仕様/auth.md`](./auth.md)（設計・フロー仕様、v1.4）で定義した認証・アカウント管理バックエンドの、フロントエンド向け wire-level API 契約。

## 0. 位置づけ

- 本書は `docs/仕様/auth.md` の「何を・なぜ」に対する「実際にどんなリクエスト/レスポンスが飛び交うか」を定義する。設計判断・フロー・セキュリティ根拠は auth.md を参照し、本書では重複させない。
- 本書のスキーマは `functions/src/auth/*.ts`（`registration.ts` / `session.ts` / `account-lifecycle.ts` / `callerGuard.ts` / `cleanup.ts` / `verification.ts` / `verificationCodes.ts` / `profileSchema.ts` / `constants.ts` / `types.ts`）を実際に読み取って抽出したものであり、実装と一致している（2026-08-27時点）。**実装を変更した場合は本書も同時に更新すること。** ⚠️ **2026-08-27 追記**: `functions/src/auth/blocking.ts`（Auth Blocking Functions）は撤去済み。理由・詳細・撤去に伴う新規ガード（`requireActiveUser`）は §3 を参照。あわせて `functions/src/api/searchDomains.ts` から `requireActiveUser` 呼び出しと従来の `request.auth` 必須ガードの両方を撤去し、`listTlds` / `devForceRegistry503` と並ぶ認証不要の公開 Callable にした（フロントエンドの検索画面は元から未認証で使える設計だったため、これはバックエンド側の実装をその仕様に合わせた修正であり、認証要件を緩めた変更ではない）。詳細は §3 を参照。
- OpenAPI 3.1 で記述しているのは、フロントエンドが直接叩く可能性のある関数のみ（§2）。Cloud Tasks / Cloud Scheduler / Auth からのみ起動される内部トリガーは OpenAPI の対象外とし、§3 で別途プレーンテキストとして仕様化する。

## 1. 共通事項

### 1.1 関数の種別とエンドポイント形状

| 種別 | 対象関数 | エンドポイント形状 |
|---|---|---|
| HTTPS (`onRequest`) | `sessionLogin`, `sessionLogout`, `issueCsrfToken`（GET）, `sessionMe`（GET） | 素の JSON REST。本番: `https://{region}-{projectId}.cloudfunctions.net/{functionName}`／エミュレータ: `http://localhost:5001/{projectId}/{region}/{functionName}`。✅ **Hosting rewrite（`firebase.json`）で同一オリジンパスにも公開済み**: `/api/session/login` → `sessionLogin`、`/api/session/logout` → `sessionLogout`、`/api/session/me` → `sessionMe`、`/api/session/csrf` → `issueCsrfToken`（フロントエンドは通常こちらを使う） |
| Callable (`onCall`) | `registerWithEmailPassword`, `startEmailVerification`, `resendEmailVerificationCode`, `verifyEmailCode`, `submitAdditionalInfo`, `deleteAccountWithPassword`, `deleteAccountWithGoogle`, `restoreAccount` | Firebase Callable プロトコル。同一 URL 形状だが、リクエスト/レスポンスは `{"data": ...}` / `{"result": ...}` / `{"error": ...}` の封筒に包まれる（§1.2）。**フロントエンドは生 `fetch` ではなく Firebase Client SDK の `httpsCallable()` を使うこと。** 本書の OpenAPI はワイヤーフォーマットの参照用。 |

`{region}` は ✅ **`asia-northeast2` に確定**（`functions/src/config/options.ts` の `setGlobalOptions`。Hosting rewrite も同リージョンを明示指定）。`{projectId}` は `teamc-2026`（`.firebaserc`）。

### 1.2 Callable Function の封筒フォーマット

Firebase Callable Functions は HTTPS POST 1本に対し、以下の JSON 封筒を使う（Admin SDK / `firebase-functions` v2 の既定シリアライズ）。

- リクエスト: `{ "data": <関数ごとのペイロード> }`
- 成功レスポンス（HTTP 200）: `{ "result": <関数ごとの戻り値> }`
- 失敗レスポンス: `{ "error": { "message": string, "status": <UPPER_SNAKE_CASEコード>, "details"?: any } }`。HTTP ステータスは `HttpsError` の `code` から下表の対応表で決まる（Google API の gRPC→HTTP マッピングに準拠）。

| `HttpsError` code | `status` 文字列 | HTTP ステータス |
|---|---|---|
| `invalid-argument` | `INVALID_ARGUMENT` | 400 |
| `unauthenticated` | `UNAUTHENTICATED` | 401 |
| `permission-denied` | `PERMISSION_DENIED` | 403 |
| `not-found` | `NOT_FOUND` | 404 |
| `already-exists` | `ALREADY_EXISTS` | 409 |
| `failed-precondition` | `FAILED_PRECONDITION` | 400 |
| `resource-exhausted` | `RESOURCE_EXHAUSTED` | 429 |
| `internal` | `INTERNAL` | 500 |

（`not-found` / `resource-exhausted` は v1.1 追記。メール認証 Callable（§2 の `/startEmailVerification` 等）が使用する。）

認証が必要な Callable は、クライアントの Firebase Callable SDK が `Authorization: Bearer <Firebase IDトークン>` を自動付与する（`docs/仕様/auth.md` §2.3）。

### 1.3 `onRequest` エンドポイントのエラー封筒

`sessionLogin` / `sessionLogout` は Callable ではなく素の HTTPS 関数のため、独自の軽量エラー封筒を使う: `{ "error": { "code": string, "message": string } }`。使用される `code`: `invalid-argument` / `unauthenticated` / `permission-denied` / `method-not-allowed` / `internal`。両エンドポイントとも `Cache-Control: no-store` を常に返す。

### 1.4 Session Cookie

| 属性 | 値 |
|---|---|
| Cookie 名 | `session` |
| 発行時 | `Max-Age=432000`（5日=`SESSION_COOKIE_EXPIRES_IN_MS`）, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Strict` |
| 破棄時 | `Max-Age=0`（他の属性は発行時と同一） |

### 1.5 CSRF 対策（`sessionLogin` と `sessionLogout`）

リクエストボディの `csrfToken` フィールドと、`X-CSRF-Token` ヘッダーの値を `timingSafeEqual` で突合する（ダブルサブミット方式）。不一致・欠落は `403 permission-denied`。✅ **v1.1 更新**: この検証は `sessionLogin` だけでなく **`sessionLogout` にも適用される**（実装: `functions/src/auth/session.ts` の `parseCsrfOnlyBody` / `csrfTokensMatch`）。トークンの発行は **`GET /issueCsrfToken`**（rewrite: `/api/session/csrf`）が担う（旧・未決事項は解決済み）。

## 2. OpenAPI 3.1 仕様（フロントエンドが直接/間接的に呼び出す関数）

```yaml
openapi: 3.1.0
info:
  title: 認証・アカウント管理 API（zerokaradomain / teamc-2026）
  version: "1.0.0"
  description: >-
    docs/仕様/auth.md の設計に基づく Firebase Authentication バックエンドの wire-level 契約。
    Callable Function は Firebase Client SDK の httpsCallable() 経由での利用を前提とする。
servers:
  - url: "https://{region}-{projectId}.cloudfunctions.net"
    description: 本番（region は asia-northeast2 に確定済み）
    variables:
      region:
        default: asia-northeast2
      projectId:
        default: teamc-2026
  - url: "http://localhost:5001/{projectId}/{region}"
    description: Firebase Local Emulator Suite
    variables:
      region:
        default: asia-northeast2
      projectId:
        default: teamc-2026

paths:
  /sessionLogin:
    post:
      summary: ログイン・Google登録の共通エントリポイント（Session Cookie発行）
      description: docs/仕様/auth.md §4.2, §4.5, §4.6, §4.9 手順5 に対応。
      security: []
      parameters:
        - name: X-CSRF-Token
          in: header
          required: true
          schema: { type: string }
          description: リクエストボディの csrfToken と timingSafeEqual で突合される。
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [idToken, csrfToken]
              properties:
                idToken:
                  type: string
                  description: Firebase Client SDK から取得した ID トークン（password/googleどちらの認証結果でも可）。
                csrfToken:
                  type: string
      responses:
        "200":
          description: 状態に応じて3パターンのいずれかを返す。
          headers:
            Set-Cookie:
              schema: { type: string }
              description: statusがokの場合はsession Cookieを発行、additional_info_required/pending_deletionの場合は破棄する。
          content:
            application/json:
              schema:
                oneOf:
                  - "$ref": "#/components/schemas/SessionLoginAdditionalInfoRequired"
                  - "$ref": "#/components/schemas/SessionLoginPendingDeletion"
                  - "$ref": "#/components/schemas/SessionLoginOk"
        "400":
          description: リクエストボディが不正。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "401":
          description: idTokenの検証に失敗（期限切れ・改ざん等）。既存のsession Cookieがあれば破棄される。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "403":
          description: CSRFトークン不一致、または provider/状態の不整合（authProviderの不一致、statusがpurging、未登録uidへのGoogle以外での到達など）。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "405":
          description: POST以外のメソッド。
          headers:
            Allow: { schema: { type: string, example: POST } }
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "500":
          description: Firestoreトランザクション失敗、またはcreateSessionCookie失敗。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }

  /sessionLogout:
    post:
      summary: ログアウト（Session Cookie検証・失効・破棄）
      description: >-
        docs/仕様/auth.md §4.7 に対応。session Cookieはリクエストヘッダーで送る。
        CSRFダブルサブミット検証あり（§1.5）: ボディの csrfToken と X-CSRF-Token ヘッダーを突合する。
      security:
        - sessionCookie: []
      parameters:
        - name: X-CSRF-Token
          in: header
          required: true
          schema: { type: string }
          description: リクエストボディの csrfToken と timingSafeEqual で突合される。
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [csrfToken]
              properties:
                csrfToken: { type: string, description: "GET /issueCsrfToken で取得したトークン。" }
      responses:
        "200":
          description: revokeRefreshTokens成功。Cookieは常に破棄される。
          headers:
            Set-Cookie: { schema: { type: string }, description: "session Cookieを破棄（Max-Age=0）。" }
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties: { status: { type: string, enum: [ok] } }
        "401":
          description: session Cookieが存在しない、またはverifySessionCookieが失敗。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "403":
          description: CSRFトークン不一致・欠落。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "405":
          description: POST以外のメソッド。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "500":
          description: revokeRefreshTokensが失敗。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }

  /issueCsrfToken:
    get:
      summary: CSRFトークン発行（sessionLogin / sessionLogout 用）
      description: >-
        docs/仕様/auth.md §4.5 手順5 に対応。Hosting rewrite では GET /api/session/csrf。
        randomBytes による base64url トークンを返す。Cache-Control no-store。
      security: []
      responses:
        "200":
          description: トークン発行。
          content:
            application/json:
              schema:
                type: object
                required: [csrfToken]
                properties: { csrfToken: { type: string } }
        "405":
          description: GET以外のメソッド。
          headers:
            Allow: { schema: { type: string, example: GET } }
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }

  /sessionMe:
    get:
      summary: セッション復帰（ログイン中ユーザー情報の取得）
      description: >-
        Hosting rewrite では GET /api/session/me。session Cookie を verifySessionCookie(cookie, true) で検証し、
        users/{uid}.status === "active" を確認したうえでユーザー情報を返す。
        リロード時の認証状態確認（docs/仕様/auth.md §4.10 の適用例）。
      security:
        - sessionCookie: []
      responses:
        "200":
          description: 認証済み。
          content:
            application/json:
              schema:
                type: object
                required: [id, email, displayName]
                properties:
                  id: { type: string, description: "Firebase Auth の uid。" }
                  email: { type: string }
                  displayName: { type: string, description: "users/{uid}.profile.name。" }
        "401":
          description: Cookie欠落・検証失敗・statusがactiveでない。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }
        "405":
          description: GET以外のメソッド。
          content: { application/json: { schema: { "$ref": "#/components/schemas/OnRequestError" } } }

  /startEmailVerification:
    post:
      summary: "[Callable] メール認証コードの発行（登録ウィザード ステップ2）"
      description: >-
        docs/仕様/auth.md §4.1.1 手順1 に対応。冪等（有効なコードがあれば再発行しない）。
        コード自体はレスポンスに含めない（クライアントは verificationCodes/{email} を Firestore から直接 get する）。
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data:
                  type: object
                  required: [email]
                  properties:
                    email: { type: string, format: email, description: "許可ドメイン（ALLOWED_EMAIL_DOMAINS）のみ。正規化（trim+小文字化）される。" }
      responses:
        "200":
          description: 発行済みコードのステータス。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { "$ref": "#/components/schemas/VerificationStatus" }
        "400":
          description: "invalid-argument: メール形式不正・許可ドメイン外。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500":
          description: "internal: 予期しない失敗。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }

  /resendEmailVerificationCode:
    post:
      summary: "[Callable] メール認証コードの再発行（レート制限つき）"
      description: docs/仕様/auth.md §4.1.1 手順4 に対応。常に新しいコードを発行する。
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data:
                  type: object
                  required: [email]
                  properties:
                    email: { type: string, format: email }
      responses:
        "200":
          description: 再発行後のステータス。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { "$ref": "#/components/schemas/VerificationStatus" }
        "400":
          description: "invalid-argument: メール形式不正・許可ドメイン外。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "429":
          description: "resource-exhausted: 前回発行から60秒以内の再送要求。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500":
          description: "internal: 予期しない失敗。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }

  /verifyEmailCode:
    post:
      summary: "[Callable] メール認証コードの照合・認証グラント発行"
      description: >-
        docs/仕様/auth.md §4.1.1 手順3 に対応。成功すると registerWithEmailPassword の
        事前条件となる認証グラント（30分有効）が立つ。
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data:
                  type: object
                  required: [email, code]
                  properties:
                    email: { type: string, format: email }
                    code: { type: string, description: "6桁コード。" }
      responses:
        "200":
          description: 認証成功。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result:
                    type: object
                    required: [verified, verifiedUntil]
                    properties:
                      verified: { type: boolean, enum: [true] }
                      verifiedUntil: { type: number, description: "グラント失効時刻（エポックms）。" }
        "400":
          description: >-
            invalid-argument（コード不一致。details.attemptsRemaining に残試行回数）、または
            failed-precondition（コード期限切れ・グラント期限切れ）。error.status で判別する。
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "404":
          description: "not-found: コード未発行。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "429":
          description: "resource-exhausted: 試行回数（5回）超過。新しいコードの発行が必要。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500":
          description: "internal: 予期しない失敗。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }

  /registerWithEmailPassword:
    post:
      summary: "[Callable] メールアドレス＋パスワードでの新規登録（フルプロフィール）"
      description: >-
        docs/仕様/auth.md §4.1 に対応。Firebase Callable SDK の httpsCallable() 経由での呼び出しを想定
        （本パスは封筒フォーマット確認用。実際のURLは1.1節参照）。
        事前条件: verifyEmailCode による有効な認証グラント（§4.1.1）。
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data:
                  type: object
                  required: [email, password, profile]
                  properties:
                    email: { type: string, format: email, description: "ALLOWED_EMAIL_DOMAINS（example.com/example.net/example.org）のみ許可" }
                    password: { type: string, description: "最大128文字" }
                    profile: { "$ref": "#/components/schemas/UserProfile" }
      responses:
        "200":
          description: 登録成功（メール認証グラントは消費される）。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result:
                    type: object
                    properties:
                      uid: { type: string }
                      status: { type: string, enum: [active] }
        "400":
          description: >-
            invalid-argument（必須項目欠落／不正なメール形式／許可ドメイン外／profileがzodスキーマ違反。
            details.issues にフィールド単位の違反が入る）、または
            failed-precondition（メールアドレスが未認証＝有効な認証グラントが無い）。error.status で判別する。
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "409":
          description: "already-exists: 既に同一メールで登録済み（別方式含む）、または削除手続き中。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500":
          description: "internal: Auth作成/Firestore書き込みの予期しない失敗（Firestore失敗時はAuthユーザーを補償削除）。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }

  /submitAdditionalInfo:
    post:
      summary: "[Callable] Google登録時の追加情報（フルプロフィール）送信"
      description: >-
        docs/仕様/auth.md §4.2 手順5 に対応。要認証（Firebase IDトークン）。
        リクエストの data はフルプロフィール（UserProfile）そのもの（登録 Callable と同じ zod スキーマで検証される）。
      security:
        - firebaseIdToken: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data: { "$ref": "#/components/schemas/UserProfile" }
      responses:
        "200":
          description: 追加情報の登録が完了し status が active になった。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: object, properties: { status: { type: string, enum: [active] } } }
        "400":
          description: >-
            invalid-argument（profileがzodスキーマ違反）、または failed-precondition
            （ユーザードキュメントが無い、pending_additional_info以外の状態、もしくはGoogle以外のプロバイダ）のいずれか。
            `error.status` で判別する（1.2節の対応表参照）。
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "401":
          description: "unauthenticated: IDトークンが無い/無効。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500":
          description: "internal: 予期しない失敗。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }

  /deleteAccountWithPassword:
    post:
      summary: "[Callable] アカウント削除（メールアドレス＋パスワード）"
      description: >-
        docs/仕様/auth.md §4.8.1 に対応。要認証・要新鮮な再認証（reauthenticateWithCredential直後、
        auth_timeが直近5分以内）。リクエストデータなし。
      security:
        - firebaseIdToken: []
      requestBody:
        required: false
        content:
          application/json:
            schema: { type: object, properties: { data: { type: object } } }
      responses:
        "200":
          description: 削除リクエスト受理。status が pending_deletion に遷移。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result:
                    type: object
                    properties:
                      status: { type: string, enum: [pending_deletion] }
                      scheduledPurgeAt: { type: string, format: date-time }
        "401":
          description: "unauthenticated: IDトークンが無い。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "400":
          description: >-
            failed-precondition: 再認証が古い（auth_timeが5分超）、ユーザードキュメントが無い/statusがactiveでない、
            または削除リクエストが処理中に他の変更と競合し取り消された。
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "403":
          description: "permission-denied: authProviderが password ではない（Googleアカウント側の関数を使う必要がある）。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500":
          description: "internal: タスク登録/revokeRefreshTokens等の失敗（成功していた状態変更は補償ロールバックされる）。"
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }

  /deleteAccountWithGoogle:
    post:
      summary: "[Callable] アカウント削除（Googleアカウント）"
      description: >-
        docs/仕様/auth.md §4.8.2 に対応。/deleteAccountWithPassword と同一の契約で、
        authProvider が google.com であることを要求する点のみ異なる。
      security:
        - firebaseIdToken: []
      requestBody:
        required: false
        content:
          application/json:
            schema: { type: object, properties: { data: { type: object } } }
      responses:
        "200":
          description: 削除リクエスト受理。status が pending_deletion に遷移。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result:
                    type: object
                    properties:
                      status: { type: string, enum: [pending_deletion] }
                      scheduledPurgeAt: { type: string, format: date-time }
        "401": { description: "unauthenticated", content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } } }
        "400": { description: "failed-precondition（/deleteAccountWithPasswordと同義）", content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } } }
        "403": { description: "permission-denied: authProviderが google.com ではない。", content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } } }
        "500": { description: "internal", content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } } }

  /restoreAccount:
    post:
      summary: "[Callable] 削除猶予期間中のアカウント復旧"
      description: docs/仕様/auth.md §4.9 手順6 に対応。要認証・要新鮮な再認証。リクエストデータなし。
      security:
        - firebaseIdToken: []
      requestBody:
        required: false
        content:
          application/json:
            schema: { type: object, properties: { data: { type: object } } }
      responses:
        "200":
          description: 復旧成功。status が active に戻る。
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: object, properties: { status: { type: string, enum: [active] } } }
        "401": { description: "unauthenticated", content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } } }
        "400":
          description: >-
            failed-precondition: 再認証が古い、またはドキュメントが無い/statusがpending_deletionでない/
            scheduledPurgeAtを過ぎている（既にpurging/削除済み）。
          content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } }
        "500": { description: "internal", content: { application/json: { schema: { "$ref": "#/components/schemas/CallableError" } } } }

components:
  securitySchemes:
    firebaseIdToken:
      type: http
      scheme: bearer
      bearerFormat: "Firebase ID Token（Callable SDKが自動付与）"
    sessionCookie:
      type: apiKey
      in: cookie
      name: session

  schemas:
    OnRequestError:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code: { type: string, enum: [invalid-argument, unauthenticated, permission-denied, method-not-allowed, internal] }
            message: { type: string }

    CallableError:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [message, status]
          properties:
            message: { type: string }
            status: { type: string, enum: [INVALID_ARGUMENT, UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND, ALREADY_EXISTS, FAILED_PRECONDITION, RESOURCE_EXHAUSTED, INTERNAL] }
            details: {}

    VerificationStatus:
      type: object
      description: startEmailVerification / resendEmailVerificationCode の戻り値。コード自体は含まれない。
      required: [email, attemptsRemaining, expiresAt, resendAvailableAt, verified]
      properties:
        email: { type: string, description: "正規化済みアドレス。" }
        attemptsRemaining: { type: number }
        expiresAt: { type: number, description: "コード提出期限（エポックms）。" }
        resendAvailableAt: { type: number, description: "再送を受け付ける時刻（エポックms）。" }
        verified: { type: boolean }

    UserProfile:
      type: object
      description: >-
        フルプロフィール。バリデーションの正本は functions/src/auth/profileSchema.ts（zod）。
        business は accountType が individual 以外のとき必須（それ以外は null）。
      required: [name, nameKana, phoneNumber, dateOfBirth, gender, newsletterOptIn, accountType, business, address]
      properties:
        name: { type: string, maxLength: 100 }
        nameKana: { type: string, description: "カタカナのみ。" }
        phoneNumber: { type: string, maxLength: 20 }
        dateOfBirth: { type: string }
        gender: { type: string, enum: [male, female, other, no_answer] }
        newsletterOptIn: { type: boolean }
        accountType: { type: string, enum: [individual, sole-proprietor, corporate] }
        business:
          type: [object, "null"]
          properties:
            companyName: { type: string, description: "法人=会社名 / 個人事業主=屋号。" }
            department: { type: [string, "null"] }
            contactPerson: { type: string }
        address:
          description: country="JP" かどうかの判別共用体。
          oneOf:
            - type: object
              description: 国内住所（JapanAddress）。
              required: [country, postalCode, prefecture, city, addressLine, building]
              properties:
                country: { type: string, enum: [JP] }
                postalCode: { type: string, description: "123-4567 形式（ハイフン省略可）。" }
                prefecture: { type: string, description: "47都道府県のいずれか。" }
                city: { type: string }
                addressLine: { type: string }
                building: { type: [string, "null"] }
            - type: object
              description: 海外住所（InternationalAddress）。
              required: [country, postalCode, state, city, addressLine1, addressLine2]
              properties:
                country: { type: string, enum: [US, GB, CN, KR, TW] }
                postalCode: { type: string }
                state: { type: [string, "null"] }
                city: { type: string }
                addressLine1: { type: string }
                addressLine2: { type: [string, "null"] }

    SessionLoginAdditionalInfoRequired:
      type: object
      required: [status]
      properties:
        status: { type: string, enum: [additional_info_required] }

    SessionLoginPendingDeletion:
      type: object
      required: [status, daysRemaining]
      properties:
        status: { type: string, enum: [pending_deletion] }
        scheduledPurgeAt: { type: [string, "null"], format: date-time }
        daysRemaining: { type: number }

    SessionLoginOk:
      type: object
      required: [status]
      properties:
        status: { type: string, enum: [ok] }

    UserStatus:
      type: string
      enum: [pending_additional_info, active, pending_deletion, purging]

    AuthProvider:
      type: string
      enum: [password, google.com]
```

## 3. 非公開・内部トリガー（フロントエンドから直接呼び出さない）

OpenAPI の対象外。Firebase / Cloud Tasks / Cloud Scheduler からのみ起動される。

| 関数名 | トリガー | 説明 |
|---|---|---|
| ~~`enforceAllowedEmailDomainOnCreate`（および no-op の `beforeUserSignedIn`）~~ → **撤去済み（2026-08-27）** | ~~Auth Blocking Function (`beforeUserCreated` / `beforeUserSignedIn`)~~ | `teamc-2026` は Identity Platform 未アップグレードの素の Firebase Auth であり、`firebase deploy` が `400 OPERATION_NOT_ALLOWED : Blocking Functions may only be configured for GCIP projects.` で恒常的に失敗していたため `functions/src/auth/blocking.ts` ごと撤去した（詳細: `docs/仕様/auth.md` §6・§7.4・§9 v1.5）。メールドメイン制限は `registerWithEmailPassword`（`registration.ts` の `isAllowedEmailDomain`）と `verification.ts`（`parseEmail`）の実行時チェックに一本化した。 |
| `requireActiveUser`（`functions/src/auth/callerGuard.ts`） | 共通認可ガード（それ自体は Cloud Functions のトリガーではなく、`functions/src/api/` 配下の会員向け Callable が処理冒頭で `await requireActiveUser(request.auth)` として呼び出す） | `request.auth` は Firebase Auth がトークンを発行したことしか保証しない。Identity Toolkit の公開エンドポイント `accounts:signUp` はフロントエンド同梱の Web API キーだけで到達可能なため、`registerWithEmailPassword` を一度も呼ばずに有効な ID トークンを取得した呼び出し元が `users/{uid}` ドキュメントなしで `api/` 配下の Callable を通過できてしまう穴があった。`requireActiveUser` は `users/{uid}` が存在し `status === 'active'` であることを確認し、満たさない呼び出しを拒否する。**このチェックは `functions/src/api/` 配下の Callable のみが対象**（`functions/src/auth/` 配下の関数は各自が独自の状態チェックを行うため対象外）。除外（意図的に認証不要のまま）: `listTlds` / `devForceRegistry503` / `searchDomains`（2026-08-27、ユーザーの明示的な判断: 「searchDomains は認証不要。購入する際に必要になる。」— 検索は公開、ログインが必要なのは購入からのみ。**これは仕様に合わせて既存のバグを直したものであり、認証要件を緩めた変更ではない**: フロントエンドの検索画面は元から「検索はログイン不要」という公開ルート設計だったが、`searchDomains` 側は `requireActiveUser` に加え旧来の `if (!request.auth) throw new HttpsError("unauthenticated", ...)` も課しており、匿名の訪問者は検索するたびに汎用エラーで弾かれていた。両ガードを撤去して仕様どおりの動作に修正した）。⚠️ **`searchDomains` 公開化に伴う留意点**: `listTlds` と異なり応答はキャッシュされないため、匿名トラフィックがそのままレジストリの `domain:check` に到達する。`MAX_NAMES = 25` は1回の呼び出しの件数上限にすぎず呼び出し頻度は制限しないため、App Check 等によるレート制限が公開運用の前提条件として別途必要。⚠️ **補足**: 撤去済みの旧 Blocking Function もこの穴は塞いでいなかった — あれはメールドメインのみを判定しており、サインアップウィザードを完了したかどうかは見ていなかったため、許可ドメインのメールアドレスさえ持てば同じ迂回が可能だった。 |
| `purgeAccount` | Task Queue Function (`onTaskDispatched`, `firebase-functions/v2/tasks`) | `docs/仕様/auth.md` §4.9 に対応。`deleteAccountWithPassword`/`deleteAccountWithGoogle` からのみ `getFunctions().taskQueue(`locations/asia-northeast2/functions/purgeAccount`).enqueue({ uid }, { scheduleDelaySeconds: 2592000, id: purgeTaskName })` で積まれる（✅ v1.1 修正: リージョン確定に伴い、キュー名は短縮形ではなく完全修飾形。実装: `functions/src/auth/account-lifecycle.ts`）。Cloud Tasks のディスパッチ認証は Firebase が自動構成し、フロントエンドや他クライアントから呼び出す経路は存在しない。 |
| `cleanupAbandonedGoogleSignups` | Scheduled Function (`onSchedule`, cron `0 0 * * *`, タイムゾーン `Asia/Tokyo`) | `docs/仕様/auth.md` §4.3, §4.9 に対応。毎日日本時間0時に実行し、(a) 7日以上放置された `pending_additional_info` の削除、(b) `onTaskDispatched` の取りこぼしに対する `pending_deletion` の安全網、(c) `purging` のまま1時間以上滞留したドキュメントの再試行、の3パスを行う。外部から呼び出す契約は存在しない。 |

## 4. 定数一覧（契約の一部として固定値を明記）

`functions/src/auth/constants.ts` より（コレクション名のみ `functions/src/config/firebase.ts`）。値を変更する場合は本書・`docs/仕様/auth.md` の該当箇所も更新すること。

| 定数 | 値 | 対応する仕様箇所 |
|---|---|---|
| `ALLOWED_EMAIL_DOMAINS` | `["example.com", "example.net", "example.org"]`（✅ v1.1 修正: 旧 `ALLOWED_EMAIL_DOMAIN` 単一値から複数形・3ドメインに拡張済み） | auth.md §4.1 |
| `SESSION_COOKIE_EXPIRES_IN_MS` | 5日（432,000,000 ms） | auth.md §4.5 手順4 |
| `AUTH_TIME_FRESHNESS_SECONDS` | 300秒（5分） | auth.md §4.8, §4.9 手順6 |
| `CLOCK_SKEW_TOLERANCE_SECONDS` | 60秒（auth_time がサーバ時計よりこれ以上未来なら拒否） | auth.md §8 |
| `PURGE_DELAY_SECONDS` | 2,592,000秒（30日） | auth.md §4.9 手順1 |
| `ABANDONED_SIGNUP_CLEANUP_DAYS` | 7日 | auth.md §4.3 |
| `PURGING_RETRY_DELAY_SECONDS` | 3,600秒（1時間） | auth.md §4.9 手順2d |
| `SESSION_COOKIE_NAME` | `"session"` | 本書 §1.4 |
| `VERIFICATION_CODE_LENGTH` | 6桁 | auth.md §4.1.1 |
| `VERIFICATION_CODE_TTL_MS` | 10分 | auth.md §4.1.1 |
| `VERIFICATION_MAX_ATTEMPTS` | 5回 | auth.md §4.1.1 |
| `VERIFICATION_RESEND_INTERVAL_MS` | 60秒 | auth.md §4.1.1 |
| `VERIFICATION_GRANT_TTL_MS` | 30分 | auth.md §4.1.1 |
| `COLLECTIONS.users` | `"users"`（✅ v1.1 修正: 旧記載の `USERS_COLLECTION` という定数は存在しない。`functions/src/config/firebase.ts` の `COLLECTIONS` オブジェクトで定義） | auth.md §2.1 |
| `COLLECTIONS.verificationCodes` | `"verificationCodes"`（定義場所は同上） | auth.md §2.4 |

## 5. Firestore `users/{uid}` ドキュメント

✅ **v1.1 更新**: スキーマの正本は `docs/仕様/auth.md` §2.1（v1.4 でフルプロフィール構造に全面改訂済み）と実装 `functions/src/auth/types.ts`。トップレベルの `name`/`address`（string）はもはや存在せず、`profile: UserProfile | null` に集約されている（`pending_additional_info` のときのみ `profile: null`）。`purgeTaskName` の補足: Cloud Tasks が払い出す名前ではなく、`functions/src/auth/account-lifecycle.ts` が `randomUUID()` で事前生成し、Firestore への書き込みと `taskQueue().enqueue()` の `id` オプションの両方に使うことで突合させている。

あわせて `verificationCodes/{email}` コレクション（auth.md §2.4）が追加されている。firestore.rules はこのコレクションに限り未認証の `get` を許可する（メール送信手段が無いことの意図的な代替。`list`・書き込みは全拒否）。

## 6. 未決事項（本書スコープ）

- ✅ **解決済み（v1.1）**: 本番デプロイ時の関数リージョン → 全関数 `asia-northeast2` に確定（`functions/src/config/options.ts`）。
- ✅ **解決済み（v1.1）**: Hosting リライト → `firebase.json` に `/api/session/login|logout|me|csrf` のリライトを設定済み（§1.1）。
- ✅ **解決済み（v1.1）**: CSRF トークンの発行・配布方式 → `GET /issueCsrfToken`（§1.5）。
- その他のフロー・セキュリティ上の未決事項は `docs/仕様/auth.md` §8 を参照。

## 7. 変更履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-08-25 | 初版（auth.md v1.3 の実装から抽出、エミュレータ検証済み）。 |
| v1.1 | 2026-08-27 | **実装とのずれを解消（実装追随）**。メール認証 Callable 3本（`startEmailVerification`/`resendEmailVerificationCode`/`verifyEmailCode`）と HTTPS 2本（`GET /issueCsrfToken`/`GET /sessionMe`）を追加。`registerWithEmailPassword`/`submitAdditionalInfo` をフルプロフィール入力（`UserProfile` スキーマ）に更新。`sessionLogout` の CSRF 検証・リクエストボディ・403 を追記。エラーコード表に `not-found`(404)/`resource-exhausted`(429) を追加。リージョンを `asia-northeast2` に確定。定数一覧を現行 `constants.ts` に同期（`ALLOWED_EMAIL_DOMAINS` 複数形・3ドメイン、`CLOCK_SKEW_TOLERANCE_SECONDS`、`VERIFICATION_*`、`USERS_COLLECTION` → `COLLECTIONS.users`）。§5 の「実装との差分なし」という記述を撤回し現行スキーマ参照に修正。 |
