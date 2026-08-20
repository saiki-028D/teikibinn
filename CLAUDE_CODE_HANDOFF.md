# 配送管理アプリ Supabase移行 — Claude Code 引き継ぎ用コンテキスト

このドキュメントをClaude Codeに渡して作業を再開してください（例: `claude "このファイルの内容に従って作業して: CLAUDE_CODE_HANDOFF.md"`、またはこの内容をそのままプロンプトに貼り付け）。

## 背景・目的

社内の車両・配送管理アプリ（5人/5台程度で利用）を改善するプロジェクト。

- リポジトリ: `saiki-028D/teikibinn`（GitHub）、Vercelで静的ホスティング
- 現状（mainブランチ）: 単一HTMLファイル（`index.html`）+ Google Apps Script（GAS）+ Googleスプレッドシートの構成
- 課題: 書き込みのたびに5シート全件をGAS経由で再取得しており速度が遅い。「定期便マスタ」と「日次の確定/スポット便」が同じ`routes`シートに、note列の日付有無だけで区別されて混在保存されており複雑・わかりにくい。カレンダーが日別クリックでしか実績を確認できない。

## 決定済みの方針（変更しないでください）

- バックエンドをGAS+スプレッドシートから **Supabase（Postgres）** に移行し、入力はアプリ内で完結させる。
- デプロイ形態は維持：単一HTMLファイル＋Vercel静的ホスティングのまま（ビルド工程は導入しない）。`@supabase/supabase-js`をCDN読み込みしてブラウザから直接Supabaseと通信する。
- 認証：社内共有の1アカウント（Supabase Auth email/password）でログイン。個別アカウントにはしない。
- 写真保存：引き続きCloudinary（`CLOUDINARY_CLOUD`/`CLOUDINARY_PRESET`は変更不要）。

## 現在の成果物

前段のセッション（Cowork）で以下のファイル一式を作成し、ユーザーに送付済みです。ユーザーのダウンロードフォルダにあるはずなので、リポジトリのルートに配置してください。

- `index.html` — アプリ本体（差し替え）
- `app.js` — アプリのロジック（新規）
- `config.js` — Supabase接続情報（`SUPABASE_URL`/`SUPABASE_ANON_KEY`がプレースホルダーのまま。要設定）
- `schema.sql` — Supabaseテーブル定義一式（未実行）
- `migrate.js` — 既存スプレッドシートCSVからのデータ移行スクリプト（外部npm依存なし）
- `README.md` — セットアップ手順書（リポジトリに置くときは`SUPABASE_SETUP.md`などにリネーム推奨。既存のREADMEと衝突しないように）

### データモデル（schema.sql の要点）

- `vehicles` / `drivers` / `companies`（旧"routes"シートのマスタ行相当）/ `dispatch_days`（日次の例外のみを保持：定期パターンに一致する通常運行はテーブルに行を作らずアプリ側で毎回計算。`status`='go'/'skip'、`has_delivery`/`has_pickup`/`note`(メモ)列あり）/ `checks`（月次点検、26項目を1車両×1年月=1行のJSONBにまとめて保存）/ `delivery_records`（配送実績）。
- RLSは「ログイン済みユーザーなら全テーブル読み書き可」のシンプル設定。Realtime配信も有効化済み。

### GASの実コードは確認済み

ユーザーから実際のApps Scriptコード（doGet/doPost/saveDelivery/upsertRow/saveCheck）を確認済みで、`migrate.js`の列構成の想定が正しいことを検証済みです（delivery_recordsは`id,companyName,date,nouhinMemo,hikitoriMemo,nouhinPhotoUrls,hikitoriPhotoUrls,savedAt`、写真URLはカンマ区切り文字列。checksは1項目=1行）。追加確認は不要です。

### UI改善のマージ（重要な経緯）

ユーザーが別途、GASコードとは別にSupabaseへ直接つなぐ発展版のHTMLコードを独自に用意していました。これには良いUI改善（便追加モーダルの複数日付選択・納品/引取種別トグル・メモ、写真のカメラ/ギャラリー分離ボタン、カレンダー日付詳細の車両グループ表示、マスタ編集の楽観的UI更新）がある一方、**認証が一切なくSupabaseのanonキーが埋め込まれ誰でも読み書きできる状態**で、テーブル構成も旧スプレッドシート時代のままでした。ユーザーの判断で「こちらの新スキーマ版（認証あり・companies/dispatch_days分離）をベースに、良いUI改善だけ取り込む」方針となり、上記の成果物一式には**すでにこの改善が反映済み**です。再度取り込む必要はありません。

## 未着手・次にやること

1. **リポジトリへの反映**：Cowork環境からはGitHubへの書き込みがプラットフォーム制限でブロックされ、プッシュできませんでした。ローカルのClaude Codeなら`gh`/`git`で普通にプッシュできるはずです。
   - 新しいブランチ（例: `supabase-migration`）を作成し、上記6ファイルをコミット・プッシュしてPRを作成してください。
   - **mainに直接マージしないでください。** `config.js`が未設定のままマージするとVercelが自動デプロイし、5人が使っている本番サイトが壊れます。Supabase設定完了・動作確認後にユーザーの判断でマージしてもらってください。

2. **Supabaseプロジェクトのセットアップ**：
   - ユーザーがすでにSupabaseプロジェクトを作成している可能性があります（別途見せてもらった発展版コードに実際の接続情報が含まれていました。プロジェクトref: `nbwkvojuzwblzdmzzaaq`、Project URL: `https://nbwkvojuzwblzdmzzaaq.supabase.co`）。まずこれが今回使うプロジェクトか確認してください。
   - `schema.sql`をSupabaseのSQL Editorで実行（または権限があればAPI経由で実行）。
   - Authentication → Users で共有ログイン用アカウントを1つ作成。
   - `config.js`の`SUPABASE_URL`/`SUPABASE_ANON_KEY`を実際の値に更新。
   - Cowork環境ではSupabase MCPコネクタの認証はできたものの、ユーザーが複数のClaudeアカウントを持っており「チャットで有効化」の操作で混乱していました。Claude Codeでは別の連携方法（CLIログイン、個人アクセストークンなど）が使える可能性があるので、ユーザーと相談して進めてください。

3. **動作確認**：ログイン→各タブの表示→本日の運行計画の保存→便追加モーダル→配送実績の記録（写真アップロード含む）→月次点検の保存、が一通り動くか確認。

4. **（任意）既存データ移行**：ユーザーが希望すれば、既存スプレッドシートを各タブCSVエクスポートしてもらい、`migrate.js --dry-run`→本実行でSupabaseに投入。

## ユーザーについて

- 技術に詳しくない可能性があるので、専門用語は避けて丁寧に。GitHubアカウントの多重ログインで混乱した経緯があるので、認証まわりの手順は特に慎重かつ具体的に案内してください。
