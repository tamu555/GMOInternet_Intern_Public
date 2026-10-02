# Firebase Local Emulator Suite 実行用イメージ
#
# 注意: Firebase / Google が公式配布している Docker イメージは存在しない
# （firebase-tools は npm パッケージとしてのみ公式配布されている）。
# このイメージは Node.js 公式イメージ + OpenJDK（Firestore / Realtime Database
# エミュレータの実行に Java ランタイムが必要） + firebase-tools という、
# コミュニティで広く使われている構成に倣って作成している。
#
# 参照: docs/firebase/README.md 「6. Docker でのエミュレータ運用」

FROM node:20-trixie-slim

# Firestore / Realtime Database エミュレータ（Java 製）の実行に必要な JDK と、
# ヘルスチェック等で使う curl を導入する
# firebase-tools（本書作成時点の最新版）は Java 21 未満を拒否するため、
# Debian bookworm 系（Java 17 まで）ではなく trixie 系（Java 21 が入る）を使う。
# 実機（macOS, docker compose up）で openjdk-17-jdk-headless では
# 「firebase-tools no longer supports Java version before 21」で起動失敗することを確認済み。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openjdk-21-jdk-headless \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Firebase CLI をグローバルインストール
# バージョンを固定したい場合はビルド引数で上書きできるようにしておく
ARG FIREBASE_TOOLS_VERSION=latest
RUN npm install -g firebase-tools@${FIREBASE_TOOLS_VERSION}

WORKDIR /workspace

# Firebase Local Emulator Suite の各サービスのデフォルトポート
# （docs/firebase/README.md 5.2 のポート一覧表と対応）
#   4000 Emulator UI
#   5000 Hosting
#   5001 Cloud Functions
#   8080 Firestore
#   8085 Pub/Sub
#   9000 Realtime Database
#   9099 Authentication
#   9199 Cloud Storage
#   9299 Eventarc
EXPOSE 4000 5000 5001 8080 8085 9000 9099 9199 9299

# 注意: エミュレータデータの永続化先（/workspace/emulator-data）は
# docker-compose.yml 側で名前付きボリュームとしてマウントするため、
# ここでは VOLUME 宣言を重ねない。

# リポジトリルート（firebase.json のある場所）を /workspace にマウントした状態で
# 起動する想定。--project は docker-compose.yml 側の command で上書きする。
#
# 重要: コンテナ内のエミュレータはデフォルトで 127.0.0.1 にしか bind しないため、
# ホスト（docker-compose.yml の ports で公開したポート）から接続できるように
# firebase.json の emulators.<service>.host を "0.0.0.0" に設定すること。
# 詳細は docs/firebase/README.md 「6.3 コンテナ外からアクセスする場合の注意」を参照。
#
# 重要: firebase.json の functions.predeploy（lint/build）は `firebase deploy`
# 実行時にしか走らず、`emulators:start` では一切実行されない。このコンテナは
# 長時間起動しっぱなしで使う開発用コンテナなので、ビルドを挟まず
# `emulators:start` だけを CMD にすると、`functions/src` や Secret Manager の
# シークレット名を変更してもコンテナを再起動しただけでは古い `functions/lib/`
# を読み続けてしまう（実例: シークレット名統合コミットの反映漏れで
# `Unable to access secret environment variables` が再起動後も解消しなかった）。
# そのため起動コマンド自体に毎回のビルドを組み込み、`docker restart` /
# `docker compose restart` だけで常に最新の `functions/src` から作り直した
# 状態で `emulators:start` するようにする。
CMD ["sh", "-c", "npm --prefix functions run build && firebase emulators:start --import=/workspace/emulator-data --export-on-exit=/workspace/emulator-data"]
