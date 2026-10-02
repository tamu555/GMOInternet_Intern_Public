# Firebase デプロイパイプライン (`firebase-deploy` ブランチ)

Cloud Functions と Firestore の rules / indexes を、専用ブランチ `firebase-deploy`
経由でのみデプロイするための CI/CD 構成。

- ワークフロー: [`.github/workflows/firebase-deploy.yml`](../../.github/workflows/firebase-deploy.yml)
- 再利用される既存 CI: [`.github/workflows/firebase-auth-ci.yml`](../../.github/workflows/firebase-auth-ci.yml)

## 導入の順序

初めて使うときは、この順で進めること。順序を飛ばすと原因の分かりにくい失敗になる。

1. [サービスアカウントを作り、`FIREBASE_SERVICE_ACCOUNT` シークレットを登録する](#セットアップ-firebase_service_account-シークレット)
2. [**手元から 1 回だけ手動でデプロイし、クリーンアップポリシーを確定させる**](#初回デプロイだけは手元から手動で行う)
3. `firebase-deploy` ブランチを作る（ブランチ作成では CD は走らない）
4. `firebase-deploy` にブランチ保護を掛け、直接 push を禁止する（[推奨](#ブランチ保護の推奨設定)）
5. 以降は [PR をマージするだけ](#運用フロー)

## 起動条件: PR のマージのみ

デプロイの入口は**ただ 1 つ**、`firebase-deploy` を base とする Pull Request がマージされた
ときだけである。

| 操作 | CD |
|---|---|
| `firebase-deploy` への PR がマージされた | ✅ 走る |
| `firebase-deploy` への PR がマージされずにクローズされた | ❌ 走らない |
| `firebase-deploy` ブランチの新規作成 | ❌ 走らない |
| `firebase-deploy` への直接 push / force push | ❌ 走らない |
| 他ブランチ宛の PR がマージされた | ❌ 走らない |
| 手動実行 | ❌ できない（`workflow_dispatch` を意図的に持たない） |

`push` トリガーを一切持たないため、直接 push とブランチ作成は構造的に CD を起動できない。
GitHub には「PR がマージされた」というイベントが存在しないので、`pull_request` の `closed`
を購読したうえで全ジョブを `if: github.event.pull_request.merged == true` で守っている。
`branches: [firebase-deploy]` は PR の **base** に対するフィルタなので、他ブランチ宛の PR では
そもそも起動しない。

失敗したデプロイをやり直したい場合は、その run の **「Re-run jobs」** を使う（元のマージ
イベントが再生される）。手動実行の口を用意していないのは、「PR 経由のみ」という不変条件に
抜け道を作らないため。

## 3 つのジョブ

| # | ジョブ | 内容 |
|---|--------|------|
| 1 | `preflight` | 秒で終わる事前チェック（シークレットの有無 + レートリミット）。**最初**に走るので、デプロイできないマージで重いテストに Actions 分数を溶かさない |
| 2 | `ci` | `firebase-auth-ci.yml` を `workflow_call` で丸ごと再利用（lint / build / unit + エミュレータ統合テスト 3 種） |
| 3 | `deploy` | `firebase deploy --only functions,firestore` |

`ci` と `deploy` は `github.event.pull_request.merge_commit_sha`、つまり
`firebase-deploy` に実際に載ったコミットを明示的に checkout する。既定の checkout 先である
PR のテストマージ ref（`refs/pull/N/merge`）は、PR がクローズされた後に GitHub 側で回収されて
いることがあるため。この指定のために `firebase-auth-ci.yml` へ `ref` 入力を追加してある
（`push` / `pull_request` で直接起動されたときは空文字になり、既定挙動に戻る）。

`concurrency: firebase-deploy` により同時実行は 1 本に直列化される。同じプロジェクトへ
`firebase deploy` が並走すると競合するのに加え、成功回数のカウントが古い値を読むため。

## デプロイ対象

```
firebase deploy --only functions,firestore --project teamc-2026 --non-interactive
```

`--only` の指定は利便性ではなく**安全装置**である。

- **Hosting は絶対にデプロイしない。** `firebase.json` には `hosting` ブロックが存在するが、
  このプロジェクトのフロントエンドは Cloudflare で配信され、main への push で別パイプラインが
  デプロイしている。`--only` を外すと Hosting まで巻き込む。
- 副次的な効果として、Hosting の `predeploy`（`npm --prefix frontend run build`）も走らない。

`--force` は付けていない。ソースから消えた関数はプロジェクト側から自動削除されず、警告のみで
スキップされる。関数の削除は意図的な手動操作とする:

```bash
firebase functions:delete <name> --region asia-northeast2
```

## レートリミット

**直近 60 分に成功したデプロイが 5 回に達している場合、ワークフローを失敗させる。**

### 「失敗はリミットを消費しない」の仕組み

カウントの元データは、この workflow 自身の実行履歴のうち **`deploy` ジョブが `success` で
終わったもの**だけである。別途カウンタや状態ファイルを持つ必要がなく、GitHub の実行履歴が
そのまま唯一の真実になる。

| 起きたこと | `deploy` ジョブ | 消費 |
|---|---|---|
| デプロイが通った | `success` | **1 回** |
| テストが落ちた | 実行されない | なし |
| デプロイが落ちた | `failure` | なし |
| レートリミットで弾かれた | 実行されない | なし |
| PR がマージされずにクローズされた | `skipped` | なし |

> **run 全体の結論ではなく、`deploy` ジョブの結論を見ているのが要点。**
> 全ジョブが `if` でスキップされた run（＝マージなしクローズ）は失敗ではないため、run の
> `conclusion` だけを信じるとリミットを 1 回消費してしまう。ジョブ単位まで降りて確認する
> ことで、この穴と、一部ジョブだけを再実行した run の両方を正しく除外できる。
>
> 実装上、ゲートは `deploy` ジョブを**表示名で照合**する。`deploy` ジョブに `name:` を
> 付けていないのはこのためで、GitHub がジョブ ID をそのまま表示名にする性質に乗っている。
> `deploy` ジョブに `name:` を足すとカウントが壊れるので注意。

ジョブ照会は窓（直近 60 分）に入っている run に対してのみ行うので、追加の API 呼び出しは
多くても数回で済む。窓は固定時間枠ではなくローリングウィンドウで、各 run の `updated_at`
（完了時刻）を基準にする。

### 超過したときの表示

エラーメッセージとジョブサマリの両方に、次に実行できるまでの待ち時間が出る:

```
デプロイのレートリミットに達しました: 直近60分で成功デプロイ 5/5 回。
あと約 10 分待ってください (26/08/27 12:34 JST 以降に再実行可能)。
```

待ち時間は「5 番目に新しい成功デプロイ」が窓から抜ける時刻から逆算している（最も古いものではない）。

リミットに引っかかった run は `deploy` を実行していないので、**それ自体はリミットを消費しない**。
待ち時間が過ぎたら同じ run を「Re-run jobs」すればよい。

### API が読めなかった場合

run 一覧・ジョブ情報のどちらの取得に失敗したときも、**安全側に倒して失敗させる**（fail closed）。
ゲートの目的がデプロイ回数の保護である以上、履歴が読めない状態で無制限に通すわけにはいかない
ため。再実行すれば復帰する。

### 上限値を変えるには

`.github/workflows/firebase-deploy.yml` の `preflight` ジョブ内、`script:` 冒頭:

```js
const WINDOW_MINUTES = 60;
const MAX_DEPLOYS_PER_WINDOW = 5;
```

## セットアップ: `FIREBASE_SERVICE_ACCOUNT` シークレット

デプロイジョブは `secrets.FIREBASE_SERVICE_ACCOUNT`（サービスアカウントの JSON キー全文）を
使う。未設定の場合は `preflight` ジョブが数秒で明示的なエラーとともに失敗するので、テストを
走らせ切ってから気づくことはない。

### 1. サービスアカウントを作る

```bash
PROJECT_ID=teamc-2026
SA_NAME=github-actions-deployer
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="GitHub Actions deployer (firebase-deploy branch)"
```

### 2. ロールを付与する

このリポジトリの `functions/` は `onCall` / `onRequest` に加えて `onDocument`（Eventarc）、
`onSchedule`（Cloud Scheduler）、`onTaskDispatched`（Cloud Tasks）、`beforeUserCreated` /
`beforeUserSignedIn`（Auth ブロッキング関数）を使っているため、必要なロールが広い。

```bash
for ROLE in \
  roles/firebase.admin \
  roles/cloudfunctions.admin \
  roles/run.admin \
  roles/artifactregistry.admin \
  roles/cloudbuild.builds.editor \
  roles/eventarc.admin \
  roles/cloudscheduler.admin \
  roles/cloudtasks.admin \
  roles/pubsub.admin \
  roles/iam.serviceAccountUser \
  roles/serviceusage.serviceUsageAdmin \
  roles/secretmanager.admin
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE" \
    --condition=None
done
```

> **注意**: Firebase は「functions のデプロイに必要な最小ロールセット」を公式に文書化していない
> （Firebase 側もドキュメントギャップとして認識している）。上記は本リポジトリで使っている
> トリガー種別から逆算した、動作する構成であり、最小権限であることは保証しない。
> デプロイが `PERMISSION_DENIED` で落ちたら、エラーに出る権限名から必要なロールを足すこと。

`secretmanager` が要るのは、`functions/src/config/options.ts` が `defineSecret()` で 5 つの
シークレット（`BASIC_GATE_USER` / `BASIC_GATE_PASSWORD` / `REGISTRAR_ID` /
`KITAQSIGN_API_KEY` / `KITAQNIC_API_KEY`）を宣言しているためである。`firebase deploy` は
関数をデプロイする前に、宣言された各シークレットについて次を行う:

1. シークレットの存在確認（`secretmanager.secrets.get`）
2. 最新バージョンの解決（`secretmanager.versions.get` / `list`）
3. firebase 管理ラベルの付与（`secretmanager.secrets.update`）
4. **関数のランタイムサービスアカウントに `secretAccessor` を付与**
   （`secretmanager.secrets.getIamPolicy` / `setIamPolicy`）

4 の IAM 書き込みがあるため、`viewer` や `secretAccessor` では足りず `admin` が必要になる。
`roles/firebase.admin` にはこれらの権限は **含まれない**。付け忘れると deploy ジョブが

```
Error: Request to https://secretmanager.googleapis.com/v1/projects/teamc-2026/secrets/BASIC_GATE_USER
had HTTP Error: 403, Permission 'secretmanager.secrets.get' denied on resource (or it may not exist).
```

で落ちる（テストは全部通ったあと、最後のデプロイステップだけが落ちる）。プロジェクト全体では
なく 5 つのシークレット個別に絞る手もあるが、その場合はシークレットを 1 つ増やすたびに
バインディングを足さないと同じ失敗が再発する。

`serviceusage` は **Consumer ではなく Admin** である必要がある。API の有効化に必要な
`serviceusage.services.enable` は Admin 側にしかなく、Consumer が持つのは
`serviceusage.services.use` だけだからである。将来 CI が新しいトリガー種別（＝新しい API）を
初めてデプロイするときに効いてくる。手元で必ず API を有効化してから CI に渡す運用にするなら
Consumer でも足りるが、その前提を忘れると原因の分かりにくい失敗になる。

### 3. JSON キーを発行して GitHub Secret に入れる

```bash
gcloud iam service-accounts keys create /tmp/firebase-deployer.json \
  --iam-account="$SA_EMAIL" \
  --project="$PROJECT_ID"

gh secret set FIREBASE_SERVICE_ACCOUNT \
  --repo gotorius/GMOIntenetIC_TeamC \
  < /tmp/firebase-deployer.json

shred -u /tmp/firebase-deployer.json 2>/dev/null || rm -P /tmp/firebase-deployer.json
```

ローカルに鍵を残さないこと。ワークフロー側では `$RUNNER_TEMP` に `chmod 600` で書き出し、
`if: always()` のステップで必ず削除している。

> **fork からの PR について**: CD は `pull_request`（`pull_request_target` ではない）で起動する
> ため、fork 発の PR にはシークレットが渡らない。仮に fork PR がマージされた場合、`preflight`
> がシークレット未設定として失敗し、デプロイは起きない（リミットも消費しない）。安全側の挙動
> だが、原因が分かりにくいのでここに記しておく。

> 組織ポリシー `iam.disableServiceAccountKeyCreation` が有効だとキーを発行できない。その場合は
> Workload Identity Federation への切り替えが必要（GCP 課金はどちらも $0）。

## 初回デプロイだけは手元から手動で行う

**このパイプラインを使う前に、1 回だけ開発者の手元から `firebase deploy` を実行すること。**
2 回目以降はすべて CI 経由でよい。

理由は主に Artifact Registry のクリーンアップポリシーである。firebase-tools 14.0 以降は
関数デプロイのたびにポリシーの有無を確認し、未設定なら対話プロンプトを出す。CI では答えられ
ないため、次のようになる:

```
No cleanup policy detected for repositories in asia-northeast2.
Error: Functions successfully deployed but could not set up cleanup policy in
location asia-northeast2. Pass the --force option to automatically set up a
cleanup policy or run 'firebase functions:artifacts:setpolicy' ...
```

**関数のデプロイ自体は成功した直後に exit code 1 で落ちる。** つまり初回の CI 実行は、実際には
デプロイできているのにジョブが赤くなる。しかもポリシーを設定する対象の `gcf-artifacts`
リポジトリは初回デプロイで初めて作られるため、事前に設定しておくこともできない。

`--force` を渡せば既定ポリシーを自動で受け入れるが、**`--force` は「ソースから消えた関数の
自動削除」も同時に有効にする**。そちらは意図的に無効にしてあるので、この方法は採らない。

手動で通しておくと、あわせて次も手元で片付く:

- 各種 API（Cloud Functions / Cloud Build / Artifact Registry / Eventarc / Cloud Run /
  Cloud Scheduler / Cloud Tasks）の初回有効化
- API 有効化直後にサービスエージェントの生成が間に合わず初回だけ失敗する事象（再実行で通る）
- ブロッキング関数（`beforeUserCreated` / `beforeUserSignedIn`）まわりの Identity Platform の状態

### 手順

```bash
# 開発者自身の権限で（サービスアカウントではなく）
firebase login
firebase deploy --only functions,firestore --project teamc-2026
```

途中でクリーンアップポリシーを尋ねられるので、**保持期間 1 日（既定）** を選ぶ。
プロンプトを取りこぼした場合や後から変えたい場合は:

```bash
firebase functions:artifacts:setpolicy --days 1 --location asia-northeast2 --project teamc-2026
```

設定後、Artifact Registry コンソールで `gcf-artifacts` のポリシーが **Dry run ではなく
Delete** になっていることを確認する（firebase-tools 14.1.0 系で Dry run のまま設定される不具合が
報告されていた。本パイプラインが固定している 15.28.1 では解消済みの想定だが、課金に直結する
ので目視すること）。

デプロイ済みの関数は Cloud Run 側がイメージを保持しているため、Artifact Registry から古い
イメージが消えても動作には影響しない。

### レートリミットとの関係

「デプロイは成功したが exit 1」の状態では `deploy` ジョブが `failure` になるため、**実際に
デプロイされたのにリミットを消費しない**。過剰カウントしない側に倒れてはいるが、ポリシー未設定
のまま放置すると事実上リミットが機能しなくなる。初回に必ず片付けること。

## 運用フロー

デプロイしたい内容を載せたブランチを作り、`firebase-deploy` を **base** にした PR を出して
マージする。直接 push しても何も起きない。

```bash
# デプロイしたい内容が main 等で CI 済みであることを確認してから
git fetch origin
git switch -c release/$(date +%Y%m%d-%H%M) origin/firebase-deploy
git merge --no-ff origin/main          # あるいは対象のコミットを取り込む
git push -u origin HEAD

gh pr create --base firebase-deploy --fill
# PR が開いている間に firebase-auth-ci.yml が走るので、緑を確認してから
gh pr merge --merge          # → マージされた瞬間に CD が起動する
```

PR をマージせずにクローズした場合、CD は起動せずリミットも消費しない。

### ブランチ保護の推奨設定

「PR 経由のみ」をワークフロー側だけでなく Git 側でも担保するなら、`firebase-deploy` に
ブランチ保護を掛けて直接 push を禁止しておくとよい（ワークフローは直接 push で CD を
起動しないが、ブランチの中身だけが黙って進む状態は防げないため）。

## コストに関する注意

このリポジトリは **private** なので、GitHub Actions の実行時間は無料枠（Free プランで 2,000 分/月）
を消費する。`firebase-auth-ci.yml` はエミュレータ込みで 4 ジョブ走るため、1 デプロイあたりの
消費が大きい。レートリミットはこの分数の保護も兼ねている。

なお、`firebase-deploy` 宛の PR ではテストスイートが **2 回**走る（PR が開いている間に 1 回、
マージ後の CD 内で 1 回）。前者はマージ前のゲート、後者はマージ結果そのものに対するゲートで
役割が異なるが、分数を節約したい場合は `firebase-auth-ci.yml` の `pull_request` トリガーに
`branches-ignore: [firebase-deploy]` を足して前者を落とせる。その場合、マージ前に緑を確認する
手段は失われる。

Firebase 側の実費:

| 項目 | 無料枠 | 超過後 |
|---|---|---|
| Cloud Build（Gen2 関数のビルド） | 2,500 build-分/月 (e2-standard-2) | $0.006/分 |
| Artifact Registry（関数イメージ） | 請求先アカウント全体で 0.5 GB | $0.10/GB/月 |
| Firestore rules / indexes デプロイ | 無料 | — |

Artifact Registry はデプロイの度にイメージが積み上がり、削除するまで課金され続ける。これは
[初回デプロイ](#初回デプロイだけは手元から手動で行う)で `gcf-artifacts` に保持期間 1 日の
クリーンアップポリシーを設定することで抑える。

## firebase-tools のバージョン

| ワークフロー | 指定 | 理由 |
|---|---|---|
| `firebase-deploy.yml`（デプロイ） | `firebase-tools@15.28.1` に**固定** | デプロイする側なので、CLI の新リリースでプロンプトの挙動・クリーンアップポリシーの扱い・イメージのライフサイクルが勝手に変わるのを防ぐ |
| `firebase-auth-ci.yml`（テスト） | `@latest` | エミュレータ側の変化を早めに検知したいため |

固定バージョンを上げるときは意識的に行い、上げた直後のデプロイは結果を確認すること。
