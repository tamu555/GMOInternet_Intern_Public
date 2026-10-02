# Firebase 開発環境セットアップ手順書

**対象プロジェクト**: 疑似レジストラサービス（GMOインターネット ハッカソン / Webアプリケーションコース）
**対象読者**: これから Firebase を触るチームメンバー全員

このドキュメントだけを読めば、グローバルツールのインストールからローカルエミュレータでの開発着手までを迷わず再現できることを目標にしている。

> ⚠️ 本ドキュメントの作成にあたり、実際に `firebase init` 等の状態変更コマンドはこのリポジトリに対して**実行していない**。ログイン・プロジェクト作成は各自の Google アカウントで手動運用する（§2 参照）。

---

## 目次

0. [前提条件](#0-前提条件)
1. [Firebase CLI のインストール](#1-firebase-cli-のインストール)
2. [ログインとアカウント切り替え（手動運用）](#2-ログインとアカウント切り替え手動運用)
3. [プロジェクトの初期化](#3-プロジェクトの初期化)
4. [サービスごとのセットアップ](#4-サービスごとのセットアップ)
5. [Firebase Local Emulator Suite](#5-firebase-local-emulator-suite)
6. [Docker でのエミュレータ運用](#6-docker-でのエミュレータ運用)
7. [デプロイコマンド一覧](#7-デプロイコマンド一覧)
8. [トラブルシューティング](#8-トラブルシューティング)
9. [参考文献](#9-参考文献)

---

## 0. 前提条件

| 項目 | 要件 |
|---|---|
| Node.js | **20 以上**（`node --version` で確認。Cloud Functions は Node 20 / 22 / 24 をサポート。本リポジトリの `functions/package.json` は `engines.node: 24` を指定） |
| npm | Node.js に同梱のもので可 |
| OS | macOS / Linux / Windows（本書のコマンドは macOS/Linux 前提。Windows は WSL 推奨） |
| Google アカウント | Firebase プロジェクトへアクセスできるチーム共有アカウント（§2） |
| Docker（任意） | エミュレータをコンテナで動かす場合のみ（§6） |

**本プロジェクトで使う想定の Firebase サービス**

- Cloud Firestore（メイン DB 候補）
- Firebase Authentication（会員登録・ログイン。§6.8 のメールドメイン制限と連動）
- Cloud Functions for Firebase（TypeScript, 第2世代）
- Google Analytics 4（GA4。利用状況計測。任意）
- Realtime Database（将来利用の可能性。参考として記載）
- キュー的な仕組み（Pub/Sub トリガー Functions or Cloud Tasks。将来利用の可能性）

Firebase CLI の実コマンド・フラグは、本書作成時に `npx -y firebase-tools@latest <command> --help`（バージョン `15.28.1`）で実行結果を確認した上で記載している。

---

## 1. Firebase CLI のインストール

CLI の実行方法は2通りある。**チームとしてどちらを使うか、Day0 のうちに決めて統一する**（`.firebaserc` や CI 設定に影響するため）。

### 方式A（推奨）: `npx` で都度実行する

インストール作業が不要で、常に最新版が使われる。公式 Skill 推奨方式。

```bash
npx -y firebase-tools@latest --version
npx -y firebase-tools@latest login
npx -y firebase-tools@latest init
```

- 毎回 `npx -y firebase-tools@latest` と打つのが長い場合は、シェルエイリアスを各自の `.zshrc` 等に設定してよい（リポジトリにはコミットしない）:
  ```bash
  alias firebase="npx -y firebase-tools@latest"
  ```

### 方式B: グローバルインストール

```bash
npm install -g firebase-tools

# 確認
firebase --version
```

- バージョンが古くなるため、定期的に更新する:
  ```bash
  npm install -g firebase-tools@latest
  ```
- チームで使う Firebase CLI のバージョンを揃えたい場合（CI と手元の挙動を一致させたい等）はこちらが適している。

以降、本書では方式A（`npx -y firebase-tools@latest`）を前提にコマンド例を書くが、グローバルインストール済みの場合は `firebase` に読み替えればそのまま使える。

---

## 2. ログインとアカウント切り替え（手動運用）

⚠️ **本プロジェクトでは Firebase CLI の認証状態を変更する操作（`login` / `logout` / `use`）は各自のローカル環境で手動運用する方針。** リポジトリの自動化スクリプトや CI からこれらを実行しない。

### 2.1 チーム共有アカウントでログイン

```bash
# ブラウザが開ける環境（通常はこちら）
npx -y firebase-tools@latest login

# ブラウザが使えない環境（サーバー上での作業等）
npx -y firebase-tools@latest login --no-localhost
```

### 2.2 複数アカウントの使い分け

個人アカウントとチーム共有アカウントなど、複数の Google アカウントを切り替えて使う場合:

```bash
# 現在ログイン済みのアカウント一覧を表示
npx -y firebase-tools@latest login:list

# 追加のアカウントを CLI に認可させる（既存のログインは維持される）
npx -y firebase-tools@latest login:add

# ディレクトリ（プロジェクト）ごと、または全体のデフォルトアカウントを切り替える
npx -y firebase-tools@latest login:use <email>

# 特定アカウントをログアウトする
npx -y firebase-tools@latest logout <email>
```

### 2.3 `--account` フラグでコマンド単位にアカウントを指定する

**確認済み**（`firebase --help` のグローバルオプション一覧より）:

```
--account <email>   the Google account to use for authorization
```

`--account` はすべてのサブコマンドで使える**グローバルオプション**であり、CLI 全体のデフォルトアカウント（`login:use` で設定したもの）を変更せずに、そのコマンド1回だけ別アカウントで実行できる。

```bash
npx -y firebase-tools@latest --account teamB@example.com projects:list
npx -y firebase-tools@latest --account teamB@example.com deploy --only firestore --project <PROJECT_ID>
```

- 対象アカウントは事前に `login` または `login:add` で CLI に認可されている必要がある（未認可のメールを指定するとエラーになる）。
- レジストラ検証で「レジストラB用の Firebase プロジェクトを別アカウントで操作する」ような場面（レジストラA/B構成に類する運用をする場合）に有効。

### 2.4 プロジェクトの選択（エイリアス）

```bash
# 既存プロジェクトをこのディレクトリのデフォルトとして紐付け（.firebaserc に保存される）
npx -y firebase-tools@latest use --add <PROJECT_ID>

# 現在の紐付け状況を確認
npx -y firebase-tools@latest use
```

- `-P, --project <alias_or_project_id>` はコマンド単位でプロジェクトを一時的に切り替えるグローバルオプション（`.firebaserc` のエイリアスや、プロジェクトIDを直接指定できる）。
  ```bash
  npx -y firebase-tools@latest deploy --only firestore -P staging
  ```

---

## 3. プロジェクトの初期化

### 3.1 新規プロジェクトの作成（初回のみ・1人が代表して行う）

```bash
npx -y firebase-tools@latest projects:create
```

- プロジェクトID: 6〜30文字、小文字英数字とハイフン、**グローバルに一意**
- 作成後、他のメンバーは Firebase Console の「プロジェクトの設定 > ユーザーと権限」から追加してもらう

### 3.2 既存プロジェクトに接続する（2人目以降）

```bash
npx -y firebase-tools@latest use --add <PROJECT_ID>
```

対話で選んだエイリアス名（例 `default`）が `.firebaserc` に保存される。

### 3.3 `firebase init`（対話式初期化）

リポジトリのルート（このドキュメントを書いている時点ではまだ未作成）で実行する。

```bash
npx -y firebase-tools@latest init
```

`firebase init --help` で確認できる有効な feature 一覧（実在するもののみ抜粋。本プロジェクトで使う想定のもの）:

- `firestore` — Cloud Firestore のルール・インデックス管理
- `auth` — Authentication のプロバイダ設定（CLI 管理対象のもの）
- `functions` — Cloud Functions
- `emulators` — Local Emulator Suite
- `database` — Realtime Database（将来利用時）
- `hosting` — Firebase Hosting（フロントを Firebase Hosting でホストする場合）

対話フローの流れ（例: Firestore + Functions + Auth + Emulators を選んだ場合）:

1. 「どの機能を使うか」を複数選択（スペースキーでトグル）
2. 各機能ごとに設定を質問される（例: Firestore はルール/インデックスのファイル名、Functions は言語（TypeScript を選択）と Lint の有無）
3. 完了すると以下が生成・更新される

| ファイル | 役割 |
|---|---|
| `firebase.json` | 有効化した機能ごとの設定（ルールファイルパス、エミュレータポート等）を一元管理 |
| `.firebaserc` | プロジェクトエイリアスの対応表（`{"projects": {"default": "<PROJECT_ID>"}}`） |
| `firestore.rules` | Firestore セキュリティルール |
| `firestore.indexes.json` | Firestore 複合インデックス定義 |
| `functions/` | Cloud Functions のソース一式（§4c） |
| `database.rules.json` | Realtime Database セキュリティルール（database を選んだ場合） |

`init` は既存の `firebase.json` に追記する形で動くため、機能を後から追加したい場合は `firebase init <feature>` を個別に再実行すればよい（例: `firebase init functions` を後から追加）。

---

## 4. サービスごとのセットアップ

### 4a. Cloud Firestore

`firebase.json` に以下のブロックが生成される:

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

まずは全拒否ルールから始め、必要な範囲だけ段階的に許可していく。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

デプロイ:

```bash
# ルール・インデックスの両方
npx -y firebase-tools@latest deploy --only firestore

# ルールのみ
npx -y firebase-tools@latest deploy --only firestore:rules

# インデックスのみ
npx -y firebase-tools@latest deploy --only firestore:indexes
```

### 4b. Firebase Authentication

#### プロバイダの有効化

Email/Password・匿名・Google Sign-In は `firebase.json` の `auth.providers` ブロックで CLI 管理できる（それ以外のプロバイダは Firebase Console の Authentication > Sign-in method から有効化する）。

```json
{
  "auth": {
    "providers": {
      "emailPassword": true,
      "anonymous": true,
      "googleSignIn": {
        "oAuthBrandDisplayName": "疑似レジストラ",
        "supportEmail": "support@example.com"
      }
    }
  }
}
```

```bash
npx -y firebase-tools@latest deploy --only auth
```

#### メールドメイン許可制の実装（Auth Blocking Functions）

> ⚠️ **本プロジェクトでの採用状況（2026-08-27 追記）**: 以下は Auth Blocking Functions の一般的な実装方法の記録として残すが、本プロジェクト（`teamc-2026`）はこの方式を**採用していない**。実際に `functions/src/auth/blocking.ts` として実装し `firebase deploy` したところ、`400 OPERATION_NOT_ALLOWED : Blocking Functions may only be configured for GCIP projects.` によりトリガー登録が常に失敗した（`teamc-2026` は下記「要件・注意点」にある Identity Platform アップグレードを行っていない、素の Firebase Auth のため）。42関数のデプロイは成功する一方でこの2関数だけがエラーとなり、`firebase deploy` 自体が exit 1 で終了し続けていた。デプロイが失敗しトリガーが登録されない以上、この2関数は本番で一度も Auth から呼ばれておらず実効性もなかったため撤去した。現在のメールドメイン制限は `functions/src/auth/registration.ts`（`isAllowedEmailDomain`）と `functions/src/auth/verification.ts` が Auth ユーザー作成前に行っており、`docs/仕様/auth.md` §4.1・§6・§7.4・§9(v1.4) が最新の実装方針を記す。以下は Identity Platform アップグレード済みのプロジェクトで Blocking Functions を使う場合の一般的な実装手順として参考に残す。

「バックエンドでメールアドレスのドメインを判定し、許可ドメイン以外は登録を拒否する」は、**Cloud Functions の Auth Blocking Functions**（第2世代 `firebase-functions/v2/identity` の `beforeUserCreated` / `beforeUserSignedIn`）で実現できる。公式ドキュメント（[Extend Firebase Authentication with blocking functions](https://firebase.google.com/docs/auth/extend-with-blocking-functions)）で確認した要点は以下の通り。

**要件・注意点（公式ドキュメントで確認済み）**

- Blocking Functions を使うには、プロジェクトを **「Identity Platform を使用した Firebase Authentication」にアップグレード**する必要がある（Firebase Console の Authentication 画面からアップグレード可能。無料枠内でも一部機能が有料 API 呼び出しに変わる場合があるため、料金への影響はチームで事前確認すること）。
- `beforeUserCreated` はユーザーが Authentication に保存される**前**、クライアントへトークンが返る**前**に発火する。
- `beforeUserSignedIn` は認証情報の検証**後**、ID トークンが返る**前**に発火する（新規作成時は `beforeUserCreated` の後に `beforeUserSignedIn` も発火する）。
- 関数を削除する場合は、Authentication 側でもトリガー登録を解除しないと、**その後の認証が全滅する**（公式ドキュメントに明記）。

**ローカルエミュレータでの対応状況（要検証・既知の制約あり）**

- Auth Emulator は Blocking Functions を**サポートする**（[公式 Codelab](https://firebase.google.com/codelabs/auth-mfa-blocking-functions) で `auth, functions, firestore, ...` と併記されて起動する構成が示されている）。
- ただし以下の既知の不具合が `firebase-tools` の GitHub Issue で報告されている（本書作成時点で未解決の可能性があるため、実装前に各自の CLI バージョンで動作確認すること）:
  - Admin SDK 経由でユーザーを作成した場合、`beforeUserCreated` がエミュレータ上で発火しないことがある（[Issue #6235](https://github.com/firebase/firebase-tools/issues/6235)）。
  - `beforeUserSignedIn` のみを登録し `beforeUserCreated` を登録しない構成だと、エミュレータの起動自体に失敗することがある（[Issue 関連スレッド](https://lightrun.com/answers/firebase-firebase-tools-cannot-start-emulator-with-only-beforesignin-blocking-function)）。回避策として、使わない側も no-op のハンドラとして両方登録しておくと安定する。

**実装サンプル（TypeScript / v2 系）**

```typescript
// functions/src/auth-blocking.ts
import { beforeUserCreated, HttpsError } from "firebase-functions/v2/identity";

const ALLOWED_EMAIL_DOMAINS = ["example.com"];

export const enforceAllowedEmailDomain = beforeUserCreated((event) => {
  const email = event.data?.email;

  if (!email) {
    throw new HttpsError("invalid-argument", "メールアドレスが指定されていません。");
  }

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    throw new HttpsError(
      "permission-denied",
      "許可されていないメールドメインです。"
    );
  }

  // 必要ならここでユーザーレコードにカスタムクレーム等を付与して返せる
  // return { customClaims: { allowedDomain: domain } };
});
```

デプロイ:

```bash
npx -y firebase-tools@latest deploy --only functions:enforceAllowedEmailDomain
```

参考: 第1世代（v1）の書き方は以下（新規実装では v2 を推奨。移行前のコードを読む際の対応表として記載）:

```typescript
// v1 系（参考。新規実装には非推奨）
import * as functionsV1 from "firebase-functions/v1";

export const beforeCreate = functionsV1.auth.user().beforeCreate((user) => {
  const domain = user.email?.split("@")[1];
  if (domain !== "example.com") {
    throw new functionsV1.auth.HttpsError(
      "permission-denied",
      "許可されていないメールドメインです。"
    );
  }
});
```

### 4c. Cloud Functions（TypeScript, 第2世代）

`firebase init functions` で TypeScript を選択すると、`functions/` ディレクトリに以下が生成される。

```
functions/
├── package.json          # engines.node（Node 20 系 or 22 系を指定）, "build"/"serve"/"shell"/"deploy"/"logs" スクリプト
├── tsconfig.json
├── .eslintrc.js           # Lint を有効にした場合
├── src/
│   └── index.ts           # 関数のエントリポイント
└── lib/                    # tsc のビルド出力（.gitignore 対象）
    └── index.js
```

- Node ランタイムは Cloud Functions とも **Node.js 20 / 22 / 24 をサポート**（`engines.node` に反映される。18 系は非推奨→2025年に廃止）。**本リポジトリの `functions/package.json` は `engines.node: 24` を指定している**。
- ⚠️ Docker 運用時の注意: `docs/firebase/Dockerfile` のベースイメージは `node:20` 系のため、コンテナ内のエミュレータは Node 20 で関数を実行する（`engines.node: 24` との差異。エミュレータは警告を出すが動作はする）。
- 🔬 **要検証**: `firebase init functions` 実行時点でどの Node バージョンがデフォルト値として `package.json` に書き込まれるかは CLI のバージョンに依存するため、実行時に生成された値を確認すること。

`package.json` に生成される主なスクリプト:

```json
{
  "scripts": {
    "build": "tsc",
    "build:watch": "tsc --watch",
    "serve": "npm run build && firebase emulators:start --only functions",
    "shell": "npm run build && firebase functions:shell",
    "start": "npm run shell",
    "deploy": "firebase deploy --only functions",
    "logs": "firebase functions:log"
  }
}
```

ビルド・デプロイ:

```bash
cd functions
npm install
npm run build

# 全関数をデプロイ
npx -y firebase-tools@latest deploy --only functions

# 特定の関数だけデプロイ
npx -y firebase-tools@latest deploy --only functions:enforceAllowedEmailDomain

# 複数指定
npx -y firebase-tools@latest deploy --only functions:funcA,functions:funcB
```

ローカルエミュレータでの起動（デフォルトポート **5001**）:

```bash
npx -y firebase-tools@latest emulators:start --only functions
```

### 4d. GA4（Google Analytics）

- **プロジェクト作成時に有効化する場合**: `projects:create` 実行後、Firebase Console の初回セットアップ画面で Google Analytics を有効化し、既存または新規の GA4 プロパティに紐付ける。
- **後付けする場合**: Firebase Console の「プロジェクトの設定 > 統合」から Google Analytics を有効化できる。
- 測定ID（`G-XXXXXXX`）は Firebase Console の「プロジェクトの設定 > 全般」または GA4 側の「管理 > データストリーム」から確認できる。

Web SDK での初期化・イベント送信例（`firebase/analytics`）:

```typescript
import { initializeApp } from "firebase/app";
import { getAnalytics, logEvent } from "firebase/analytics";

const app = initializeApp({
  // Firebase Console の SDK 設定スニペットからコピー
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
  measurementId: "G-XXXXXXX",
});

const analytics = getAnalytics(app);

logEvent(analytics, "domain_search", {
  keyword: "panya",
  tld: ".com",
});
```

**開発時の注意点**

- GA4 は Firebase Local Emulator Suite の対象**外**（エミュレートされる Firebase サービス一覧に Analytics は含まれない）。ローカルで `getAnalytics()` を呼ぶと本番の GA4 プロパティに実データが送信される。
- 開発中に本番データを汚さないために、以下のいずれかの運用を推奨する:
  - 開発ビルドでは `getAnalytics()` の呼び出し自体をフラグで無効化する（`if (import.meta.env.PROD) { getAnalytics(app); }` 等）
  - 開発専用の GA4 プロパティ（別の測定ID）を用意し、環境変数で切り替える

### 4e. Realtime Database（将来利用時の参考）

`firebase init database` を実行すると以下が生成される:

```json
{
  "database": {
    "rules": "database.rules.json"
  }
}
```

`database.rules.json` の例（全拒否スタート）:

```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

エミュレータのデフォルトポート: **9000**

```bash
npx -y firebase-tools@latest emulators:start --only database
npx -y firebase-tools@latest deploy --only database
```

**Firestore との使い分け（一般的な指針）**

| | Firestore | Realtime Database |
|---|---|---|
| データ構造 | ドキュメント/コレクション（階層クエリが得意） | 1つの巨大な JSON ツリー |
| クエリ | 複合クエリ・インデックスが強力 | クエリは弱く、構造をフラット寄りに設計する必要がある |
| リアルタイム性 | 高い | 非常に高い（低レイテンシ用途向け） |
| 向いている用途 | 通常のアプリデータ全般（本プロジェクトのメイン候補） | プレゼンス（オンライン状態）、高頻度更新のカウンタ等 |

本プロジェクトでは基本的に Firestore をメインDBとし、Realtime Database は将来「オンライン状態の表示」等のピンポイントな用途が発生した場合の選択肢として記載している。

### 4f. キュー的な仕組み（将来利用時の参考）

Firebase/GCP エコシステムで使える選択肢の比較:

| 方式 | 概要 | セットアップ | ローカルエミュレータ対応 |
|---|---|---|---|
| (a) Firestore トリガー Functions | ドキュメント作成をキュー代わりに使う軽量な方式（`onDocumentCreated`） | `firebase init functions` のみ。追加インフラ不要 | Firestore エミュレータ + Functions エミュレータで対応（併用時は自動連携） |
| (b) Pub/Sub トリガー Functions | Cloud Pub/Sub のメッセージで Functions を起動（`onMessagePublished`, `firebase-functions/v2/pubsub`） | GCP コンソールまたは `gcloud pubsub topics create` でトピック作成が必要 | Pub/Sub エミュレータで**公式にサポート**（`firebase emulators:start --only pubsub,functions`） |
| (c) Cloud Tasks | HTTPターゲットのキュー（`onTaskDispatched`, `firebase-functions/v2/tasks`）。リトライ・レート制御が細かく設定できる | `gcloud tasks queues create` でキュー作成が必要な場合あり。基本は `firebase deploy` でキューも自動作成される | `firebase emulators:start --only tasks` で起動可能な**タスクエミュレータが存在する**（`--only` の有効値一覧に `tasks` が含まれることを CLI ヘルプで確認済み）。ただし本番の配信ロジックを完全再現するものではなく、`firebase-tools` の GitHub Issue で「本番と挙動が異なる／不安定」という報告が複数ある点は留意 |

**推奨**: まずは (a) Firestore トリガーで十分な場合が多い（例: 「注文が作られたら BRIDGE 層への登録処理をキックする」等）。厳密なリトライ制御や配信レートの制御が必要になった時点で (c) Cloud Tasks、複数コンシューマへのファンアウトが必要になった時点で (b) Pub/Sub を検討する。

---

## 5. Firebase Local Emulator Suite

### 5.1 `firebase.json` の設定例（全サービス）

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "functions": {
    "source": "functions"
  },
  "auth": {
    "providers": {
      "emailPassword": true
    }
  },
  "database": {
    "rules": "database.rules.json"
  },
  "hosting": {
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
  },
  "emulators": {
    "auth": { "port": 9099 },
    "functions": { "port": 5001 },
    "firestore": { "port": 8080 },
    "database": { "port": 9000 },
    "hosting": { "port": 5000 },
    "pubsub": { "port": 8085 },
    "storage": { "port": 9199 },
    "eventarc": { "port": 9299 },
    "ui": {
      "enabled": true,
      "port": 4000
    },
    "singleProjectMode": true
  }
}
```

### 5.2 ポート一覧表

| サービス | デフォルトポート |
|---|---|
| Emulator UI | 4000 |
| Hosting | 5000 |
| Cloud Functions | 5001 |
| Firestore | 8080 |
| Pub/Sub | 8085 |
| Realtime Database | 9000 |
| Authentication | 9099 |
| Cloud Storage | 9199 |
| Eventarc | 9299 |
| Cloud Tasks | 9499 |

`--only` に指定できるエミュレータ名は CLI ヘルプ（`emulators:start --help`, 本書作成時点）で以下の通り確認済み: `apphosting`, `auth`, `functions`, `firestore`, `database`, `hosting`, `pubsub`, `storage`, `eventarc`, `dataconnect`, `tasks`（Cloud Tasks。§4f 参照）。

### 5.3 起動コマンド

```bash
# firebase.json に定義された全エミュレータを起動
npx -y firebase-tools@latest emulators:start

# 特定サービスのみ
npx -y firebase-tools@latest emulators:start --only firestore,auth,functions
```

### 5.4 データの永続化

```bash
# 終了時に自動でエクスポート、起動時に前回データをインポート
npx -y firebase-tools@latest emulators:start --import=./emulator-data --export-on-exit

# インポート先とエクスポート先を分けたい場合
npx -y firebase-tools@latest emulators:start --import=./seed-data --export-on-exit=./emulator-data
```

- `--export-on-exit` に引数を省略した場合は `--import` で指定したディレクトリがそのまま使われる。
- エクスポートされたディレクトリには `firebase-export-metadata.json` が含まれる。

### 5.5 CI 向け: `emulators:exec`

エミュレータを起動 → 指定したスクリプトを実行 → 自動終了、まで一括で行う。CI に向いている。

```bash
npx -y firebase-tools@latest emulators:exec --only firestore,auth,functions "npm test"
```

---

## 6. Docker でのエミュレータ運用

`docs/firebase/Dockerfile` と `docs/firebase/docker-compose.yml` を用意している。**Firebase 公式が配布している Docker イメージは存在しない**（`firebase-tools` は npm パッケージとしてのみ公式配布）ため、本 Dockerfile は Node.js 公式イメージ + OpenJDK（Firestore エミュレータの実行に Java が必要）+ `firebase-tools` という構成で作成している。

✅ **`docker compose up` でエミュレータ一式が起動することを、このリポジトリの実際の `firebase.json` / `functions/` に対して実機で動作確認済み**（Auth・Functions・Firestore・Cloud Tasks が起動し、ホスト側の `curl`/ブラウザから `4000`/`9099`/`8080`/`5001` に到達できることを確認）。ビルド・起動コマンドは通常の `docker compose` の作法どおりで、これ以外に特別な準備は不要。

### 6.1 起動方法

```bash
cd docs/firebase
docker compose up --build
```

Functions は単一コードベース構成（`firebase.json`: `functions/` = `default`。旧 `functions-stubs/` = `stubs` は全スタブの実移行完了に伴い削除済み）。エミュレータはコンパイル済みの `lib/index.js` を読む。

- `functions/`（`default`）は `docker-compose.yml` の `command` が
  コンテナ起動のたびに `npm --prefix functions run build` を実行してから
  `emulators:start` するので、**手動ビルドは不要**（`firebase.json` の
  `predeploy` は `firebase deploy` 時にしか走らないため、これを外すと
  `emulators:start` はビルドを一切挟まない）。
- **起動したあとの `functions/src` の編集も反映される**: 同じ `command` が
  `npm --prefix functions run build:watch`（`tsc --watch`）をバックグラウンドで
  常駐させるので、保存すると `lib/` が再生成され、Functions エミュレータの
  `lib/` 監視によるホットリロードが拾う（コンテナ再起動は不要）。
  コンパイルエラーは `docker compose logs -f firebase-emulators` に出る。
  ⚠️ この watch が無かった頃は、起動後に追加した関数が登録されないまま
  `Function <name> does not exist` の素の 404 が返り、その 404 には CORS ヘッダが
  付かないため**ブラウザ上は CORS エラーに見える**という誤認が起きていた。
  同種の症状が出たら 8.6 節の切り分け手順を先に試すこと。
- ⚠️ `npm install` を `--prefix` 付きで実行しない（CWD の package.json を依存として注入する挙動を実機で確認済み）。インストールは**対象ディレクトリに cd してから**実行する（`npm --prefix functions run build` のような `run` は安全で、compose の起動コマンドが使用している）。

⚠️ **Windows ホストではビルドしただけでは反映されない**（次節の自動リロード不可の項を参照）。

#### レジストリ認証情報（APIキー等）の渡し方

`functions/` の `defineSecret`（共通シークレット統合後の5項目: `BASIC_GATE_USER` / `BASIC_GATE_PASSWORD` / `REGISTRAR_ID` / `KITAQSIGN_API_KEY` / `KITAQNIC_API_KEY`。`functions/.secret.local.example` 参照）は、エミュレータでは **`functions/.secret.local` からのみ**解決される（process.env は読まない。無ければ Secret Manager へ行き認証エラーになる）。

- **推奨**: 各自の OS のシステム環境変数に同名で設定しておく（例: Windows のユーザー環境変数に `KITAQSIGN_API_KEY`）。`docker compose up` 時に compose がホストの環境変数をコンテナへ渡し、**起動スクリプトが `functions/.secret.local` を自動生成**する
- 既に `functions/.secret.local` が手書きで存在する場合は**一切上書きしない**
- 環境変数を更新したら、`functions/.secret.local` を削除して `docker compose up` し直すと再生成される
- ⚠️ 環境変数を追加した後に開いた**新しいターミナル**から `docker compose up` すること（既存シェルは古い環境を引き継いでいる）
- 未設定の値は空のまま生成され、該当 secret の Secret Manager フォールバック（`Failed to authenticate` の警告）がログに出るが、エミュレータの動作自体は継続する

- リポジトリルート（`firebase.json` や `functions/` がある場所）を丸ごとコンテナの `/workspace` にマウントするので、`docs/firebase/` の外にある実際の設定がそのまま使われる。
- 初回はイメージのビルドに数分かかる（`openjdk-21-jdk-headless` のインストールと `firebase-tools` のグローバルインストールを含む）。2回目以降はキャッシュが効くので速い。
- 起動後、ブラウザで `http://localhost:4000` を開くと Emulator UI が表示される。
- 停止: `docker compose down`

### 6.2 コンテナ外からアクセスする場合の注意（重要・対応済み）

Firebase Emulator Suite の各エミュレータは、既定では**コンテナ内の `127.0.0.1` にのみ bind する**。そのため `docker-compose.yml` で `ports:` を公開していても、`firebase.json` 側で `host` を指定しなければホスト側（ブラウザや、コンテナ外で動かすアプリ）から接続できない。

このリポジトリの `firebase.json` はすでに全エミュレータに `"host": "0.0.0.0"` を設定済みなので、追加対応なしで `docker compose up` → ホストからアクセス、が動く（上記の動作確認はこの設定で行った）。ローカル（コンテナを使わない、CLIを直接叩く）開発でも `0.0.0.0` バインドで問題なく `localhost` から接続できるため、CLI直接実行とDocker運用で `firebase.json` を出し分ける必要はない。

### 6.3 既知の注意点（実機検証で判明したもの）

- **関数ロードの10秒タイムアウト（対応済み）**: Windows のバインドマウント経由では関数コードのロードが既定の10秒を超え、`Failed to load function definition from source: ... Timeout after 10000` で全関数が未ロードになる現象を実機で確認した。`docker-compose.yml` の `environment` に `FUNCTIONS_DISCOVERY_TIMEOUT=120` を設定して回避済み（削らないこと）。
- **Windows では `lib/` 変更の自動リロードが効かない**: Functions エミュレータは `lib/` を監視しているが、Windows ホストのバインドマウントではファイル変更通知が伝播しないため、ビルド後もコンテナ内は旧コードのまま応答し続ける。起動後に編集した場合だけでなく、**`git pull` やブランチ切替で新しい関数が入ってきた場合も同様に反映されない**（実例: DNS Callable 実装 `b7bc3ec` を pull した後もコンテナが旧 `lib/` のままで、`listDnsRecords` が §8.6 の「CORS エラーに見える 404」になった）。`functions/`（`default`）は `docker restart registrar-firebase-emulators` するだけで `command` が自動的に再ビルドしてから起動し直すので、ビルドを手動で挟む必要はない。再起動直後は関数ディスカバリが数分単位で進行し、その間の呼び出しは "Function does not exist" になる（待って再試行で解消）。Auth エミュレータのユーザーも再起動で消える点に注意（開発用ユーザーはフロントの `devCallableAuth` シムが自動再作成する）。
- **macOS で `5000` 番ポートが衝突する**: macOS は AirPlay Receiver（`ControlCenter`）が既定で `5000` 番を握っているため、Hosting エミュレータのポートを公開しようとすると `address already in use` で `docker compose up` が失敗する。このプロジェクトは `firebase.json` に `hosting` の定義自体はある（デプロイ用: `frontend/dist` + セッション API の rewrites）が、`emulators` セクションに `hosting` を含めておらず、`docker-compose.yml` でも `5000:5000` はコメントアウトしてある。Hosting エミュレータをローカルで使う場合は、`firebase.json` の `emulators` に `hosting`（`host: "0.0.0.0"`）を追加のうえ `docker-compose.yml` の該当行のコメントを外す（衝突する場合は macOS の「システム設定 > 一般 > AirDropとHandoff」で AirPlay Receiver をオフにするか、公開ポート番号自体を変更する）。
- **`docker compose down` で `--export-on-exit` が意図した場所に書き出されないことがある**: `--export-on-exit=/workspace/emulator-data` を指定していても、`docker compose down`（SIGTERM）での終了時に、指定パスではなくリポジトリ直下に `firebase-export-<タイムスタンプ>/` という名前でエクスポートされるケースを実機で確認した（原因は未特定。`docker compose stop` を使わず `docker exec <container> firebase emulators:export /workspace/emulator-data` のように明示的にエクスポートしてから停止する運用の方が確実）。このディレクトリと `firestore-debug.log` 等は `.gitignore` に追加済みなので誤コミットはしないが、ディスクには残るので気づいたら手動で削除すること。

### 6.4 データの永続化

```bash
docker compose up   # emulator-data という名前付きボリュームに自動でインポート/エクスポートされる
```

- エミュレータデータは名前付きボリューム（`firebase-emulator-data`）でホストと切り離して永続化する。ホスト側のディレクトリに直接エクスポートしたい場合は、`docker-compose.yml` の該当ボリュームをバインドマウント（例 `./emulator-data:/workspace/emulator-data`）に変更する。
- ボリュームを完全にリセットしたい場合: `docker compose down -v`（`-v` を付けないとボリュームは残る）。

### 6.5 コンテナはログイン状態を持たない

エミュレータはローカルの模擬環境であり実プロジェクトへの認証は不要なため、`docker compose up` だけで動作する（本番へのデプロイ等、認証が必要な操作はコンテナの外、各自の手元の CLI から行うこと。§2 の手動運用方針と一致させる）。

### 6.6 Makefile 等は必要か

**不要。** `docker compose up` / `docker compose down` の2コマンドで完結する構成なので、Makefile・justfile のような追加のタスクランナーを導入するメリットは薄い（覚えることが増えるだけで、`docker-compose.yml` 自体がすでに「起動コマンドの定義」の役割を果たしている）。

- `npm --prefix functions run build` / `run lint` のような Node 側のコマンドは、Docker を使わない場合は `functions/package.json` の `scripts` がすでにその役割を持っている。
- チームの中で「エミュレータ起動」「Functionsビルド」等をワンコマンド化したい要望が具体的に出てきた時点で、`package.json` の `scripts`（ルートに追加するなら軽量）か、必要性が明確になってから Makefile を検討すれば十分。現時点で先回りして作る理由はない。

---

## 7. デプロイコマンド一覧

`firebase deploy --help`（本書作成時点のバージョン）で確認したデプロイターゲット一覧:

| ターゲット | コマンド | 備考 |
|---|---|---|
| Firestore（ルール+インデックス） | `firebase deploy --only firestore` | ルールのみ `firestore:rules` / インデックスのみ `firestore:indexes` |
| Realtime Database | `firebase deploy --only database` | セキュリティルールをデプロイ |
| Cloud Functions | `firebase deploy --only functions` | 特定関数のみ `functions:funcName`、複数指定はカンマ区切り |
| Hosting | `firebase deploy --only hosting` | 静的アセット・リダイレクト・リライト等 |
| Cloud Storage | `firebase deploy --only storage` | セキュリティルール |
| Authentication | `firebase deploy --only auth` | `firebase.json` の `auth.providers` 設定を反映 |
| Remote Config | `firebase deploy --only remoteconfig` | |
| Extensions | `firebase deploy --only extensions` | インストール済み拡張機能の設定変更 |
| すべて | `firebase deploy` | `firebase.json` に定義された全ターゲット |

複数ターゲットの同時指定例:

```bash
npx -y firebase-tools@latest deploy --only firestore,functions,auth
```

---

## 8. トラブルシューティング

### 8.1 ログインしているアカウントが想定と違う

```bash
# 現在ログイン中のアカウント一覧を確認
npx -y firebase-tools@latest login:list

# 別アカウントを追加認可
npx -y firebase-tools@latest login:add

# このディレクトリ（または全体）のデフォルトアカウントを切り替える
npx -y firebase-tools@latest login:use <正しいemail>

# それでも直らない場合は一度ログアウトしてから入り直す
npx -y firebase-tools@latest logout <誤って使っていたemail>
npx -y firebase-tools@latest login
```

コマンド単位で一時的に別アカウントを使いたいだけなら、デフォルトを変えずに `--account <email>` を都度付ける方法もある（§2.3）。

### 8.2 `firebase use` した覚えのないプロジェクトにデプロイされそうになる

```bash
# 現在の紐付けを確認
npx -y firebase-tools@latest use

# 正しいプロジェクトへ張り替える
npx -y firebase-tools@latest use --add <正しいPROJECT_ID>
```

デプロイ直前に `-P <alias_or_project_id>` を明示すれば、`.firebaserc` の設定に関わらずそのコマンドだけ確実に対象プロジェクトを指定できる。

### 8.3 Blocking Functions を追加したらエミュレータが起動しない

⚠️ **本プロジェクトでの状況（2026-08-27 追記）**: `teamc-2026` は Identity Platform 未アップグレードのため Blocking Functions を採用しておらず、`functions/src/auth/blocking.ts` ごと撤去済み（§4b 追記、`docs/仕様/auth.md` §6・§9 v1.5 参照）。本節・§8.4 は現在の本プロジェクトには適用されない。Identity Platform 対応プロジェクトで Blocking Functions を再導入する場合の参考として残す。

§4b で触れた既知の不具合（`beforeUserSignedIn` のみ登録している場合に発生しやすい）。`beforeUserCreated` / `beforeUserSignedIn` を両方とも（片方が不要でも no-op で）登録してから再度 `emulators:start` を試す。

⚠️ **実測で判明した追加の注意点**（2026-08-25, `firebase-tools@15.28.1`, `docs/仕様/auth.md` 実装時）: 両方登録した状態で起動直後は正常に発火するが、Functions エミュレータのホットリロードを挟みながら長時間（数時間単位）起動しっぱなしにしていると、Auth↔Functions 間のブロッキングトリガー接続が無音のまま失われ、ブロッキング関数がエラーも出さずに発火しなくなる現象を確認した。ドメイン制限などが効いていないと感じたら、まずコンテナ／エミュレータを再起動して切り分けること。

### 8.4 Auth Blocking Functions が Admin SDK 経由のユーザー作成で発火しない

エミュレータ上の既知の制約（§4b 参照）。クライアント SDK（`createUserWithEmailAndPassword` 等）経由でのユーザー作成では発火するため、テストシナリオをクライアント経由に寄せることで回避できる場合がある。（本プロジェクトでは Blocking Functions 自体を撤去済み。§8.3 の追記を参照）

### 8.5 GA4 のイベントがローカル開発中に本番へ飛んでしまう

§4d の通り GA4 はエミュレータ非対応のため、開発ビルドでは `getAnalytics()` の呼び出し自体をフラグで抑止する。

### 8.6 呼び出しが "Function does not exist, valid functions are: ..." になる

⚠️ **ブラウザからはこれが CORS エラーとして見える。** 未登録の関数を呼ぶと、CORS
ヘッダを付ける関数ハンドラの手前で Express が素の 404 を返すため、
`No 'Access-Control-Allow-Origin' header is present on the requested resource` に
なる。CORS 設定を疑う前に、まず素の `curl` でレスポンス本文を確認すること
（`curl` はプリフライトを行わないので、404 の本文＝登録済み関数一覧が読める）:

```bash
# 例: listDnsRecords を確認する場合（<functionName> の部分を対象の関数名に差し替える）
curl -i -X POST http://127.0.0.1:5001/demo-teamc-2026/asia-northeast2/listDnsRecords \
  -H 'Content-Type: application/json' -d '{"data":{}}'
```

登録済みなら 401 `{"error":{"message":"ログインが必要です。","status":"UNAUTHENTICATED"}}` の
ような**関数ハンドラ由来の応答**が返る（= 関数は生きていて、問題は別にある）。未登録なら
404 で本文に登録済み関数一覧が並ぶ。

原因は2通りで、どちらも §6.1 / §6.3 に対処がある。

1. **ディスカバリ進行中**: コンテナ起動・再起動の直後は関数のロードに数分かかることがある。Emulator UI（`http://localhost:4000`）の Functions タブに関数が並ぶまで待って再試行する。
2. **反映漏れ**: `functions/`（`default`）は `docker restart registrar-firebase-emulators` だけで自動的に再ビルドされ、起動後の編集も `command` が常駐させる `tsc --watch` が拾うため、macOS/Linux では通常このケースには該当しない。**ただし Windows ホストは除く** — バインドマウントの変更通知が伝播しないため watch もエミュレータの `lib/` ホットリロードも効かず（§6.3）、**`git pull` / ブランチ切替で新しい関数が増えたら、コンテナ再起動（`docker compose restart`）が必須**。再起動でも解消しない場合は (a) `docker compose logs firebase-emulators` に tsc のコンパイルエラーが出ていないか、(b) `functions/src/index.ts` から目的の関数が export されているか、を順に確認する。それでも解消しない場合はコンテナを作り直す: `docker compose up -d --build`。

実例（2026-08 に実機で発生）: DNSレコード設定画面を開くと UI が internal エラーになり、ブラウザコンソールには `listDnsRecords` への CORS エラー（`No 'Access-Control-Allow-Origin' header is present`）と `POST ... net::ERR_FAILED` が出た。原因は DNS Callable 実装（`b7bc3ec`）より前に起動した Windows 上のコンテナが旧 `lib/` のまま動いていて、`listDnsRecords` / `saveDnsRecords` / `resolveDns` が未登録だったこと（前段の素の 404 が CORS エラーとして見えていた）。コンテナ再起動 → Emulator UI の Functions タブに `listDnsRecords` が並ぶのを待って再試行、で解消。コード側（`functions/src/api/dnsRecords.ts` / `frontend/src/api/dnsApi.ts`）には問題はなかった。

---

## 9. 参考文献

本書の作成にあたり、以下の Firebase 公式ドキュメント・公式 Codelab、および Firebase CLI の `--help` 出力（`firebase-tools@15.28.1`）を実際に確認した。

- [Extend Firebase Authentication with blocking functions](https://firebase.google.com/docs/auth/extend-with-blocking-functions)
- [Auth blocking triggers (2nd gen) — firebase-functions reference](https://firebase.google.com/docs/functions/auth-blocking-events)
- [Auth blocking triggers (1st gen)](https://firebase.google.com/docs/functions/1st-gen/auth-blocking-events-1st)
- [Advanced Authentication features — Firebase Codelab (MFA + Blocking Functions on Emulator Suite)](https://firebase.google.com/codelabs/auth-mfa-blocking-functions)
- [Get started with Cloud Functions for Firebase](https://firebase.google.com/docs/functions/get-started?gen=2nd)
- [Write Cloud Functions with TypeScript](https://firebase.google.com/docs/functions/typescript)
- [Configure Authentication providers using the Firebase CLI](https://firebase.google.com/docs/auth/configure-providers-cli)
- [Introduction to Firebase Local Emulator Suite](https://firebase.google.com/docs/emulator-suite)
- [Install, configure and integrate Local Emulator Suite](https://firebase.google.com/docs/emulator-suite/install_and_configure)
- [Connect your app to the Authentication Emulator](https://firebase.google.com/docs/emulator-suite/connect_auth)
- [Run functions locally (Cloud Functions emulator, Pub/Sub, Tasks background triggers)](https://firebase.google.com/docs/functions/local-emulator)
- [Get to know Firebase for Web / Analytics overview](https://firebase.google.com/docs/web/setup)
- GitHub Issue: [Emulator: beforeUserCreated blocking function not triggered when creating user via Admin SDK (#6235)](https://github.com/firebase/firebase-tools/issues/6235)
- GitHub Issue: [Cloud Tasks emulator behavior discussion (#4884)](https://github.com/firebase/firebase-tools/issues/4884)
- CLI 実行結果: `npx -y firebase-tools@latest --version`（`15.28.1`）、`--help`、`login --help`、`use --help`、`deploy --help`、`init --help`、`emulators:start --help`（すべて本書作成時に実行し出力を確認）

---

## 未解決点・要検証事項まとめ

- `firebase init functions` で TypeScript を選んだ際に `package.json` の `engines.node` へ**デフォルトで書き込まれる Node バージョン**（20 系か 22 系か）は CLI バージョン依存のため、実行時に生成結果を確認すること（§4c）。
- Auth Blocking Functions のローカルエミュレータ対応には既知の不具合報告がある（§4b, §8.3, §8.4）。実装前に、使う予定の `firebase-tools` バージョンで簡単な疎通確認を行うことを推奨する。
- Identity Platform へのアップグレードに伴う料金への影響は、本書執筆時点の一般情報のみに基づく記載であり、利用中の Firebase プランの請求方針・上限を優先して確認すること。
