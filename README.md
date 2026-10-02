# ゼロからドメイン — 疑似ドメインレジストラ Web アプリ

GMOインターネットグループの学生ハッカソン（5日間）で、4名のチームで開発したドメインレジストラ（ドメイン登録サービス）の Web アプリケーションです。
「ドメイン・DNS の事前知識がない初学者でも、ドメイン取得から DNS 設定・維持までひとりで完走できる」ことをテーマにしています。

> 料金・決済・レジストリはすべて演習用のダミーです。実在のドメインが取得されることはありません。

## 概要

- ハッカソン用に提供された 2 つの**モックレジストリ**（Kitaqsign / Kitaqnic、EPP 相当の HTTP API）に接続し、レジストラとしての一連の操作を実装しています。
  - レジストリ API の仕様書などハッカソン提供資料は、このリポジトリには含めていません。
- 主な機能
  - ドメイン検索（TLD ごとの空き状況・価格表示、空きがない場合の類似候補提案）
  - 登録（疑似決済 → 登録）・更新・情報変更・廃止・復旧（RGP）・移管 IN / OUT・authInfo 再発行・ロック
  - 自動更新 ON/OFF と期限切れドメインの整理バッチ、レジストリ poll メッセージの定期取得
  - 会員登録（メール認証コード付きウィザード）・ログイン（Firebase Authentication + Session Cookie）
  - レンタル DNS 相当のレコード管理と、サービス別 DNS レシピ・設定案内の貼り付けパーサ
  - 目的（Web 公開 / メールなど）から案内する「かんたんモード」
  - ブラウザ内 LLM（WebLLM）による操作案内 AI アシスタント
  - レジストリ障害（503）・メンテナンス時のサーキットブレーカーと状態表示

## 技術スタック

| 領域           | 使用技術                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| フロントエンド | React 19 / TypeScript / Vite / React Router / Tailwind CSS v4 / shadcn/ui（Radix UI）/ React Hook Form + Zod / WebLLM            |
| バックエンド   | Cloud Functions for Firebase（第2世代, TypeScript, Node.js 24, asia-northeast2）                                                 |
| データ・認証   | Cloud Firestore / Firebase Authentication                                                                                        |
| テスト         | Vitest + Testing Library + MSW（フロント）/ `node:test` + Firestore エミュレータ（Functions）/ Playwright（AI アシスタント評価） |
| 品質・CI       | ESLint（Google スタイル）/ oxlint / GitHub Actions（lint・build・単体テスト・エミュレータ統合テスト、Functions のデプロイ）      |
| 開発環境       | Firebase Local Emulator Suite（Docker Compose）                                                                                  |

## アーキテクチャ

```
[ ブラウザ ] React SPA（通常モード / かんたんモード / AI アシスタント）
     │  Firebase callable
     ▼
[ API 層 ]     functions/src/api     … 認可・入力検証・エラー整形（callable）
[ ドメイン層 ] functions/src/domain  … 注文・登録・更新・移管・DNS・期限管理などの業務ロジック
[ BATCH ]      functions/src/jobs    … poll ワーカー / 期限切れ整理（onSchedule）
[ BRIDGE 層 ]  functions/src/bridge  … レジストリごとの API 差分を吸収する共通クライアント
     │  HTTP（EPP 相当）
     ▼
[ Kitaqsign ] [ Kitaqnic ]  （ハッカソン用モックレジストリ）
```

- レジストリ通信は BRIDGE 層の `EppClient` に一本化し、HTTP ステータスと EPP result code の2段判定・リトライ・通信ログ記録を共通化しています。
- 注文 ID から決定的に生成する clTRID と Firestore トランザクションにより、タイムアウト後の再試行でも二重登録・二重課金が起きないようにしています。
- TLD → レジストリのルーティングはレジストリから取得した対応 TLD 一覧から自動生成します（障害時のみ静的フォールバック）。

## ローカルでの起動（Firebase エミュレータ）

実 Firebase プロジェクトには接続せず、`demo-teamc-2026`（`demo-` プレフィックスによりオフライン動作が保証されるプロジェクト ID）のエミュレータで動かします。

前提: Docker（Docker Compose）、Node.js 24

```bash
# 1. エミュレータ一式（Auth / Functions / Firestore など）を起動
#    起動時に functions/ のビルドと tsc --watch も自動で行われる
cd docs/firebase && docker compose up --build    # Emulator UI: http://localhost:4000

# 2. フロントエンド（別ターミナル）
cd frontend && npm install && npm run dev        # http://localhost:5173
```

- レジストリに接続する機能（検索・登録・更新・移管など）は、モックレジストリの認証情報を `functions/.secret.local` に設定する前提です（`functions/.secret.local.example` 参照）。ハッカソン終了に伴いモックレジストリは利用できないため、現在これらの機能は手元では動作しません。Firestore だけで完結する機能（DNS レコード管理など）とテストは動作します。
- エミュレータではスケジュール関数が発火しないため、poll ワーカー相当の処理は `scripts/poll-loop.sh` で手動実行します。
- 詳細は [`docs/firebase/README.md`](docs/firebase/README.md)（エミュレータ・Docker）、[`frontend/README.md`](frontend/README.md)、[`functions/README.md`](functions/README.md) を参照してください。

### テスト

```bash
cd frontend && npm test                              # Vitest（ネットワーク・エミュレータ不要）
cd functions && npm run build && npm run test:unit   # Functions 単体テスト
scripts/test-docker.sh                               # エミュレータコンテナ内で Functions の全テスト（スタブレジストリ使用）
```

## デプロイ状況

ハッカソン期間中は Firebase（Cloud Functions / Firestore）と Cloudflare Pages（フロントエンド）にデプロイしていましたが、現在は停止しています。

## チーム

4名のチーム開発

開発には AI コーディングエージェント（Claude Code / Codex）を活用しました。

## 自分（@tamu555）の担当

主にバックエンド（Cloud Functions）のレジストリ連携とドメインのライフサイクル処理を担当しました。

- **BRIDGE 層の初期実装とドメイン登録（create）**: 共通 HTTP クライアント（2段判定・通信ログ）、Kitaqsign / Kitaqnic クライアント、TLD ルーティング、clTRID 採番、注文・疑似決済からの登録処理、`searchDomains` / `createOrder` callable
- **廃止・復旧（delete / restore, RGP）**: 猶予期間の扱い、他会員が取得し直したドメインへの廃止・復旧の防止、統合テスト
- **poll ワーカー**: レジストリの poll メッセージ取得・ack の定期処理（両レジストリの方式差の吸収）、ローカル用 `scripts/poll-loop.sh`
- **移管 IN / OUT**: 移管申請・承認・拒否・取り下げの callable と poll 通知処理、フロントエンドとの接続、承認通知の安定化
- **authInfo 再発行**、**自動更新 OFF ドメインの期限切れ整理バッチ**（`expiryWorker` / `runExpirySweep`）、**通信ログの保持期間管理**
- **レジストリ仕様変更への耐性**: 仕様変更時にデータを壊さないためのガードと移行テスト、TLD 割り当て変更に伴うハードコードの解消
- **不具合修正**: 二重更新の防止、残り日数の1日ずれ、ロックボタン、ネームサーバー設定、両レジストリがメンテナンス中でもドメイン検索できるようにする対応 など

## 補足

- `docs/` 配下の設計資料やコード中のコメントには、公開版に含めていないチーム内部の仕様書草案（`registrar-spec-draft.md`）・レジストリ API 資料・作業メモへの参照（`§` 番号など）が残っています。
- `.firebaserc` のプロジェクト `teamc-2026` は停止済みです。

## ライセンス

ライセンス未設定（全権利は各コントリビューターに帰属）
