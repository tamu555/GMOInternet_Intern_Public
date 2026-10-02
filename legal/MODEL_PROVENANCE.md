# Model Provenance

Per docs/仕様/browser-ai.md §19.2. Values below were verified directly from
the installed `@mlc-ai/web-llm` package (version 0.2.84) by running:

```sh
cd frontend && node -e "const w=require('@mlc-ai/web-llm');const r=w.prebuiltAppConfig.model_list.find(m=>m.model_id==='Qwen3-0.6B-q4f16_1-MLC');console.log(JSON.stringify(r,null,2), w.modelVersion)"
```

(and the same query with `model_id==='Qwen3.5-0.8B-q4f16_1-MLC'` for the
future-candidate row). 取得日: **2026-08-26**.

## Qwen3-0.6B-q4f16_1-MLC (v1 first candidate, docs/仕様/browser-ai.md §5.1)

| フィールド | 値 |
|---|---|
| `model_id` | `Qwen3-0.6B-q4f16_1-MLC` |
| `model`（取得元 URL） | `https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC` |
| `model_lib`（WASM URL） | `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm` |
| `vram_required_MB` | `1403.34`（実行時 GPU メモリ要件。ダウンロード量ではない） |
| `low_resource_required` | `true` |
| `overrides` | `{ "context_window_size": 4096 }` |
| `modelVersion`（`@mlc-ai/web-llm` パッケージ全体の値） | `v0_2_84/base` |

取得元 (upstream) モデルカード: `https://huggingface.co/Qwen/Qwen3-0.6B`。
上記の `model` URL は WebLLM 向けに事前量子化・変換された配布先
（`mlc-ai/Qwen3-0.6B-q4f16_1-MLC`）であり、実際のダウンロードはここから行う
（docs/仕様/browser-ai.md §18.1）。

### ダウンロードサイズ

**335.2 MiB（重みファイル一式）+ 5.3 MiB（WASM）≈ 357,000,000 バイト**
（✅ 実測、2026-08-26、Hugging Face API `tree/main` および `binary-mlc-llm-libs`
リポジトリで確認。docs/仕様/browser-ai.md §5.1）。

この数値は `frontend/src/features/assistant/config/assistantConfig.ts` の
`ASSISTANT_CONFIG.model.downloadBytes`（現状 `357_000_000`）と**常に同期させる
こと**。本ファイルはそのフィールドを直接編集しない（`features/assistant/` は
他ワークストリームの管轄、docs/仕様/browser-ai.md §14.2）。この値が変わる場合
（モデル更新・量子化方式変更等）は、`downloadBytes` と本ファイルの両方を同じ
コミットで更新する。

## Qwen3.5-0.8B-q4f16_1-MLC (将来候補, docs/仕様/browser-ai.md §5.2)

v1 では採用しない。継続評価対象として、同一手順で検証した値を以下に記録する。

| フィールド | 値 |
|---|---|
| `model_id` | `Qwen3.5-0.8B-q4f16_1-MLC` |
| `model`（取得元 URL） | `https://huggingface.co/mlc-ai/Qwen3.5-0.8B-q4f16_1-MLC` |
| `model_lib`（WASM URL） | `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm` |
| `vram_required_MB` | `1629.49` |
| `low_resource_required` | `true` |
| `overrides` | `{ "context_window_size": 4096, "max_history_size": 1 }` |
| `modelVersion` | `v0_2_84/base` |

取得元モデルカード: `https://huggingface.co/Qwen/Qwen3.5-0.8B`。ダウンロード量
（実測、docs/仕様/browser-ai.md §5.2）: **426.5 MiB（重み）+ 5.9 MiB（WASM）**。
採用可否は日本語評価セット（docs/仕様/browser-ai.md §21.3）の結果で判断する。

## ライセンス

Qwen3-0.6B・Qwen3.5-0.8B とも Apache License 2.0
（docs/仕様/browser-ai.md §19.1）。全文は `legal/QWEN_LICENSE.txt` を参照。
