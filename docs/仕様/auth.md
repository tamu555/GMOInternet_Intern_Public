# 認証・アカウント管理 仕様書（確定版）

**最終更新**: 2026-08-27
**ステータス**: 確定（実装済み。v1.4 で実装とのずれを解消、v1.5 で Auth Blocking Functions 撤去と `requireActiveUser` 追加を反映）
**担当**: Claude（指示・設計） → Codex（実装）
**スコープ**: バックエンドのみ（Cloud Functions / Firestore / Firebase Auth 設定）。フロントエンドの画面・ルーティングは別スコープ。

記法は `registrar-spec-draft.md`（チーム作成の仕様書草案・公開版では非収録） の §0.2 に合わせる。

| マーカー | 意味 |
|---|---|
| ✅ **確定** | ユーザーとの合意・仕様上の事実。動かしてはいけない前提 |
| 🔬 **要検証** | 実装前にエミュレータ／公式ドキュメントで裏取りが必要 |
| 🤔 **未決** | 今回は範囲外、または後続で決める設計判断 |
| ⚠️ **落とし穴** | 知らないと事故る仕様 |

本書は初版作成後、Codex CLI による技術レビュー（Firebase Admin SDK / Cloud Functions v2 / Cloud Tasks の API 正確性・競合状態の観点）を受け、指摘を反映した v1.1 である。レビューで洗い出した修正点は §4.8、§4.9、§5、§6、§7 に反映済み。さらに、`docs/firebase/README.md` §4f に本プロジェクト自身の指針として「Cloud Tasks は `firebase-functions/v2/tasks` の `onTaskDispatched` を使い、キューは `firebase deploy` で自動作成する」と明記されていたため、これに合わせて手動 Cloud Tasks キュー作成・手動 OIDC 構成の記述を v1.2 で修正した。詳細は §9 変更履歴を参照。

## 0. 位置づけ

- `registrar-spec-draft.md`（チーム作成の仕様書草案・公開版では非収録） §6.8「会員登録 / ログイン」は本書の内容に**置き換える**。同ドラフトの「パスワードはハッシュ保存」「セッションはサーバサイドセッション or JWT（TBD #10）」は不採用とし、**Firebase Authentication + Firebase Session Cookie** に確定する。
- 会員登録時に集める氏名・住所は、同ドラフト §5.1／§6.8 の「両レジストリへの `contact:create`」で使う想定の項目だが、その連携タイミング・実装（TBD #18）は本書のスコープ外。本書は Firestore `users` コレクションへの保存までを扱う。
- `xxxx@example.com` 等の予約ドメイン制限は、ドラフト §6.8 の「実在アドレス収集はしない」という方針とも整合する（`example.com` / `example.net` / `example.org` はいずれも RFC 2606 の予約ドメインで、実在の受信箱ではない。✅ v1.4: 許可ドメインは3つに拡張済み、§4.1 参照）。

## 1. 確定事項サマリ（ユーザー確認結果）

以下はユーザーへの質問（AskUserQuestion）で確定した実装方針。

| 論点 | 決定 | 理由 |
|---|---|---|
| 登録成功後の Firestore `users` 書き込み | **登録用 Callable Function 内で直接書き込む**（v1 `onCreate` トリガー方式は不採用） | 元の指示文にある「v2は非対応なのでv1を明示的に使う」は、Auth ユーザー作成イベント起点のトリガーを使う場合の技術的制約についての注記だった。実際には氏名・住所などのフォーム入力値は Auth の `UserRecord` に含まれずトリガー側では取得できないため、同一 Callable 内で `createUser` 成功後に直接 Firestore へ書く方式を採用する。これにより v1/v2 トリガーの制約を回避できる。 |
| セッション方式 | **Firebase Session Cookie**（`createSessionCookie` / `verifySessionCookie`） | Firebase 公式のセッション管理方式。有効期限・失効の検証を Firebase 側に任せられ、実装・運用コストが低い。 |
| アカウント削除後30日間の猶予処理 | **Cloud Tasks で30日後に物理削除をスケジュール** | `firebase.json` に既に Cloud Tasks エミュレータ設定があり、プロジェクトの既定路線と一致する。 |
| 実装スコープ | **バックエンドのみ**（Cloud Functions / Firestore / Auth 設定） | `public/` は現在空でフロントエンド技術選定が未了のため。 |

## 2. 用語・データモデル

### 2.1 Firestore コレクション: `users`

要求文中の「User コレクション」に対応する。ドキュメント ID は Firebase Auth の `uid`。

✅ **確定（実装済み。v1.4 で実装 `functions/src/auth/types.ts` に合わせて全面改訂）**: 当初案のトップレベル `name` / `address`（string）は廃止され、フルプロフィールをネストした `profile` オブジェクトに集約した。§8 の旧・未決事項「氏名・住所以外の項目はフォーム確定時に追加」はこの形で解決済み。

```
users/{uid}
  uid: string
  email: string
  authProvider: "password" | "google.com"
  status: "pending_additional_info" | "active" | "pending_deletion" | "purging"
  profile: UserProfile | null    # pending_additional_info のときのみ null。それ以外は必須
  createdAt: Timestamp
  updatedAt: Timestamp
  deletionRequestedAt: Timestamp | null
  scheduledPurgeAt: Timestamp | null
  purgeTaskName: string | null   # Cloud Tasks のタスク名（観測・再試行の突合用）

UserProfile:
  name: string                   # 氏名（最大100文字）
  nameKana: string               # フリガナ（カタカナのみ）
  phoneNumber: string            # 電話番号（最大20文字）
  dateOfBirth: string            # 生年月日
  gender: "male" | "female" | "other" | "no_answer"
  newsletterOptIn: boolean
  accountType: "individual" | "sole-proprietor" | "corporate"
  business: BusinessInfo | null  # accountType が individual 以外のとき必須
  address: JapanAddress | InternationalAddress   # country="JP" かどうかの判別共用体

BusinessInfo:
  companyName: string            # 法人=会社名 / 個人事業主=屋号
  department: string | null
  contactPerson: string

JapanAddress:
  country: "JP", postalCode（〒形式）, prefecture（47都道府県 enum）, city, addressLine, building: string | null

InternationalAddress:
  country: "US" | "GB" | "CN" | "KR" | "TW", postalCode, state: string | null, city, addressLine1, addressLine2: string | null
```

バリデーションの正本は `functions/src/auth/profileSchema.ts`（zod）で、フロントエンドの zod スキーマがこれをミラーする。EPP `contact:create`（registrar-spec-draft.md §5.1, TBD #18）との項目整合は引き続き別途確認。

`status` の意味:

- `pending_additional_info`: Google 登録が開始されたが、氏名・住所などの追加情報が未入力（ログイン不可）。
- `active`: 通常状態。ログイン可能。
- `pending_deletion`: 削除がリクエストされ、30日後の物理削除を待っている状態（新規登録・ログイン不可。復旧のみ可）。
- `purging`: `purgeAccount` が物理削除処理に着手した直後の短時間だけ取る過渡状態（§4.9 参照）。この状態からは復旧できない。

### 2.2 Firebase Authentication 側

- `email/password` プロバイダと `google.com` プロバイダを使用。1メールアドレスにつき1プロバイダのみ許可する（後述 §7.2）。
- Auth 側のメール確認（`emailVerified` / 確認メール送信）は使用しない。Admin SDK 経由の作成はそもそも確認メールを送信しないため、追加対応は不要。
- ✅ **確定（実装済み・v1.4 追記）**: その代わりに、**Firestore ベースの自前メール認証コードウィザード**（§2.4・§4.1.1）を登録の必須事前条件とする。Auth 標準のメール確認機能は使わないという上記方針とは矛盾しない（仕組みが別物）。

### 2.4 Firestore コレクション: `verificationCodes`（v1.4 追記・実装済み）

会員登録ウィザードのステップ2（メール認証）で使う6桁コードの保存先。ドキュメント ID は正規化（trim + 小文字化）したメールアドレス。実装は `functions/src/auth/verification.ts` / `verificationCodes.ts`。

```
verificationCodes/{email}
  email: string
  code: string                   # 6桁コード
  expiresAt: Timestamp           # コードの提出期限（発行から10分）
  attemptsRemaining: number      # 残り試行回数（初期値5）
  resendAvailableAt: Timestamp   # 再送を受け付ける時刻（前回発行から60秒）
  verified: boolean
  verifiedUntil: Timestamp | null  # 認証グラントの有効期限（認証成功から30分）
  createdAt: Timestamp
  updatedAt: Timestamp
```

⚠️ **落とし穴（意図的なトレードオフ）**: 本プロジェクトにはメール送信手段が無いため、コードの受け渡しは「クライアントが自分のアドレスのドキュメントを Firestore から直接 `get` する」ことで代替する。そのため firestore.rules はこのコレクションに限り未認証の `get` を許可している（`list` は不可＝アドレスの列挙は不可。書き込みは Admin SDK のみ）。§7.1 参照。

### 2.3 認証モデルの使い分け（重要・レビューで判明した誤りの修正）

⚠️ **落とし穴**: 本書 v1.0 では「すべての HTTPS/Callable エンドポイントを Session Cookie の共通ヘルパーで保護する」としていたが、これは誤り。Firebase の2つの関数タイプは認証の運び方が異なる。

| 関数タイプ | 認証の運ばれ方 | 検証方法 |
|---|---|---|
| Callable (`onCall`) | クライアントの Firebase Callable SDK が **`Authorization: Bearer <Firebase IDトークン>`** を自動付与する | 関数内で `request.auth`（v2。**`context.auth` ではない**）を参照する。Callable SDK の自動検証は既定で `checkRevoked` を行わない点に注意（§7.3）。 |
| HTTPS (`onRequest`) | Cookie（`session`）または、`/sessionLogin` に限り生の Firebase ID トークンをリクエストボディで受け取る | `session` Cookie を `admin.auth().verifySessionCookie(cookie, true)` で検証する。Cookie の解析・設定は Express 相当の `req`/`res` を素の API で扱う（`cookie-parser` は現状 `functions/package.json` 未導入。導入するか、`req.headers.cookie` を自前でパースする）。 |

この区分に従い、本書の「Callable」と表記された関数はすべて **ID トークン（Callable SDK 経由）** で認証し、「HTTPS (`onRequest`)」と表記された関数のみ **Session Cookie** で保護する。

## 3. 全体フロー（概要）

```
[email/password 登録]
  ステップ2: startEmailVerification → クライアントが verificationCodes/{email} からコードを読む
           → verifyEmailCode（認証グラント発行、30分有効）
  ステップ3〜: registerWithEmailPassword --(グラント確認・検証)--> Auth作成 --(成功)--> Firestore users作成(active)
           --(成功)--> グラント消費 完了
[Google 登録/ログイン共通入口]
  クライアントがGoogle SignInでIDトークン取得
    → POST /sessionLogin { idToken }
        （IDトークンの firebase.sign_in_provider を必ず検証。§4.2-3 参照）
        ├─ users/{uid} 無し            → users作成(pending_additional_info) → additional_info_required 応答（Cookie発行しない）
        ├─ users/{uid} pending_additional_info → additional_info_required 応答（Cookie発行しない）
        ├─ users/{uid} pending_deletion / purging → pending_deletion 応答（Cookie発行しない、復旧導線を提示。purging中は復旧不可）
        └─ users/{uid} active           → Session Cookie 発行 → ok 応答
[additional-info 画面] submitAdditionalInfo 呼び出し（IDトークン認証） → status: active化 → クライアントは再度 /sessionLogin を呼びCookie取得
[ログアウト] POST /sessionLogout → Cookie検証・失効・破棄 → ログイン画面へ
[削除] deleteAccountWithPassword / deleteAccountWithGoogle（要新鮮なIDトークン） →
       Firestoreトランザクションで status: pending_deletion に更新 → Cloud Tasksへ30日後purgeを積む
       → その場で revokeRefreshTokens(uid) を実行しCookie/IDトークンを即時失効
       → クライアントは続けて /sessionLogout を呼びCookie破棄・ログイン画面へ
[30日後] Cloud Tasks → purgeAccount →
       Firestoreトランザクションで pending_deletion→purging に遷移できた場合のみ →
       Authユーザー削除 → 成功後にFirestoreドキュメントを完全削除
[復旧] 猶予期間中に再ログイン(=/sessionLoginでpending_deletion検出) →
       restoreAccount呼び出し（要新鮮なIDトークン） →
       Firestoreトランザクションで pending_deletion→active に戻せた場合のみ成功（purging中は失敗）
[保護区域アクセス] 各エンドポイントで Session Cookie（onRequest）または IDトークン（Callable）を検証。
       いずれも users/{uid}.status === "active" を追加確認する（§7.3）。失敗時は401 + Cookie破棄 → ログイン画面へ
```

## 4. 詳細フロー

### 4.1 登録（メールアドレス＋パスワード）／ §仕様1-①

✅ **確定（v1.4 で実装に合わせて改訂）**: 登録は多段階ウィザードで行い、Auth アカウント作成の**前に**メール認証コード（§4.1.1）を必須とする。

0. **事前条件**: §4.1.1 のメール認証を完了し、有効な認証グラント（`verificationCodes/{email}.verified === true` かつ `verifiedUntil` が未来）を持っていること。グラントが無い場合、`registerWithEmailPassword` は `failed-precondition` で拒否する（ウィザードをスキップして Callable を直接叩いても登録できない）。
1. フロントエンドが登録フォーム値（`email`, `password`, `profile`（§2.1 の `UserProfile` 全項目））を Callable Function `registerWithEmailPassword` に送信する。
2. バックエンドで以下を検証する。
   - メール形式が妥当であること。
   - ✅ **確定（v1.4 で3ドメインに拡張済み）**: メールドメインが `ALLOWED_EMAIL_DOMAINS`（`example.com` / `example.net` / `example.org`、`functions/src/auth/constants.ts`）のいずれかと完全一致（小文字化後）することを確認する。不一致なら `invalid-argument` で拒否する。
   - `profile` が `functions/src/auth/profileSchema.ts` の zod スキーマ（`registrationInputSchema`）を満たすこと（氏名・フリガナ（カタカナ）・電話番号・生年月日・性別・アカウント種別・住所の判別共用体等。旧・未決だったバリデーションルールはこのスキーマで確定済み）。
3. `admin.auth().getUserByEmail(email)` で既存アカウントの有無を確認する（§4.4 の重複チェックに従う）。✅ **確定（既存アカウント検出の前倒し）**: 同じ確認は §4.1.1 の `startEmailVerification`（ステップ2、ドメイン許可リスト確認の直後）でも実行済みのため、ここでの確認は「その後に登録された」競合を拾うための第二防衛線として残す。
4. 問題なければ `admin.auth().createUser({ email, password })` を実行する（**クライアント SDK ではなくバックエンドの Admin SDK で作成する** — 仕様通り）。
5. 作成成功後、**同一関数内で直接** `users/{uid}` を `status: "active"`, `authProvider: "password"` として作成する。
6. ⚠️ **落とし穴**: 手順4は成功したが手順5の Firestore 書き込みが失敗した場合、孤立した Auth アカウントが残る。この場合は **補償処理として `admin.auth().deleteUser(uid)` を実行してロールバックし**、クライアントには `internal` エラーを返して再試行させる。
7. メール確認メールは送信しない（Admin SDK 作成のため送信されない。追加対応不要。メールアドレスの実在性は §4.1.1 のウィザードで登録前に担保済み）。
8. 登録成功後、`consumeEmailVerification` で認証グラントを消費（`verificationCodes/{email}` を削除）する。漏えいした未失効グラントの再利用（2度目の登録）を防ぐ。
9. 登録 API はセッションを発行しない。登録完了後、クライアントは別途ログイン（§4.5）を行う想定。🤔 未決: フロントエンド側で登録直後に自動ログインさせるUXにするかは別途判断。

### 4.1.1 メール認証コードウィザード（v1.4 追記・実装済み）

登録ウィザードのステップ2。実装は `functions/src/auth/verification.ts`。3つの Callable と Firestore 直接読み取りで構成する。

1. **`startEmailVerification`**（Callable、認証不要）: ステップ1のメールアドレス送信時に呼ぶ。冪等（有効なコードが既にあれば再発行しない）。ドメイン許可リスト確認の直後、コード発行前に `admin.auth().getUserByEmail(email)` で既存アカウントの有無を確認し（`functions/src/auth/existingAccount.ts`、`registerWithEmailPassword` と実装を共有）、既に存在すれば `already-exists`（`pending_deletion`/`purging` 中は削除手続き中である旨のメッセージ）で拒否する。ユーザー作成は一切行わない存在確認のみ。問題なければ6桁コードを生成し `verificationCodes/{email}` に保存する。レスポンスにコード自体は**含めない**（`attemptsRemaining` / `expiresAt` / `resendAvailableAt` / `verified` などのステータスのみ）。
2. クライアントは `verificationCodes/{email}` を Firestore から直接 `get` してコードを表示する（§2.4 のトレードオフ。メール送信の代替）。
3. **`verifyEmailCode`**（Callable、認証不要）: ユーザーが入力したコードを照合する。成功すると `verified: true` と `verifiedUntil`（30分後）を設定した認証グラントを発行する。失敗時のエラー:
   - コード未発行 → `not-found`
   - コード期限切れ（10分超過）・グラント期限切れ → `failed-precondition`
   - 試行回数超過（5回） → `resource-exhausted`
   - コード不一致 → `invalid-argument`（`details.attemptsRemaining` で残回数を返す）
4. **`resendEmailVerificationCode`**（Callable、認証不要）: 常に新しいコードを発行する。前回発行から60秒以内は `resource-exhausted` で拒否（レート制限）。
5. 定数（`functions/src/auth/constants.ts`）: `VERIFICATION_CODE_LENGTH = 6`、`VERIFICATION_CODE_TTL_MS = 10分`、`VERIFICATION_MAX_ATTEMPTS = 5`、`VERIFICATION_RESEND_INTERVAL_MS = 60秒`、`VERIFICATION_GRANT_TTL_MS = 30分`（コード提出期限より長いのは、ステップ2通過後に契約者情報・内容確認の入力時間を確保するため）。

### 4.2 登録（Googleアカウント）／ §仕様1-②

1. クライアントは Firebase Client SDK の Google プロバイダでサインインし、ID トークンを取得する（ドメイン制限なし。`example.com` 以外も許容）。
2. クライアントは ID トークンを持って HTTPS エンドポイント `POST /sessionLogin` を呼ぶ（ログインと共通のエントリポイント。§4.5 参照）。
3. ⚠️ **落とし穴（レビューで判明した脆弱性の修正）**: `users/{uid}` が存在しないことだけを根拠に「Google 登録」とみなしてはならない（任意の password ユーザーの ID トークンでも `uid` は初回なら未登録になり得るため）。バックエンドは `admin.auth().verifyIdToken(idToken)` のデコード結果の **`firebase.sign_in_provider` クレームが `"google.com"` であること**を必ず確認したうえで、`status: "pending_additional_info"`, `authProvider: "google.com"`, `email` を持つドキュメントを作成する。既存ドキュメントがある場合は、その `authProvider` と ID トークンの `sign_in_provider` が一致することも確認する（不一致は `permission-denied` で拒否）。この時点では **Session Cookie を発行しない**。
4. レスポンスとして `{ status: "additional_info_required" }` を返す。フロントエンドはこれを見て `/additional-info/` へ遷移する（画面自体は別スコープ）。
5. 追加情報入力後、クライアントは Callable Function `submitAdditionalInfo`（ID トークン認証必須）を呼ぶ。バックエンドは Firestore **トランザクション**で `users/{uid}` を読み、`status === "pending_additional_info"` であることを確認したうえで `name` / `address` 等を保存して `status: "active"` に更新する（§4.3 のクリーンアップとの競合を避けるため、読み取りと状態遷移をトランザクション化する）。
6. クライアントは続けて再度 `POST /sessionLogin` を呼び、今度は `status: "active"` として Session Cookie を取得する（＝登録完了とログインが同一エンドポイントで完結する）。

### 4.3 途中離脱時の Authentication データの扱い（仕様1-②の注記への対応）

- ✅ **確定（設計判断）**: 追加情報入力を待つ間、Firebase Authentication には既にアカウントが作成済みだが、Firestore の `users` ドキュメントは `status: "pending_additional_info"` のままで `active` にならない。この状態では `/sessionLogin` が Cookie を発行しないため、**保護区域には一切入れない**（Firestore 側のガードで防げるため、Auth アカウント単体が残っていてもセキュリティ上の実害はない）。
- 途中離脱後にユーザーが再度 Google サインインした場合は、既存の `uid` に対して手順3〜4がそのまま繰り返され、`/additional-info/` へ再度案内される（データは失われず再開できる）。
- ⚠️ **衛生上の対策**: 追加情報が長期間未入力のまま放置されるとゴミデータが蓄積するため、スケジュール済み Cloud Function `cleanupAbandonedGoogleSignups`（Cloud Scheduler, 例: 毎日1回）を実装し、`status == "pending_additional_info"` かつ `createdAt` が **7日以上前**（🤔 未決・要チーム合意、暫定値）のドキュメントを検出する。
- ⚠️ **落とし穴（レビューで判明した競合状態の修正）**: cleanup がドキュメントを読んだ直後に、ユーザーが `submitAdditionalInfo` を完了させて `active` 化すると、完成したアカウントを誤って削除しかねない。cleanup 側も Firestore **トランザクション**で `status === "pending_additional_info"` かつ `createdAt` 条件を再確認したうえで削除を行い、`admin.auth().deleteUser(uid)` は **Firestore トランザクション成功後にのみ**実行する（`submitAdditionalInfo` 側は §4.2-5 の通り同一ドキュメントに対するトランザクションのため、どちらか一方のみが成功する）。

### 4.4 過去に異なる方法で登録していた場合（仕様1-③）

- ✅ **確定**: 1つのメールアドレスにつき許可する認証方法は1つのみ。異なる方法での重複登録は許可しない。
- **email/password → 既に google.com で登録済み** の場合: `registerWithEmailPassword` の手順3（`getUserByEmail`）で検出し、`already-exists` エラーと共に「Googleアカウントでログインしてください」という案内を返す。
- **google.com → 既に password で登録済み** の場合: 🔬 **要検証**。Firebase Authentication のプロジェクト設定「1つのメールアドレスにつき1アカウント（One account per email address）」を有効にしておけば、クライアントの `signInWithPopup`/`signInWithRedirect` の時点で `auth/account-exists-with-different-credential` エラーが発生し、バックエンドに到達する前にフロントエンドで弾かれる。この設定が有効であることを実装時に確認する。フロントエンド側はこのエラーコードを捕捉し「メールアドレス＋パスワードでログインしてください」と案内する（画面自体は別スコープだが、エラーハンドリング仕様として明記）。
- **`pending_deletion` / `purging` 中に同一メール／同一 Google アカウントで新規登録・ログインを試みた場合**: 仕様4の注記の通り許可しない。`registerWithEmailPassword` は `getUserByEmail` で Auth アカウントがまだ存在することを検出し `already-exists`（「アカウントは削除手続き中です」）で拒否する。`/sessionLogin` は `status: "pending_deletion"` または `"purging"` を検出して Cookie を発行せず、`pending_deletion` の場合のみ復旧導線（§4.9）を提示する（`purging` は復旧不可）。

### 4.5 ログイン（メールアドレス＋パスワード）／ §仕様2-①

- ⚠️ **落とし穴**: Admin SDK には生パスワードを検証する API が存在しない。パスワード照合は必ず **フロントエンドの Firebase Client SDK（`signInWithEmailAndPassword`）側で行う**。バックエンドはその結果得られた ID トークンだけを受け取る。
1. クライアントが `signInWithEmailAndPassword` で認証し、ID トークンを取得する。
2. クライアントは ID トークンを `POST /sessionLogin` に送る。
3. バックエンドは ID トークンを検証し、`users/{uid}` の `status` に応じて分岐する（§3 のフロー図参照）。`status: "active"` なら `admin.auth().createSessionCookie(idToken, { expiresIn })` で Session Cookie を発行し、`Set-Cookie`（`HttpOnly`, `Secure`, `SameSite=Strict`）で返す。
4. ✅ **確定（既定値）**: `expiresIn` は **5日（ミリ秒指定、Admin SDK の `expiresIn` はミリ秒）** とする（Firebase の上限は14日）。🤔 未決: 実際の運用要件に応じて変更可。
5. ⚠️ **CSRF 対策（レビュー指摘 → v1.4 で発行方式も確定・実装済み）**: `/sessionLogin` は認証 Cookie を発行するエンドポイントのため、リクエストボディの `csrfToken` と `X-CSRF-Token` ヘッダーを `timingSafeEqual` で突合するダブルサブミット検証を行い、`SameSite=Strict` と併用する。トークンの発行は **HTTPS エンドポイント `GET /issueCsrfToken`**（Hosting rewrite では `/api/session/csrf`）が担い、`randomBytes` によるランダムトークンを返す（実装: `functions/src/auth/session.ts`）。✅ **v1.4 追記**: 同じダブルサブミット検証は **`/sessionLogout` にも適用される**（§4.7）。

### 4.6 ログイン（Googleアカウント）／ §仕様2-②

- §4.2 と同一の `POST /sessionLogin` エンドポイントを使う。「登録されていないアカウントの場合は登録の際の順序で行わせる」は、`users/{uid}` が存在せず、かつ ID トークンの `sign_in_provider === "google.com"` である場合に `pending_additional_info` を作成して `additional_info_required` を返す分岐（§4.2 手順3-4）がそのまま該当する。
- 「登録されていれば認証をChallengeし」は、Google サインイン自体（クライアント側のポップアップ／リダイレクト認証）がチャレンジに相当する。ID トークンを持って `/sessionLogin` に到達した時点で認証は完了しているため、`status: "active"` であればそのまま Session Cookie を発行する。

### 4.7 ログアウト／ §仕様3

1. `POST /sessionLogout` を呼ぶ。✅ **v1.4 追記（実装済み）**: このエンドポイントも CSRF ダブルサブミット検証を行う。クライアントは `GET /issueCsrfToken` でトークンを取得し、リクエストボディ `{ csrfToken }` と `X-CSRF-Token` ヘッダーの両方に積む。不一致・欠落は `403 permission-denied`。
2. リクエストの `session` Cookie を `verifySessionCookie(cookie, true)` で検証する。
3. 検証に成功した場合、`admin.auth().revokeRefreshTokens(uid)` でリフレッシュトークンを失効させ、当該セッションの再利用を防ぐ（削除フローで既に revoke 済みの場合は冪等に成功する）。
4. 検証の成否に関わらず、レスポンスで `Set-Cookie`（`Max-Age=0`、Cookie 発行時と同じ `Path`/`Secure`/`SameSite` 属性を指定）を返しクライアント側の Cookie を破棄する。
5. クライアントはレスポンス受信後、ログイン画面へ遷移する（画面遷移自体はフロントエンド側の実装）。

### 4.8 アカウント削除（共通設計）／ §仕様4

- ⚠️ **落とし穴**: パスワード再入力・Google再ログインによる「本人確認」も、パスワード検証と同様に **フロントエンドの Firebase Client SDK 側で `reauthenticateWithCredential` を行う**必要がある。バックエンドはその結果新しく発行された ID トークンの新鮮さ（`auth_time`）を検査するのみで、パスワードや Google 認証そのものをバックエンドで検証することはできない。
- ✅ **確定（既定値・レビューで API 誤りを修正）**: これらは Callable Function のため、v2 の `onCall` シグネチャ `(request) => ...` に従い、認証情報は **`request.auth`**（`context.auth` ではない）から取得する。`request.auth.token.auth_time` は UNIX 秒であり、`Date.now() / 1000 - Number(request.auth.token.auth_time)` が **直近5分以内**（🤔 未決・暫定値）であることを確認し、古い場合は `failed-precondition` で拒否して再認証を促す。
- ⚠️ **落とし穴（レビュー指摘: セッション即時失効）**: v1.0 では失効を後続の `POST /sessionLogout` に委ねていたが、通信断・別端末に残る既存セッション・悪意あるクライアントでは Cookie/ID トークンが有効なまま残ってしまう。**削除リクエストを受理した Callable Function 自身の中で** `admin.auth().revokeRefreshTokens(uid)` を実行し、即座に失効させる（`/sessionLogout` 側の revoke は冪等な後始末として残す）。あわせて、すべての保護エンドポイントは Cookie/ID トークンの検証に加えて **`users/{uid}.status === "active"` を都度確認する**（§7.3）。Callable SDK の自動 ID トークン検証は既定で失効チェックを行わないため、この Firestore 側の状態確認が実質的な失効の担保になる。

#### 4.8.1 メールアドレス＋パスワードの場合（仕様4-①）

1. フロントエンドの削除確認モーダルでパスワードを再入力させ、`reauthenticateWithCredential` を実行して新しい ID トークンを取得する。
2. Callable Function `deleteAccountWithPassword`（ID トークン認証必須）を呼ぶ。
3. バックエンドは `auth_time` の新鮮さ（`request.auth.token.auth_time`）と `users/{uid}.authProvider === "password"` を確認する。
4. Firestore **トランザクション**で `users/{uid}` を `status: "pending_deletion"`, `deletionRequestedAt: now`, `scheduledPurgeAt: now + 30日` に更新する。トランザクション成功後、Cloud Tasks へ30日後発火の `purgeAccount` タスクを積む（§4.9）。**タスク登録が失敗した場合は、Firestore の状態を `status: "active"`（deletionRequestedAt/scheduledPurgeAt を null）へ補償的にロールバックし、クライアントには `internal` エラーを返して再試行させる**（`pending_deletion` なのにタスクが存在しない状態を防ぐ。§4.9 参照）。
5. 上記が成功したら、その場で `admin.auth().revokeRefreshTokens(uid)` を実行する。
6. クライアントは成功レスポンスを受けて続けて `POST /sessionLogout` を呼び、Cookie を破棄してログイン画面へ遷移する。

#### 4.8.2 Googleアカウントの場合（仕様4-②）

1. フロントエンドで Google 再ログイン（`reauthenticateWithPopup` 等）を行い、新しい ID トークンを取得する。
2. Callable Function `deleteAccountWithGoogle`（ID トークン認証必須）を呼ぶ。以降は §4.8.1 の手順3〜6と同じ（`authProvider === "google.com"` を確認する点のみ異なる）。

#### 4.8.3 保有ドメインによる退会ブロック（v1.6 で追加）

- ✅ **確定**: 会員が1件以上「現在も保有している」ドメインを持っている間は退会できない。**廃止/移管済み（`lifecycle === "gone"`）は保有とみなさない** — 移管完了・復旧不可のいずれかで、もはや会員の持ち物ではなくなったドメインを指す。§4.8.1 手順4／§4.8.2 の Firestore トランザクション（`users/{uid}` を `pending_deletion` に更新する部分）の中で、`domains` コレクションに対して当該 `uid` を所有者とするドキュメントを読み（`functions/src/domain/domainRepository.ts` の `ownedDomainsQuery` — 一覧 Callable `listDomains` と共通の1つのクエリ定義）、`gone` を除いた件数を数える（`account-lifecycle.ts` の `countOwnedDomainsInTransaction`、`domainRepository.ts` の `deriveDomainLifecycle` — `lifecycle` フィールドが存在しないレガシーなミラーは `status` 配列から同じ規則でフォールバック導出する。`listOwnedDomains` が返す `pendingDelete`（解約手続き中・まだ復旧可能）は「保有中」として数えるが、`gone` は数えない）。件数が1以上であれば `status` 更新を行わずトランザクションを中断し、`failed-precondition` を返す。エラーの `details` は `{ reason: "domains_owned", count: <件数> }`、メッセージは「保有中のドメインがあるため退会できません。先にドメインを廃止または移管してください。」で固定する。⚠️ `gone` を除外しない設計だと、正しくすべてのドメインを廃止・移管し終えた会員が「先に廃止・移管してください」という案内に永久に従えなくなる（`domains/{uid}__{name}` ドキュメントは `gone` になった後も削除されず残り続けるため）。
- 判定を専用の事前チェック（別クエリ・別トランザクション）ではなく `pending_deletion` へ書き込むのと同じトランザクション内で行っているのは、TOCTOU（判定と書き込みの間に新しいドメインが登録される競合状態）を避けるため。Firestore トランザクションはこのクエリが読んだドキュメント集合に対する競合を検出して自動リトライするため、判定と `pending_deletion` への書き込みは1つの原子的な単位になる。
- §4.9（猶予期間・物理削除・復旧）はこの節の影響を受けない: `purgeAccount`・`restoreAccount` は従来通り `users/{uid}` のみを操作し、`domains` コレクションには一切触れない。ドメインは退会（`pending_deletion` 遷移）そのものが起きないため、猶予期間中の自動更新（オートレニュー）停止や移管・削除が自動的に発生することもない。会員はあらかじめマイページのドメイン一覧からドメインを廃止（削除）または移管してから、退会を申請する必要がある。
- フロントエンド（`frontend/src/features/mypage/DeleteAccountDialog.tsx`）はダイアログを開いた時点で `listDomains` を呼び、`lifecycle !== "gone"` のドメインが1件以上あれば保有件数と「ドメイン一覧へ」の導線を表示し、本人確認ステップへ進めないようにする（バックエンドと同じ `gone` 除外規則。`listDomains` の応答は各ドメインの `lifecycle` を既に含むため、フロントエンドで別途判定ロジックを持つ必要はない）。この事前チェックはあくまで UX 上の早期案内であり、権威ある判定はバックエンドの上記トランザクションである。事前チェックがすり抜けた場合（事前チェック後にドメインを新規登録した、事前チェック自体の通信が失敗して先へ進んでしまった等）でも、`deleteAccountWithPassword`/`deleteAccountWithGoogle` は上記の `failed-precondition` を返すため、フロントエンドは同じ文言でこれを表示する。

### 4.9 30日間の猶予期間・物理削除・復旧処理／ §仕様4の注記

⚠️ **本節はレビューで指摘された Critical な競合状態（purge と restore の TOCTOU）を修正した設計。** `pending_deletion` → `purging` → 削除完了、または `pending_deletion` → `active`（復旧）のいずれか一方だけが成立するよう、Firestore トランザクションを唯一の直列化ポイントとする。

1. ✅ **確定（`docs/firebase/README.md` §4f に基づき手段を修正）**: `purgeAccount` は生の `onRequest` + 手動 Cloud Tasks クライアントではなく、**`firebase-functions/v2/tasks` の `onTaskDispatched`** として実装する（キューは `firebase deploy` 時に自動作成され、ディスパッチの認証も Firebase が管理するため、§4.9 v1.1 で記述した手動 OIDC/サービスアカウント構成は不要）。削除リクエスト時（§4.8）に `getFunctions().taskQueue(`locations/${REGION}/functions/purgeAccount`).enqueue({ uid }, { scheduleDelaySeconds: 60 * 60 * 24 * 30, id: purgeTaskName })` で30日後実行のタスクを積む（✅ v1.4 修正: リージョン確定（§6）に伴い、実装 `functions/src/auth/account-lifecycle.ts` はキュー名を短縮形ではなく `locations/asia-northeast2/functions/purgeAccount` の完全修飾形で指定している）。🔬 **要検証**: Cloud Tasks の `scheduleDelaySeconds` に許容される最大遅延（一般に30日程度が上限とされる）が30日ぴったりの指定に対して問題ないか、実装時に公式ドキュメントで確認する。境界値が問題になる場合は数分短縮するか、次項の日次リコンサイル関数を主経路に位置づける。タスク名は `users/{uid}.purgeTaskName` に記録する（観測用。タスクのキャンセルには使わない）。
2. `purgeAccount`（`onTaskDispatched`）が発火したら:
   a. Firestore **トランザクション**で `users/{uid}` を読み、`status === "pending_deletion"` の場合のみ `status: "purging"` に更新してコミットする。それ以外（ドキュメントが存在しない、または `status` が `"active"`（＝復旧済み）や既に `"purging"`）の場合はトランザクション内で更新を行わず、何もせず200を返す（＝復旧済みなら安全に無視する冪等ガード）。
   b. トランザクションで `"purging"` への遷移に成功した場合のみ、`admin.auth().deleteUser(uid)` を実行する。
   c. `deleteUser` が成功したら、`users/{uid}` の Firestore ドキュメントを完全に削除する。
   d. `deleteUser` が失敗した場合（一時的エラー等）、ドキュメントは `"purging"` のまま残す。この状態からは復旧できない（手順2aの前提を満たさないため）。⚠️ **落とし穴**: `"purging"` のまま放置されるとゴミが残るため、`cleanupAbandonedGoogleSignups`（日次スケジュール関数、§4.3）の対象を拡張し、`status === "purging"` かつ `updatedAt` が一定時間（例: 1時間）以上前のドキュメントを検出して `deleteUser` と Firestore 削除を再試行する（🤔 未決・具体的な再試行間隔とリトライ上限）。
3. ✅ **確定（`onTaskDispatched` 採用によりセキュリティ構成を簡素化）**: `firebase-functions/v2/tasks` の `onTaskDispatched` はディスパッチの認証（Cloud Tasks からの呼び出しであることの検証）を Firebase が自動的に構成する。v1.1 で記述した手動の専用サービスアカウント・`roles/run.invoker`・OIDC audience の手動設定は不要（`onTaskDispatched` が内部で同等の保護を行う）。追加の防御として、ハンドラ冒頭で §4.9 手順2a のトランザクションガード（`status === "pending_deletion"` チェック）を必ず経由させることで、想定外の重複ディスパッチ・リトライに対しても冪等に振る舞う。🔬 **要検証**: ローカルの Cloud Tasks エミュレータは単純な HTTP 呼び出しとして扱われ、本番の認証・リトライ挙動を完全には再現しない（`docs/firebase/README.md` §4f）。ローカルではハンドラのロジックと冪等性のみを確認し、実際のディスパッチ認証は実プロジェクトでの結合テストで確認する。
4. ⚠️ **安全網**: タスクの取りこぼし（enqueue 失敗のロールバック漏れ、ディスパッチ失敗等）に備え、`cleanupAbandonedGoogleSignups`（§4.3, §5）の日次実行時に `status === "pending_deletion"` かつ `scheduledPurgeAt` が既に過ぎているドキュメントも検出し、`purgeAccount` 相当の処理（§4.9 手順2a〜2c と同じトランザクションガード付き削除）を実行することで、`onTaskDispatched` タスクが何らかの理由で発火しなかった場合のセーフティネットとする。
5. **復旧**: 猶予期間中にユーザーが再ログインを試みると、`/sessionLogin` が `status: "pending_deletion"` を検出し、Cookie を発行せずに `{ status: "pending_deletion", scheduledPurgeAt, daysRemaining }` を返す（`status: "purging"` の場合は復旧不可として扱い、通常のログイン不可エラーを返す）。フロントエンドはこれを見て「復旧しますか？」という案内を表示する（画面は別スコープ）。
6. ユーザーが復旧を選ぶと、Callable Function `restoreAccount`（ID トークン認証必須）を呼ぶ。§4.8 と同様に **`request.auth.token.auth_time` の新鮮さ（直近5分以内）を確認する**（レビュー指摘: 削除直前に窃取された古い ID トークンによる不正な復旧を防ぐため、削除系 Callable と同じ新鮮さチェックを課す）。そのうえで Firestore **トランザクション**で `users/{uid}` を読み、`status === "pending_deletion"` かつ `scheduledPurgeAt > now` の場合のみ `status: "active"`, `deletionRequestedAt: null`, `scheduledPurgeAt: null`, `purgeTaskName: null` に更新する。`status` が既に `"purging"` に遷移していた場合はトランザクションが失敗条件に合致し、`failed-precondition` を返す（＝2の手順とはFirestore側で自然に排他される）。
7. 復旧後、クライアントは再度 `POST /sessionLogin` を呼んで通常通り Session Cookie を取得する。

### 4.10 セッション切れ／ §仕様5

- 保護対象の各エンドポイントは、§2.3 の区分に従い Callable なら `request.auth`、`onRequest` なら `session` Cookie（`verifySessionCookie(cookie, true)`）で検証する。
- いずれの経路でも、検証成功後に **`users/{uid}.status === "active"` を追加確認する**（§4.8 の通り、Callable SDK の自動検証は既定で失効チェックをしないため）。
- `onRequest` 系で検証に失敗した場合（期限切れ・失効・欠落）は 401 を返し、レスポンスで `Set-Cookie`（`Max-Age=0`）を付与して失効済み Cookie をクライアント側からも破棄する。Callable 系で失敗した場合は `unauthenticated` エラーを返す。
- フロントエンドは 401 / `unauthenticated` を受けたらログイン画面へ強制的に遷移させる（画面遷移自体は別スコープだが、バックエンドの応答仕様としてここに明記する）。

## 5. Cloud Functions 一覧

| 関数名 | 種別 | 認証方式 | 役割 |
|---|---|---|---|
| `registerWithEmailPassword` | Callable (v2 `onCall`) | 不要 | §4.1（メール認証グラントを事前条件とする） |
| `startEmailVerification` | Callable (v2 `onCall`) | 不要 | §4.1.1 手順1（コード発行、冪等） |
| `resendEmailVerificationCode` | Callable (v2 `onCall`) | 不要 | §4.1.1 手順4（コード再発行、60秒レート制限） |
| `verifyEmailCode` | Callable (v2 `onCall`) | 不要 | §4.1.1 手順3（コード照合・グラント発行） |
| `issueCsrfToken` (`GET /issueCsrfToken`, rewrite: `/api/session/csrf`) | HTTPS (`onRequest`) | 不要 | §4.5 手順5（CSRF トークン発行） |
| `sessionMe` (`GET /sessionMe`, rewrite: `/api/session/me`) | HTTPS (`onRequest`) | Session Cookie | セッション復帰用。Cookie 検証＋ `status === "active"` 確認後、`{ id, email, displayName }` を返す（§4.10 の適用例） |
| `sessionLogin` (`POST /sessionLogin`) | HTTPS (`onRequest`) | ID トークン（ボディ）+ CSRF トークン | §4.2, §4.5, §4.6, §4.9-4 |
| `submitAdditionalInfo` | Callable (v2 `onCall`) | ID トークン（`request.auth`） | §4.2 手順5 |
| `sessionLogout` (`POST /sessionLogout`) | HTTPS (`onRequest`) | Session Cookie | §4.7 |
| `deleteAccountWithPassword` | Callable (v2 `onCall`) | ID トークン（`request.auth`、新鮮さ必須） | §4.8.1 |
| `deleteAccountWithGoogle` | Callable (v2 `onCall`) | ID トークン（`request.auth`、新鮮さ必須） | §4.8.2 |
| `purgeAccount` | Task Queue Function (v2 `onTaskDispatched`, `firebase-functions/v2/tasks`) | Cloud Tasks ディスパッチ認証（Firebase が自動構成） | §4.9 |
| `restoreAccount` | Callable (v2 `onCall`) | ID トークン（`request.auth`、新鮮さ必須） | §4.9 手順6 |
| `cleanupAbandonedGoogleSignups` | Scheduled Function | - | §4.3、§4.9 手順2d の「purging」滞留回収、§4.9 手順4 の取りこぼし安全網も兼ねる |

> ⚠️ **削除の記録（2026-08-27）**: 上表にはかつて `enforceAllowedEmailDomainOnCreate`（Auth Blocking Function, `beforeUserCreated`）と no-op の `beforeUserSignedIn` を防御層として掲載していたが、実プロジェクト `teamc-2026` への `firebase deploy` で `400 OPERATION_NOT_ALLOWED : Blocking Functions may only be configured for GCIP projects.` が発生し続け（本プロジェクトは Identity Platform 未アップグレードの素の Firebase Auth のため）、トリガー登録に失敗してデプロイ全体が exit 1 になっていたことが判明した。両関数は `functions/src/auth/blocking.ts` ごと撤去し、メールドメイン制限は §4.1 の `registerWithEmailPassword`（`registration.ts` の `isAllowedEmailDomain`）と `verification.ts`（`parseEmail`）のチェックに一本化した。詳細は下記 §6・§7.4、および §9 の変更履歴 v1.5 を参照。

## 6. Firebase / インフラ設定

- ❌ **確定 → 撤回（2026-08-27）**: ~~Blocking Functions を使うため、プロジェクトを Identity Platform 経由の Firebase Authentication にアップグレードする（`docs/firebase/README.md` §4b 参照）。料金影響はチームで事前確認する。~~ 実プロジェクト `teamc-2026` への `firebase deploy` で `400 OPERATION_NOT_ALLOWED : Blocking Functions may only be configured for GCIP projects.` が発生した（`teamc-2026` は Identity Platform 未アップグレードの素の Firebase Auth）。Blocking Functions（`functions/src/auth/blocking.ts`）自体を撤去したため、Identity Platform へのアップグレードは不要になった。メールドメイン制限は `registration.ts` / `verification.ts` の実行時チェックのみで担保する（§4.1, §7.4）。
- ✅ **確定**: Firebase Authentication の「1つのメールアドレスにつき1アカウント（One account per email address）」設定を有効化する（§4.4 の重複防止の前提）。
- `firebase.json` の `auth.providers.googleSignIn` は既存設定を流用する。
- ✅ **確定**: `purgeAccount` は `firebase-functions/v2/tasks` の `onTaskDispatched` として実装する。`docs/firebase/README.md` §4f の通り、Cloud Tasks キューは手動作成せず `firebase deploy` 時に自動作成される。✅ **確定（v1.4 で解決済み）**: リージョンは全関数一律 **`asia-northeast2`**（Firestore と同一）に確定した。`functions/src/config/options.ts` の `setGlobalOptions({region: REGION})` でピン留めし、Hosting rewrite（`firebase.json`）も同リージョンを明示指定している。
- Session Cookie を扱う `onRequest` 関数（`sessionLogin` / `sessionLogout`）は Cookie ヘッダーの読み書きに Express 相当の `req`/`res` を使う。`cookie-parser` は `functions/package.json` に未導入のため、導入するか `req.headers.cookie` を自前でパースする方針を実装時に選ぶ（🤔 未決）。Cookie 設定/削除は `Path`・`Secure`・`SameSite` などの属性を発行時・破棄時で一致させる。
- ローカル開発: `firebase.json` の `emulators.tasks` は設定済み。Cloud Tasks エミュレータは本番のディスパッチ認証・リトライ挙動を完全には再現しないため（`docs/firebase/README.md` §4f）、ローカルではハンドラのロジックと冪等性のみを確認する（§4.9 手順3）。⚠️ Auth Blocking Functions（`beforeUserCreated` / `beforeUserSignedIn`）は本プロジェクトが Identity Platform 未アップグレードのため不採用となり、`functions/src/auth/blocking.ts` ごと撤去済み（§6 参照）。旧来のエミュレータ既知の不具合の記録は §8 に履歴として残す。

## 7. セキュリティ上の注意

1. Firestore セキュリティルールは原則 `allow read, write: if false;`（全拒否）とし、読み書きは Cloud Functions の Admin SDK 経由（ルールをバイパス）で行う。✅ **v1.4 修正（実装済みの例外）**: ただし `verificationCodes/{email}` のみ、未認証クライアントからの `get` を許可している（§2.4 のメール送信代替。`list` と書き込みは全拒否のまま）。実体は `firestore.rules` を参照。🤔 未決: 将来的にクライアントから自分の `users/{uid}` を直接読む必要が出た場合はルールを緩和する。
2. `purgeAccount` は `onTaskDispatched` として実装し、Cloud Tasks ディスパッチ以外から実行されないという Firebase の既定保護に加え、ハンドラ冒頭のトランザクションガードで冪等性を担保する（§4.9 手順3）。
3. 削除系・復旧系 Callable（`deleteAccountWithPassword` / `deleteAccountWithGoogle` / `restoreAccount`）は `request.auth.token.auth_time` の新鮮さを必ず確認する（§4.8, §4.9 手順6）。
4. ドメイン制限（`ALLOWED_EMAIL_DOMAINS` の3ドメイン）はバックエンドの `registerWithEmailPassword`（`registration.ts` の `isAllowedEmailDomain`）でチェックする（§4.1）。さらにメール認証（§4.1.1）の `startEmailVerification` も同じヘルパーを `verification.ts` の `parseEmail` 経由で使い、入口を制限する。⚠️ **既決定の訂正（2026-08-27）**: 当初はここに Auth Blocking Function（`enforceAllowedEmailDomainOnCreate`）による二重チェックを加える計画だったが、本プロジェクト（`teamc-2026`）は Identity Platform 未アップグレードの素の Firebase Auth であり、Blocking Functions のデプロイが `400 OPERATION_NOT_ALLOWED` で恒常的に失敗するため撤去した（§6 参照）。いずれのチェックも Auth ユーザー作成前に実行されるため、許可外ドメインでの登録は Auth 上に痕跡を残さない。
5. Callable Function の自動 ID トークン検証（Callable SDK による）は既定で失効チェック（`checkRevoked`）を行わない。そのため、削除リクエスト受理時に即座に `revokeRefreshTokens` を実行することに加え、**すべての保護エンドポイントで `users/{uid}.status === "active"` を都度確認する**ことを失効の実質的な担保とする（§4.8, §4.10, §2.3）。
6. `/sessionLogin` は認証 Cookie を発行するため、CSRF 対策（ダブルサブミット等のトークン検証）を必須とする（§4.5 手順5）。
7. エラーメッセージは、内部実装の詳細を露出しない簡潔な文言にする。

## 8. 未決事項・要検証事項まとめ

- ✅ **解決済み（v1.4）**: 登録フォームの正式な項目とバリデーションルール → `functions/src/auth/profileSchema.ts`（zod）で確定（§2.1）。
- ✅ **解決済み（v1.4）**: `/sessionLogin` の CSRF トークンの発行・検証方式 → `GET /issueCsrfToken` によるダブルサブミット方式で確定（§4.5 手順5。`/sessionLogout` にも適用）。
- ✅ **解決済み（v1.4）**: 関数リージョン → 全関数 `asia-northeast2` に確定（§6、`functions/src/config/options.ts`）。
- 🤔 `submitAdditionalInfo` 未完了データのクリーンアップ猶予（暫定7日）。
- 🤔 Session Cookie の有効期限（暫定5日）。
- 🤔 削除・復旧系 Callable の再認証新鮮さ許容時間（暫定5分。実装にはクロックスキュー許容 `CLOCK_SKEW_TOLERANCE_SECONDS = 60秒` も追加済み — `auth_time` がサーバ時計より60秒超未来なら拒否する。`functions/src/auth/auth-helpers.ts` の `isAuthTimeFresh`）。
- 🤔 登録直後にフロントエンドが自動ログインさせるか。
- 🤔 `cookie-parser` を導入するか自前パースにするか。
- 🤔 `"purging"` 滞留（`deleteUser` 失敗後の再試行）の具体的な間隔・リトライ上限。
- 🔬 「1つのメールアドレスにつき1アカウント」設定の実際の有効化方法と、無効時の代替防御（サーバー側での二重チェック要否）。**未検証**（実プロジェクトでの確認が必要。エミュレータでは検証不可）。
- 🔬 `onTaskDispatched` の `scheduleDelaySeconds` に許容される最大遅延。**未検証**（ドキュメント調査が必要。リージョン整合の方は解決済み: 上記の通り `asia-northeast2` に統一し、タスクは `locations/asia-northeast2/functions/purgeAccount` の完全修飾名で積む）。
- ✅ **エミュレータで検証済み**（2026-08-25、**2026-08-27追記: 対象の Blocking Functions は撤去済み。§6・§7.4・§9 v1.5 参照**）: Auth Blocking Functions はエミュレータ上で `enforceAllowedEmailDomainOnCreate`（`beforeUserCreated`）と no-op の `beforeUserSignedIn` が両方とも起動時に正しく登録され、§8.3 の「片方のみ登録での起動失敗」問題は再現しなかった（firebase-tools@15.28.1）。⚠️ **運用上の注意（新規判明）**: ただし長時間起動しっぱなしの開発用コンテナでは、Functions エミュレータのホットリロードが続くうちに Auth↔Functions 間のブロッキングトリガー接続が失われ、ブロッキング関数が無音のまま発火しなくなる現象を観測した（`docker restart` で復旧）。開発中にドメイン制限が効いていないと感じたら、まずエミュレータを再起動すること。`docs/firebase/README.md` §8.3 に追記推奨。
- ✅ **エミュレータで検証済み**（2026-08-25、**2026-08-27追記: 対象の Blocking Functions は撤去済み。§6・§7.4・§9 v1.5 参照**）: `event.eventType` は `"providers/cloud.auth/eventTypes/user.beforeCreate:password"`、`event.additionalUserInfo` は `{ providerId: "password", isNewUser: true }` という実際の形を確認し、`blocking.ts` の `isPasswordProviderCreation` の実装はこの形に対して正しく動作する。起動直後に一度だけ `eventType: "undefined"`（文字列）の疑似イベントが飛ぶことがあるが、コードは例外を投げず安全に通過する。
- ⚠️ **エミュレータで再現した既知の問題（新規実装のバグではない）**（**2026-08-27追記: 対象の Blocking Functions は撤去済み。§6・§7.4・§9 v1.5 参照**）: `docs/firebase/README.md` §4b/§8.4 に記載の [firebase-tools Issue #6235](https://github.com/firebase/firebase-tools/issues/6235) の通り、Admin SDK 経由で直接 `createUser()` した場合はエミュレータ上で `enforceAllowedEmailDomainOnCreate` が発火しなかった。`registerWithEmailPassword` 自体はアプリ側のドメインチェック（`registration.ts`）が `createUser()` 呼び出し前に必ず通るため実害はなかったが、この不確定性も撤去の一因である。
- ✅ **エミュレータで検証済み**（2026-08-25）: `purgeAccount`（`onTaskDispatched`）は Tasks エミュレータでキューが自動作成され、`enqueue()` → ディスパッチ → `pending_deletion → purging` トランザクション → `deleteUser` → Firestore ドキュメント完全削除、という一連の流れがローカルで実際に動作することを確認した。ただし本番の Cloud Tasks 認証（IAM/OIDC）はエミュレータでは再現されないため、そちらは別途実プロジェクトでの確認が必要（§4.9 手順3は変更なし）。
- 🤔 EPP `contact:create`（`registrar-spec-draft.md` TBD #18）との連携タイミング・項目整合。

## 9. 変更履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-08-25 | 初版確定。ユーザーへのヒアリング結果（Firestore書き込み方式・セッション方式・削除猶予方式・実装スコープ）を反映。 |
| v1.1 | 2026-08-25 | Codex CLI による技術レビューを反映。主な修正: (1) 削除→復旧→purgeの競合状態をFirestoreトランザクション（`purging`中間状態）で解消、(2) 削除リクエスト時に即座に`revokeRefreshTokens`を実行、(3) v2 Callableの認証情報は`context.auth`ではなく`request.auth`、(4) Callable(IDトークン)とonRequest(Session Cookie)の認証モデルを明確に区別、(5) `/sessionLogin`のGoogle新規登録判定に`sign_in_provider`クレームの検証を追加、(6) Blocking Functionのプロバイダ判定を`providerData[0]`から`additionalUserInfo.providerId`等へ修正、(7) `/sessionLogin`にCSRF対策を追加、(8) Cookie解析のAPI詳細とCloud Tasksの認証構成を具体化。 |
| v1.2 | 2026-08-25 | `docs/firebase/README.md` §4f（本プロジェクト自身のCloud Tasks方針）との整合を取り、`purgeAccount`の実装手段を手動`onRequest`+手動Cloud Tasksクライアント/OIDC構成から`firebase-functions/v2/tasks`の`onTaskDispatched`（キュー自動作成・ディスパッチ認証自動構成）に修正。あわせてタスク取りこぼしに備えた日次セーフティネットを追加。 |
| v1.3 | 2026-08-25 | `functions/src/` に実装完了（Codex、1回の再委任でCritical/High競合状態6件を修正済み）。実装後にFirebase Local Emulator Suiteで実地検証を実施し、§8の要検証項目のうち4点を確認済みに更新（Auth Blocking Functionsの起動・発火／`onTaskDispatched`のディスパッチ／ブロッキング関数イベントの実際のペイロード形状）。エミュレータ限定の既知不具合（Admin SDK直接呼び出し時にブロッキング関数が発火しない、長時間起動でブロッキングトリガー接続が失われる）を新たに記録。「1メールアドレス1アカウント」設定と`onTaskDispatched`のリージョン/遅延上限は実プロジェクトでの確認待ちのまま。 |
| v1.4 | 2026-08-27 | **実装とのずれを解消（実装追随・仕様変更の意図なし）**。(1) §2.1 `users/{uid}` をフルプロフィール構造（`profile` オブジェクト: `nameKana`/`phoneNumber`/`dateOfBirth`/`gender`/`newsletterOptIn`/`accountType`/`business`/住所判別共用体）へ全面改訂。(2) メール認証コードウィザード（`startEmailVerification`/`resendEmailVerificationCode`/`verifyEmailCode`、`verificationCodes` コレクション、登録の必須事前条件化）を §2.4・§4.1.1 として文書化。(3) 許可メールドメインを `ALLOWED_EMAIL_DOMAINS`（3ドメイン）に更新。(4) CSRF トークン発行を `GET /issueCsrfToken` で確定、`/sessionLogout` の CSRF 検証を追記。(5) `GET /sessionMe` を §5 に追加。(6) リージョンを `asia-northeast2` に確定、Cloud Tasks キュー名の完全修飾形を反映。(7) §7.1 の firestore.rules 例外（`verificationCodes` の `get` 許可）を反映。(8) 新鮮さ判定のクロックスキュー許容（60秒）を §8 に追記。 |
| v1.5 | 2026-08-27 | Auth Blocking Functions（`enforceAllowedEmailDomainOnCreate`、no-op の `beforeUserSignedIn`、`functions/src/auth/blocking.ts`）を撤去。実プロジェクト `teamc-2026`（Identity Platform 未アップグレードの素の Firebase Auth）への `firebase deploy` が `400 OPERATION_NOT_ALLOWED : Blocking Functions may only be configured for GCIP projects.` で失敗し続けていたため（42関数はデプロイ成功、2関数がエラーで exit 1）。メールドメイン制限は `registration.ts`（`isAllowedEmailDomain`）・`verification.ts`（`parseEmail`）のみで担保する方針に一本化。あわせて、`request.auth` だけでは「有効な ID トークンを持つが `registerWithEmailPassword` を経ていない呼び出し元」を排除できない別の穴を塞ぐため、`functions/src/api/` 配下の会員向け Callable 全般の先頭に `requireActiveUser`（`functions/src/auth/callerGuard.ts`）による `users/{uid}` 存在・`status === 'active'` チェックを追加（詳細は `docs/仕様/api-auth.md` §3）。あわせて `searchDomains` は `requireActiveUser` と旧来の `request.auth` 必須ガードの両方を撤去し、`listTlds` / `devForceRegistry503` と並ぶ認証不要の公開 Callable にした（検索画面は元から公開ルート設計であり、ログインが必要なのは購入から。仕様に実装を合わせた修正）。 |
| v1.6 | 2026-08-28 | §4.8.3 を新設: 保有ドメインがある会員の退会をブロックする設計を追加。動機は「退会（purge）後もドメインは Firestore/レジストリ双方に残り続けるが、以後 `users/{uid}` が存在しないためオートレニューを止める手段が誰にもなくなる」というオーファン化リスク（レジストリ側での自動更新・課金が永続する）。`prepareDeletion` のトランザクション内で `domains` の所有件数（`domainRepository.ts` の `ownedDomainsQuery`、`listDomains` と共通定義）を、`lifecycle === "gone"`（移管完了・復旧不可）を除いて数え（`deriveDomainLifecycle` で `toDomainListItem` と同じ規則を再利用）、1件以上なら書き込み前に `failed-precondition`（`details: { reason: "domains_owned", count }`）で中断する。初版では `gone` を含む全件を保守的にブロック対象としていたが、それだとすべてのドメインを正しく廃止・移管し終えた会員が二度と退会できなくなる矛盾（`domains/{uid}__{name}` ドキュメントは `gone` になった後も削除されない）に気づき、レビューで `gone` 除外に修正。§4.9（猶予期間・物理削除・復旧）は無変更（`purgeAccount`/`restoreAccount` は元々ドメインに触れない）。フロントエンドの退会ダイアログは開いた時点で `listDomains` を呼び、`lifecycle !== "gone"` の保有件数が1件以上であれば本人確認ステップへ進めないようにする事前案内を追加（同じ除外規則、`listDomains` が返す `lifecycle` をそのまま利用）。 |
