# Frontend — auth flows (FIG.5-8) + domain search & order flow (FIG.1)

React + TypeScript (Vite) implementation of the four authentication flows and
the domain search + order flow drawn in `docs/api-flow-diagrams.html`:

| Figure | Flow | Main files |
|---|---|---|
| FIG.1 | ドメイン検索・類似候補提案（左半分） | `src/features/domains/DomainSearchPage.tsx`, `src/api/domainsSearchApi.ts` |
| FIG.1 | 申込フォーム → 疑似決済 → 注文結果・完了（右半分） | `src/features/orders/`, `src/api/ordersApi.ts`, `src/api/eppResultMessages.ts` |
| FIG.5 | 新規登録（1画面・仕様§3.4準拠版） | `src/features/auth/RegisterPage.tsx`, `src/api/authApi.ts` |
| — | 新規登録ウィザード（アカウント作成 → メール認証 → 契約者情報 → 内容確認 → 完了） | `src/features/signup/`, `src/api/signupApi.ts` |
| FIG.6 | ログイン | `src/features/auth/LoginPage.tsx`, `src/auth/AuthProvider.tsx` |
| FIG.7 | セッション復帰 | `src/auth/AuthProvider.tsx`, `src/auth/tokenStorage.ts` |
| FIG.8 | 保護ルートリダイレクト | `src/auth/RequireAuth.tsx`, `src/auth/returnTo.ts`, `src/api/httpClient.ts` |
| FIG.9 | マイページ：ドメイン一覧（2区画）＋移管OUT通知 | `src/features/mypage/MyPage.tsx`, `src/api/myDomainsApi.ts` |
| FIG.10 | マイページ：ドメイン詳細（更新・DNS・ロック・authInfo・廃止/復旧） | `src/features/mypage/DomainDetailPage.tsx`, `src/features/orders/RenewCompletion.tsx` |
| FIG.3 上帯 | 移管IN（§6.6.2）：申請フォーム `/mypage/transfer` ＋ マイページの進捗区画・取り下げ | `src/features/transfer/`, `src/api/transferApi.ts`（実 callable: `requestTransfer` / `cancelTransfer` / `listTransfers` / `getTransferStatus`） |
| FIG.3 下帯 | 移管OUT（§6.6.1）：マイページの承認/拒否バナー（20分自動承認の注意付き） | `src/features/mypage/MyPage.tsx`, `src/api/transferApi.ts`（実 callable: `listTransfers` / `respondTransfer`） |

## Run（Firebaseエミュレータ + callable 構成 / 2026-08-25移行）

通信層は **Firebase callable 関数**（ローカルエミュレータ）に移行済み。実Firebaseプロジェクトには**一切接続しない**（プロジェクトIDは `demo-teamc-2026` — `demo-` プレフィックスで完全オフラインが保証される。無料枠超過防止のため実サービスへのアクセスは禁止）。

起動は3ステップ（ターミナル別）:

```bash
# 1. エミュレータ（要 Docker Desktop）
cd docs/firebase && docker compose up --build   # Emulator UI: http://localhost:4000

# 2. Functions のビルド（エミュレータはコンパイル済み lib/ を読む。
#    docker compose 起動時は自動ビルドされるため通常は不要）
cd functions && npm run build          # バックエンド実装（codebase: default）

# 3. フロント
cd frontend && npm run dev             # http://localhost:5173
```

```bash
npm test         # vitest（ネットワーク・エミュレータ不要）
npm run build    # tsc -b && vite build
npm run lint     # oxlint
```

⚠️ **運用注意（Windows）**
- エミュレータは `lib/` の**自動リロードが効かない**（バインドマウントの変更通知が伝播しない）。`functions/` を変更したら **`docker restart registrar-firebase-emulators`**（起動コマンドが自動再ビルドする）。再起動直後は関数ディスカバリに数分かかることがある（その間 "Function does not exist"）。Authエミュレータのユーザーも再起動で消える（開発ユーザーは起動時にシムが自動再作成）。
- **`npm --prefix <dir> install` は使用禁止**。CWD の package.json を依存として注入する挙動を実機で確認済み。必ず対象ディレクトリに `cd` してから実行する。
- 実レジストリ系 callable（`searchDomains` / `listTlds` / `createOrder` / `renewOrder` / `getOrder` / `getDomainInfo` / `updateDomain` / `deleteDomain` / `restoreDomain` / `rotateAuthInfo` / 移管系）は **`functions/.secret.local` が前提**。未設定だと検索・注文・詳細取得は失敗する（設定値はバックエンドチームと共有。`listDomains` / `updateAutoRenew` / DNS 3種（`listDnsRecords` / `saveDnsRecords` / `resolveDns`）は Firestore のみ参照で secret 不要）。

UI上のログインは従来どおりMSWのモックユーザー: `demo@example.com` / `password123`。
Signup wizard (/signup) のメール認証コードは **Firestore の `verificationCodes/{メールアドレス}` に発行される 6 桁のランダム値**（有効10分・試行5回・再送60秒間隔）。固定値 `123456` は廃止。メール送信は未実装なので `firestore.rules` がこのドキュメントの `get` だけを未認証で許可しているが、**メール認証画面はコードを表示しない** — コードの取得は別手段で行う。
（callable用の認証は `src/dev/devCallableAuth.ts` が `dev@example.com` をAuthエミュレータに自動作成してサインインする — 認証統合までの暫定シム）

### 環境変数（`.env.example` 参照。すべて既定値あり）

| 変数 | 意味 |
|---|---|
| `VITE_FIREBASE_PROJECT_ID` | エミュレータのプロジェクトID（既定 `demo-teamc-2026`。`demo-` = オフライン保証） |
| `VITE_FIREBASE_EMULATOR` | SDKをエミュレータへ接続（dev既定 true） |
| `VITE_FIREBASE_EMULATOR_HOST` | エミュレータのホスト（既定 `127.0.0.1`） |
| `VITE_AUTH_EMULATOR_PORT` / `VITE_FUNCTIONS_EMULATOR_PORT` | Auth 9099 / Functions 5001（firebase.json と一致させる） |
| `VITE_ENABLE_MOCKS` | 認証・サインアップ用MSWモック（dev既定 true） |
| `VITE_ORDER_POLL_INTERVAL_MS` | 注文結果ポーリング間隔ms（既定 1500） |

### 通信層のアーキテクチャ

```
components / features（変更なし）
  → src/api/*.ts（エクスポート関数のシグネチャ不変。内部で型アダプタ）
    → invoke() (src/api/callable.ts)  … httpsCallable をメモ化、
      FunctionsError → 既存 ApiError へ正規化（unauthenticated→401 / invalid-argument等→400 /
      not-found→404 / already-exists→409 / unavailable→network …）
      → Functions エミュレータ (asia-northeast2)
```

- **全 callable が `functions/` の実実装に接続済み**: `searchDomains` / `listTlds` / `createOrder` / `renewOrder` / `getOrder` / `listDomains` / `getDomainInfo` / `updateDomain` / `updateAutoRenew` / `deleteDomain` / `restoreDomain` / `rotateAuthInfo` / DNS 3種（`listDnsRecords` / `saveDnsRecords` / `resolveDns`）/ 移管系（`requestTransfer` / `cancelTransfer` / `respondTransfer` / `listTransfers` / `getTransferStatus`）（+認証系）
- 旧スタブ codebase `functions-stubs/` は全スタブの実移行完了に伴い**削除済み**。旧スタブのマジック値方式の失敗注入（`fail-server` / `order-fail` 等）も廃止 — 失敗分岐は実バックエンドの実挙動か、vitest では `fakeBackend` の outcome 切替で再現する
- **テスト**: vitest はネットワークに出ない。`src/test/fakeBackend.ts` が `invoke()` を `vi.mock` で差し替える（ドメイン/注文/マイページのフローテスト）。`authFlows` / `signupFlow` のみ従来どおりMSW

### 認証チームへの引き継ぎ（auth-migration）

認証まわり（ログイン/サインアップUI・セッション管理）は本移行のスコープ外で、**MSW+独自JWTのまま**残してある。Firebase Auth統合の際は以下を参照:

- **シーム**: `src/firebase.ts` の `firebaseAuth`（`getAuth` 済み・Authエミュレータ接続済み）。この上に `signInWithEmailAndPassword` / `onAuthStateChanged` / `signOut` を組む
- **置き換え対象**: `src/auth/AuthProvider.tsx`（`onAuthStateChanged` ベースへ。3状態モデル `checking|authenticated|unauthenticated` は維持）、`src/auth/tokenStorage.ts` / `src/api/unauthorizedBus.ts` / `src/api/authApi.ts` / `src/api/httpClient.ts`（移行完了後に削除可）、`src/mocks/` の認証系残部と `MockControlPanel`、`src/pages/DashboardPage.tsx`（FIG.8のREST 401デモ。SDKベースに置換 or 削除）
- ⚠️ **`src/dev/devCallableAuth.ts` は統合完了時に必ず削除**（`TODO(auth-migration)` マーカー付き。残すとMSWセッションとFirebaseセッションの二重認証状態になる）
- **契約**: `docs/仕様/auth.md` — 会員登録は callable `registerWithEmailPassword`（クライアントで `createUserWithEmailAndPassword` は呼ばない）→ 別途 `signInWithEmailAndPassword`。メールドメインの `@example.com` 制限は Auth ユーザー作成前に `functions/src/auth/registration.ts`（`isAllowedEmailDomain`）と `functions/src/auth/verification.ts` が強制する（Auth Blocking Functions は本プロジェクトが Identity Platform 未アップグレードのため不採用・撤去済み）。`sessionLogin`（セッションCookie）は `cors:false` のため Vite dev の別オリジンから呼べず、今回スコープ外にした（採用時は Vite の `server.proxy` で同一オリジン化が必要）
- **テスト**: `src/app/authFlows.test.tsx` / `signupFlow.test.tsx` は認証移行時に書き換えが必要（現在はMSW+トークンシード前提）

## Design rules that must not be "simplified" away

1. **The auth state has three values, never two.**
   `checking | authenticated | unauthenticated` (`src/auth/authTypes.ts`).
   Collapsing it into a boolean reintroduces the login-screen flicker that FIG.7
   exists to prevent: during token verification the app is neither logged in nor
   logged out.
2. **The route guard holds its decision while `checking`.**
   `RequireAuth` renders a loader and redirects only once the state is settled.
3. **One place detects 401.** `src/api/httpClient.ts` publishes to
   `unauthorizedBus`; `AuthProvider` subscribes and resets the state; the guard
   then redirects with `returnTo`. No call site writes its own 401 handling.
   Two endpoints opt out (`skipUnauthorizedHandler`) because for them a 401 is a
   normal answer, not a dead session: `POST /api/auth/login` (wrong credentials)
   and `GET /api/auth/me` (the restore sequence handles it).
4. **The login failure message never says which field was wrong.**
   `LOGIN_FAILED_MESSAGE` in `src/features/auth/authMessages.ts` - this blocks
   account probing and is a spec requirement, not wording preference.
5. **Registration succeeds even if only one registry contact was created.**
   The UI ignores `contactStatus` (FIG.5 / spec §6.8).
6. **Name and e-mail domain are closed lists** (spec §3.4). Free text there means
   a guaranteed HTTP 400 from the registry later in the flow.
7. **Domain availability has three states, never two.**
   `available | taken | unknown` (`src/api/domainsSearchApi.ts`). A registry
   that failed to answer must render as `unknown` ("確認できませんでした"),
   never as `taken` ("使用中") - spec §6.7 is explicit that showing an
   available domain as taken is the worse failure mode. See
   `mocks/handlers.ts`'s `partial-registry-timeout` scenario and its test in
   `src/app/domainSearchFlow.test.tsx`.
8. **Similar-domain suggestions are only ever shown after re-verification.**
   `suggestionEngine.ts`'s `RuleBasedCandidateSuggester` proposes candidates
   offline (rule-based, no AI - spec §6.2.4); `getVerifiedSuggestions` then
   re-checks every one against the real search API and drops anything it
   could not confirm as available. A candidate is never shown on the strength
   of the generator alone.
9. **Pricing shows the first-year and renewal figures at the same font
   size** (spec §6.2.5 - `PriceDisplay.tsx`'s `.price-display__value` class is
   the single place that invariant is enforced), plus a 3-year total.
10. **The TLD list is fetched, never hardcoded** (spec §4.3). `useSupportedTlds`
    only falls back to the static `FALLBACK_TLDS` list when the fetch itself
    fails, and surfaces a non-blocking notice when it does.
11. **`Order.state` has at least four user-visible values, never two**
    (spec §5 / TBD #17): 処理中 (`paid`/`provisioning`) / 再試行中
    (`retrying`) / 完了 (`done`) / 失敗 (`failed`), each with its own screen in
    `src/features/orders/OrderStatusPage.tsx`. Retrying carries the §6.7-fixed
    wording 「処理中です。自動で再試行しています」 **plus** the explicit
    no-double-charge line; failed says only 「処理できませんでした」 — the
    internal refund treatment (返金扱い) is never surfaced (§5).
12. **The 2302 recovery is backend-only.** "409 + 2302, but `domain:info`
    resolves for our registrar = the previous attempt already succeeded"
    (FIG.2 / §6.7) reaches the frontend as a plain `state=done`; the UI renders
    it identically to any other success and never re-implements the judgement
    or says "this was actually a retry" (tested in `src/app/orderFlow.test.tsx`).
13. **The form payload is always complete** (spec §1.2). Normal mode folds the
    advanced fields behind 「くわしい設定」 (never hides them); the future easy
    mode masks a field by *not rendering* its section component
    (`src/features/orders/OrderFormSections.tsx` is split per §6.2.6 row for
    exactly this) while the §6.2.6 default stays in the state and the payload.
    No `display:none`, and a validation error inside the fold force-opens it.
14. **authInfo is masked with a copy button only** (spec §7.3) —
    `src/features/orders/AuthInfoMasked.tsx` has no reveal toggle and a
    fixed-length mask. The auto-generated value satisfies §3.4 (1-64 chars)
    and §6.2.6 (20+ alnum/symbol chars).
15. **One order per payment.** The pay button is guarded by a synchronous ref
    (double-click safe), and paying replaces the history entry with
    `/orders/{id}`, so reload/back lands on the poll-only result screen — a
    reload can never re-submit the order.
16. **The EPP code → wording table lives in one module**
    (`src/api/eppResultMessages.ts`, spec §6.7: 1000/2302/2303/2202/2306);
    `domainMessages.ts` and the order screens import from it instead of
    holding copies.
17. **The top page (`/`) is the search screen and is PUBLIC.** Searching,
    availability, pricing and suggestions never ask for a login; the guard
    kicks in only at the 次へ進む CTA (`/domains/new`), and returnTo — query
    string included — brings the user straight back after login. Do not wrap
    the search route in `RequireAuth` again.
18. **The executed search lives in the URL** (`/?q=<label>`). A search always
    covers every supported TLD — there is no TLD picker, so the label is the
    whole contract (a legacy `tlds` parameter is ignored).
    Submitting only writes the query parameters; an effect keyed on them runs
    the search. That one decision is what makes reload, link sharing, and the
    login round-trip all restore the same results for free.
19. **Deliberate login lands on `/`; a bounce returns via returnTo.**
    `DEFAULT_AUTHENTICATED_PATH` is `'/'` (FIG.6 updated 2026-08-25); the
    returnTo priority ("弾かれて来た＝元の場所へ") is untouched.

## shadcn/ui

The whole app is on **shadcn/ui + Tailwind CSS v4** — see `DESIGN_SYSTEM.md`
for the binding rules (semantic tokens only, no `dark:` utilities, no hex in
JSX, StatusBanner over inline Alerts). Both frontend workstreams converged on
the same setup independently; the my-page merge kept the design-system side
and added on top of it:

- `Alert` gained `info` / `warning` variants (my-page notices), token-based.
- `switch.tsx` / `progress.tsx` were added to `src/components/ui/` (the
  my-page toggles and remaining-days bars), on the unified `radix-ui` package.
- `src/styles/app.css` exposes the brand accents as Tailwind colours
  (`bg-grass-1`, `text-green-brand`, `text-ink-faint`, …) and defines the §3.5
  status-chip tokens (`--status-info-*` / `--status-hold-*` /
  `--status-locked-*`), flipping with the same prefers-color-scheme override as
  the brand palette.
- **2026-08-26**: the palette moved from teal to **やわらか若草**
  (`design_theme/theme-04-3-wakakusa.html`) — deep green (`--green`) on type,
  buttons and small marks only, pale grass tints (`--grass-1` / `--grass-2`)
  for every filled surface, 生成りの紙 (`--paper`) as the ground, one diffuse
  shadow (`--shadow-soft`) as the only elevation, and no outlines. Headings are
  Zen Maru Gothic (`font-heading`), figures/TLDs Poppins (`.font-en`). The top
  page (`DomainSearchPage`) reproduces that theme's landing section by section;
  every other screen inherits it through the tokens.

## Provisional decisions (revisit when TBD #10 lands)

> **2026-08-25 移行注記**: 下表のうち **RESTパス（`/api/...`）を根拠にした行は callable 移行で置き換え済み**（検索・TLD一覧・注文・マイページ系。callable名の対応は上の「通信層のアーキテクチャ」と `docs/api-flow-diagrams.html` を参照）。各行の**意味的な決定**（3状態表示・ポーリング方式・`Order.state` の状態機械・§6.2.6デフォルト等）はそのまま有効。**認証・サインアップの行（JWT/`/api/auth/*`/`/api/signup/*`）は現状維持**（認証チームの移行待ち）。「検索系APIの認証要否」の未合意事項は callable でも生きている — 現状の実装済み `searchDomains` は**認証必須**のため、公開トップページの未認証検索とは矛盾しており、要バックエンド協議（現在は devCallableAuth シムが裏でサインインするため画面上は動く）。
>
> ✅ **解消（2026-08-27）**: 上記の矛盾はバックエンド側の修正で解消済み。`searchDomains`（`functions/src/api/searchDomains.ts`）から `requireActiveUser` 呼び出しと `if (!request.auth) throw ...` の両方を撤去し、`listTlds` / `devForceRegistry503` と並ぶ**認証不要の公開 Callable**にした（ユーザーの明示的な判断: 「searchDomains は認証不要。購入する際に必要になる。」検索は公開、ログインが必要なのは購入からのみ）。これにより公開トップページの未認証検索は仕様どおり動作するようになり、上記の devCallableAuth シムへの依存も不要になった。⚠️ **公開に伴う留意点**: `listTlds` と異なり `searchDomains` の応答はキャッシュされないため、匿名トラフィックがそのままレジストリの `domain:check` に到達する。`MAX_NAMES = 25` は1回の呼び出しの件数上限にすぎず呼び出し頻度は制限しないため、App Check 等によるレート制限は公開運用の前提条件として別途必要（`docs/仕様/api-auth.md` §3 参照）。

| Decision | Why | What changes if the backend differs |
|---|---|---|
| Client-held JWT in `localStorage` (mirrored in memory) | FIG.6/FIG.7 are drawn with JWT | Only `src/auth/tokenStorage.ts` and the `Authorization` header in `src/api/httpClient.ts` |
| Logout = discard the token, no API call | Nothing to invalidate server-side with a stateless JWT | Add `POST /api/auth/logout` in `AuthProvider.logout` |
| Password minimum length 8 | The spec fixes no policy (§6.8) | `PASSWORD_MIN_LENGTH` in `src/features/auth/constants.ts` |
| `returnTo` kept in router state *and* `sessionStorage` | Router state alone is lost when the login screen itself is reloaded | `src/auth/returnTo.ts` |
| `GET /api/domains/tlds` (new endpoint, not in the original FIG.1 draw) | Spec §4.3 requires the TLD list to be fetched, never hardcoded, with a static fallback on failure; the frontend needs the same shape for the columns of its result table | Only the fetch call in `src/api/domainsSearchApi.ts` and its mock handler |
| Search screen moved to the public top page `/`; the old `/domains` route redirects there (query included) | The entry funnel must not demand a login before showing value; the owned-list feature (§6.1 情報参照) still needs its own route when it is built | `src/app/AppRouter.tsx` (`DomainsLegacyRedirect`) |
| `DEFAULT_AUTHENTICATED_PATH` = `/` (was `/dashboard`) | Deliberate login/register should land back on the search top page; FIG.6 updated accordingly. returnTo still wins for bounced users | `src/config.ts` only |
| Search-URL contract: `?q=<normalized label>` (a search always spans every supported TLD; the former `tlds` parameter is ignored) | The URL is the single source of truth for an executed search (reload / share / login round-trip), and the TLD choice moved from the form to the result table | `LABEL_PARAM` in `src/features/domains/DomainSearchPage.tsx` |
| Results = per-TLD selection table + cart（選択した商品）; 次へ進む carries every selected domain as repeated `?domain=` params, but the application form processes the FIRST one per order (the cart says so when 2+ are selected) | Mirrors the お名前.com-style selection UX the team asked for while the order flow stays single-domain; the URL keeps the full selection honest for a future multi-order form | `src/features/domains/DomainSelectTable.tsx`, `SelectionCart.tsx`; multi-order support would extend `src/features/orders/OrderApplicationPage.tsx` |
| Similar-domain suggestions render as an in-page section, not a separate screen | FIG.1 draws a distinct 類似候補提案画面 node; keeping it on the same page avoided an extra route this round | `src/features/domains/DomainSearchPage.tsx` |
| TLD metadata (recommend reasons, caveats) and pricing are placeholder data | Kitaqnic's real 18 TLDs (TBD #1) and the real 22-TLD price table (TBD #7) do not exist yet | `src/features/domains/tldData.ts` only - every other module reads TLD/price data through its exported functions |
| `CandidateSuggester` is an interface with one rule-based implementation | Spec §6.2.4 requires the suggestion algorithm to be abstracted/swappable, mirroring the BRIDGE-layer pattern (§4.2) | `src/features/domains/suggestionEngine.ts` |
| **Order contract**: `POST /api/orders` (kind=create, pseudo payment server-side, returns the order in `state=paid`), then the result screen **polls** `GET /api/orders/{id}` until `done`/`failed` | The backend does not exist; FIG.1 draws the payment as part of the create call, and polling is the simplest contract that survives a reload mid-provisioning | `src/api/ordersApi.ts`, `src/features/orders/useOrderPolling.ts`, and the two handlers in `src/mocks/handlers.ts` |
| Order poll interval 1.5s (`orderPollIntervalMs()` in `src/config.ts`) | Demo-friendly pace; read lazily so tests can shrink it via `VITE_ORDER_POLL_INTERVAL_MS` | `src/config.ts` only |
| §6.2.6 default values (period 1y / auto-renew ON / in-house DNS hostnames / authInfo 24 chars / member contact for all roles) | All six are spec TBD #5; values follow the spec's own proposal column | `src/features/orders/orderDefaults.ts` only — a data swap, no component changes |
| Registration period choices: 1 / 2 / 3 / 5 years | Period unit is TBD #3; year-granularity is the only confirmed unit | `REGISTRATION_YEAR_OPTIONS` in `src/features/orders/orderDefaults.ts` |
| Failed orders may carry a raw EPP `resultCode` which the frontend maps via `eppResultMessages.ts` | **未合意**: whether the backend passes raw `result.code` through or translates it into its own error kinds must be agreed before the real backend lands (§6.7) | `src/api/eppResultMessages.ts` (the mapping stays here either way) |
| **Signup wizard contract** (`/signup`): `startEmailVerification` / `verifyEmailCode` / `resendEmailVerificationCode` / `registerWithEmailPassword` callables | Splitting start/complete means the password never has to be persisted client-side across steps (it stays in memory only - a reload keeps every other field via the sessionStorage draft). ⚠ **記録済みトレードオフ**: メール送信基盤がないため `verificationCodes/{email}` を未認証 `get` 可にしている（`list`/`write` は不可、検証・登録可否のゲートはサーバ側）。画面にはコードを出さない | `src/api/signupApi.ts`, `firestore.rules`, `functions/src/auth/verification.ts` |
| The signup wizard (`/signup`, header 会員登録) coexists with the FIG.5 one-screen `/register` | The wizard implements the UI task (free-text 名前/住所, e-mail OTP, 契約者情報); `/register` remains the spec-§3.4-constrained implementation (8 fixture names, `@example.*` mails) that FIG.5 and its tests encode. ⚠ **要整理**: the two must be reconciled once the backend decides how 会員登録 and registry-contact creation (§5.1/§6.8) really relate - free-text names cannot become registry contacts (§3.4 guarantees a 400) | `src/app/AppRouter.tsx` (both route sets), `src/features/signup/` vs `src/features/auth/RegisterPage.tsx` |
| Forms in `features/signup/` use react-hook-form + zod + the shadcn `Form`/`InputOTP` recipes (`src/components/ui/form.tsx` was hand-added - the radix-nova registry ships no form recipe) | The signup task asked for per-screen validation schemas; existing screens keep their manual-useState idiom untouched | Schemas live one-per-screen in `src/features/signup/*Schema.ts` |
| DNS設定 is a placeholder route (`/domains/:domainName/dns`) | FIG.1 ends with the DNS hand-off but §6.3 is out of scope this round | `src/pages/DnsSetupPlaceholderPage.tsx` |
| **My-page contract** (FIG.9-10): `GET/PUT/DELETE /api/domains/{name}`, `POST …/restore`, `POST …/rotate-auth-info`, `GET /api/notifications`, `POST /api/notifications/{id}/approve\|reject` | The backend does not exist; paths follow the FIG.9-10 draw | `src/api/myDomainsApi.ts`, `src/config.ts`, mock handlers |
| 更新 (renew) rides the existing order contract as `POST /api/orders` (kind=`renew`) → poll | FIG.10: payment/retry/no-double-charge stay in ONE place (FIG.1 machinery) | `src/api/ordersApi.ts`, `src/features/mypage/RenewDialog.tsx` |
| Owned-domain list lives at `/mypage` (+ `/mypage/domains/:name`) | `/domains` was repurposed as the search screen (row above) | `src/app/AppRouter.tsx` |
| Mock grace period = 30 days, single stage (戻せる/戻せない) | 🔬 spec テスト3 unmeasured; §6.5 says decide from the measurement | `src/mocks/db.ts` seeds, `src/mocks/handlers.ts` |
| pendingDelete / pendingTransfer block registry-side operations (409 ≒ 2306) | 🔬 spec テスト6 unmeasured; conservative until measured | mock handlers + disabled controls in `DomainDetailPage.tsx` |
| Remaining-days use the real clock | The §7.1 mock clock does not exist yet; `src/features/mypage/domainDisplay.ts` is the single seam to inject it | `domainDisplay.ts` only |

**未合意事項（バックエンド着手前に要合意）**

1. 注文状態の取得方式 — 本実装は `GET /api/orders/{id}` のポーリング前提
   （上表）。レスポンス完結型や push 型に変わる場合は
   `useOrderPolling.ts` と `ordersApi.ts` のみ差し替え。
2. 失敗時のエラー表現 — バックエンドが raw `result.code` を返すか、変換済みの
   エラー種別を返すか（上表）。
3. `Order.state` の状態機械（TBD #17） — §5 の叩き台
   `draft → paid → provisioning → done / retrying / failed` をそのまま採用中。
4. 検索系APIの認証要否 — `POST /api/domains/search` と `GET /api/domains/tlds`
   は**未認証で叩ける**前提（トップページが公開の検索画面のため）。バックエンド
   がこの2本を保護すると未認証検索が全滅するので、公開APIとして実装すること。

## Manual verification (mock panel)

> **2026-08-25 移行注記（2026-08-27 更新）**: **モックAPI設定パネルが効くのは認証・サインアップ系（FIG.5-8）のみ**。ドメイン検索・注文・マイページ系（FIG.1/9/10）は実バックエンド（`functions/` + 実レジストリ）に接続済みで、旧スタブのマジック値注入（`fail-server` / `order-fail` 等）は廃止 — 失敗分岐の網羅は vitest（`fakeBackend` の outcome 切替）で担保する。以下の FIG.1/9-10 の手順のうち「スイッチを切り替える」記述は移行前のもので、分岐の**期待表示**（3状態・文言・二重課金防止など）は引き続き正。

`npm run dev`, then open the **モックAPI設定** panel at the bottom right. Each
switch reproduces one branch of the diagrams.

- **FIG.5** — register with `201 成功`; repeat with `片方の contact 作成に失敗`
  and confirm the screen looks *identical* (that is the correct behaviour);
  then `409` / `400` / `500` for the error paths.
- **FIG.6** — log in with the seeded account; switch to `401 認証失敗` for the
  "メールアドレスまたはパスワードが違います。" message; `500 サーバエラー` for
  "時間をおいて再度お試しください。".
- **FIG.7** — log in, set 応答遅延 to `2000 ms`, reload: the header badge shows
  `AuthContext: 確認中` and the loader, then `認証済み` - the login form never
  appears. Set セッション確認 to `401 トークン失効` and reload: the token is
  discarded and the login screen appears.
- **FIG.8** — while logged out, open `/easy/goal`: you land on `/login` with the
  returnTo notice, and logging in returns you to `/easy/goal`. While logged in,
  use ダッシュボード → 「トークンを失効させる」 then 「保護APIを呼ぶ」: the
  common HTTP client catches the 401 and you are back on `/login` with
  `returnTo=/dashboard`.
- **FIG.1 右半分（注文）** — search, select an available TLD (◯), hit 「次へ進む」:
  the form arrives pre-filled with the §6.2.6 defaults and the advanced
  fields folded under 「くわしい設定」. Confirm and pay (疑似決済) with the
  `FIG.1 注文` switch on each value:
  - `成功` — 処理中 → 完了画面（ステータス「使えています」、authInfo は
    マスク＋コピーのみ、DNS設定への誘導）。
  - `2302リカバリ経由の成功` — **画面が「成功」と完全に同一なのが正しい**
    （リカバリはバックエンド責務、§6.7 / FIG.2）。
  - `タイムアウト → 自動再試行 → 成功` — 「処理中です。自動で再試行して
    います」＋二重課金しない旨が出たあと完了画面へ。
  - `取得成功・NS設定失敗` — 完了画面だがステータスが
    「まだインターネットに公開されていません」(inactive, §3.5)。
  - `リトライ上限で失敗` — 「処理できませんでした」のみ（「返金」の語は
    出ない、§5）。
  - `500 注文作成に失敗` — 確認画面に留まり再試行できる。
  While 処理中, reload the tab: you come back to `/orders/{id}` and the same
  order resumes — no second order is created (`registrar.mock.orders` in
  localStorage keeps the mock's order identity). Double-clicking 支払う also
  creates only one order.
- **FIG.1 トップページ（公開検索）** — while logged out, open `/`: the search
  screen renders (no login redirect) and the header offers ログイン / 会員登録.
  Search something: the URL becomes `/?q=…` — reload it and the results
  come back; share it and they reproduce. Select a ◯ and click 次へ進む while
  logged out: you are bounced to /login and, after logging in, land on the
  application form for that exact domain. Log in normally (no bounce) and you land back on `/`, now
  with the 管理画面へ button in the page header.
- **FIG.1** — on `/` (ドメイン検索). Try a label with an underscore
  or a leading hyphen: the field error appears and nothing is sent. Search
  with `全て空きあり`: every supported TLD appears as a column (初年度/更新 at
  the same font size; 22 TLDs paginate with 前へ/次へ) and clicking a ◯ adds
  the domain to 選択した商品 — its 3年間の合計 shows per item, and 次へ進む
  hands the selection to `/domains/new`. Switch to `全て使用中（2302）` and
  re-search: every column shows ✕ and the suggestion section reports its
  honest empty state (every generated candidate is itself re-checked and also
  comes back taken). Switch to `片方のレジストリがタイムアウト` and re-search:
  only Kitaqnic-routed columns (e.g. `.dev`) show 「？ 確認できませんでした」 -
  never 「✕ 使用中」. Switch `FIG.1 TLD一覧取得` to `500` and reload: the
  table still renders from the static 4-TLD fallback, with a non-blocking
  notice.
- **FIG.9-10（マイページ）** — log in and open マイページ (header). The list
  shows アクティブ / ライフサイクル終盤 in two sections with coloured, labelled
  status chips, remaining-days bars and the auto-renew state; the seeded
  transfer-out request renders as a warning with 承認/拒否 (承認 asks for
  confirmation and removes the domain; 拒否 clears pendingTransfer). On
  `teamc-old.icu` press 復旧する → confirm → it returns to アクティブ. Open a
  domain: toggle 自動更新 (the OFF wording explains the TBD #15 batch), change
  nameservers (the §6.3.3 warning about records AND mail is always shown),
  flip the four ロック switches, regenerate authInfo (masked, copy-only), and
  run もう使わない → the recommended branch only turns auto-renew off, 今すぐ削除
  shows the impact + grace-period text before the destructive confirm. 今すぐ更新する
  runs a `kind=renew` order through the FIG.1 order screen and comes back with
  the new expiry. Mock data survives reloads (`registrar.mock.domains` in
  localStorage) — clear it to reseed.

## Notes

- SPA deep links (`/easy/goal`, …) need a history fallback on any static host;
  the Vite dev server and `vite preview` already do this.
- The browser never talks to a registry (spec §3.2.1): registry credentials and
  the two-stage `result.code` judgement (§3.3) stay in the backend BRIDGE layer.
- Out of scope here: the backend itself (API layer, BRIDGE, `domain:create` /
  `domain:update`, the 2302-recovery judgement — FIG.2's inner columns), the
  DNS settings screen (§6.3 — `/domains/:domainName/dns` is a placeholder the
  completion screen hands off to), the easy-mode wizard shell (§6.2 — the form
  sections in `src/features/orders/OrderFormSections.tsx` are already split so
  the wizard can mask them by not rendering), domain list/detail, transfer,
  delete/restore, and real billing (§2.2 — the payment step collects no
  payment details at all). `/easy/goal` remains a placeholder protected route;
  `/domains` and `/domains/new` are real screens (see the table above).
