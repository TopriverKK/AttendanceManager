# 勤怠ダッシュボード (React + Vite + TypeScript)

小規模チーム向けのローカル勤怠ダッシュボードです。ブラウザ保存のみで動作し、Freee連携用CSV(暫定列)を出力できます。

## 最新の改善（2024年12月）

### 通信安定性の向上
以前のバージョンでは502 Bad Gateway、CORS、404エラーが頻発し、従業員カレンダーデータが取得できない問題がありました。以下の改善により通信の安定性が大幅に向上しています：

**API側の改善 ([api/ics.js](api/ics.js))**
- ? **タイムアウト設定**: 10秒タイムアウトを設定し、レスポンス待ちの無限ハングを防止
- ? **リトライロジック**: 指数バックオフ（500ms → 1s → 2s）で最大3回リトライ
- ? **インテリジェントなリトライ**: 5xxエラーや429エラーのみリトライ、4xxエラーは即座に失敗
- ? **キャッシュヘッダー**: 成功時に5分間のキャッシュを設定し、負荷を軽減

**クライアント側の改善 ([src/App.tsx](src/App.tsx))**
- ? **並列処理**: 従業員カレンダーを順次ではなく並列でフェッチし、処理時間を短縮
- ? **インメモリキャッシュ**: 5分間のキャッシュで不要なAPIコールを削減
- ? **タイムアウト付きフェッチ**: クライアント側でも10秒タイムアウトを設定
- ? **詳細なエラーログ**: どの候補URLで失敗したかを明確に記録
- ? **祝日データのスマートキャッシング**: 24時間キャッシュ、失敗時は古いキャッシュを使用

**将来のSupabase統合への準備**
- ? [SUPABASE_MIGRATION.md](SUPABASE_MIGRATION.md) に移行計画を文書化
- キャッシング機構がSupabaseのキャッシュテーブルに置き換え可能な設計
- データベーススキーマ、Edge Functions、移行手順を詳細に記載

## セットアップ

```bash
npm install
npm run dev
```

## 主な機能
- ダッシュボードで社員ごとの出勤状況を表示（出勤/休憩/外出/退勤/未打刻）
- 勤務場所フラグ: オフィス / テレワーク / 外出
- 出勤・退勤・休憩・外出の操作ボタン
- 本日の勤務時間集計、全体サマリ
- Google公開ICS(祝日カレンダー等)読込に対応
- 個人ICSを登録して「次の予定」を表示（1分間隔で再取得）
- クラウドストレージ (`/api/state`) で複数タブ・端末間の更新を反映
- 月単位での一覧閲覧・CSV出力（年月を選択）
- freee勤怠取り込み用の「集計形式」CSVを出力（サンプルCSVの列に合わせた形式）

## 月次の閲覧・CSV出力
画面上部の「月次出力/閲覧」から、年月を選択して一覧を確認し、必要に応じてCSVをダウンロードします。

## CSV仕様について
このアプリのCSVは freee が提供している「勤怠取り込み用（集計）」サンプルCSVの列に合わせて出力します。

freee側で取り込みできるよう、従業員管理で以下を設定してください。
- 従業員番号

集計の前提（現時点の仕様）
- 所定: 9:00-18:00 固定
- 休憩: 1時間30分 固定（freee集計CSVはこの前提で計算）
- 欠勤/遅刻/早退/法定内残業など、アプリで未算出の列は空欄で出力します

## 留意事項
- データ保存はクラウドストレージ (`/api/state`) を使用します。VercelにVercel Blobを設定する必要があります。
- 日付跨ぎや丸め処理は実装していません。
- freee形式CSVの「所定労働日数/所定労働時間」は、平日・祝日に加えて「会社の所定休日ICS（任意）」も考慮して計算します。
- 休日はICSのDTSTARTを読み取り、当日が休日ならバッジを表示します。
- 休憩・外出は1回ずつの簡易運用を想定しています。

## スクリプト
- `npm run dev` 開発サーバー
- `npm run build` ビルド
- `npm run preview` ビルド後プレビュー

## 公開（PaaS）
このアプリはViteの静的ビルド（`dist/`）なので、静的サイトをホストできるPaaSで公開できます。

### 事前確認
```bash
npm install
npm run build
```

### Vercel（推奨）
1. GitHubにこのリポジトリをPush
2. Vercelで「New Project」→該当リポジトリをImport
3. 設定（自動検出されることが多いです）
	- Build Command: `npm run build`
	- Output Directory: `dist`
4. Deploy

※ SPAとしてのフォールバック用に `vercel.json` を同梱しています。

## クラウドストレージ（Vercel Blob）の設定
このアプリは Vercel Blob を使用して状態を保存し、複数のタブ・端末間で同期します。

### Vercelでの設定手順
1. **Vercel Dashboard にログイン** → 対象プロジェクトを選択
2. **Storage タブ** → **Create Database** → **Blob** を選択
3. **Connect** をクリックして、プロジェクトにBlobストレージを接続
4. 環境変数が自動的に設定されます（`BLOB_READ_WRITE_TOKEN` など）
5. **Redeploy** → **Trigger Deployment** で再デプロイを実行

### トラブルシューティング
もし `403 Forbidden` エラーが出る場合:
1. Vercel Dashboard → プロジェクト → **Settings** → **Environment Variables** で `BLOB_READ_WRITE_TOKEN` が設定されているか確認
2. 設定されていない場合、Storage タブで Blob を再接続
3. 必ず **Redeploy** を実行（環境変数の変更は再デプロイが必要）

### 動作
- 共有状態の取得: `GET /api/state`
- 共有状態の保存: `POST /api/state`

## ICS取得（CORS対策）
祝日ICS/個人ICSはブラウザのCORS制限を避けるため、同一オリジンのプロキシ経由で取得します。

- 取得: `GET /api/ics?url=...`
- セキュリティのため、`https` のみ + Google Calendar系ホストのみ許可しています（必要なら [api/ics.js](api/ics.js) の許可リストを拡張してください）。
- **安定性向上**: タイムアウト（10秒）、リトライロジック（最大3回）、キャッシュ（5分）を実装済み

※ 現状は「全員で1つの共有状態」を保存するMVPです。ログイン/権限分離が必要なら追加実装が必要です。

## トラブルシューティング

### カレンダーデータが取得できない場合
1. **ブラウザの開発者ツールでエラーを確認**
   - 502エラー: Google Calendarが応答していない可能性 → 数分後に再試行
   - CORSエラー: プロキシ経由でアクセスしているか確認
   - 404エラー: カレンダーURLが正しいか確認

2. **キャッシュをクリアして再試行**
   - ブラウザをリロード（Ctrl+F5 / Cmd+Shift+R）
   - 5分待ってキャッシュの有効期限が切れるのを待つ

3. **カレンダーURLの確認**
   - Google Calendarの公開設定が有効になっているか
   - ICS URLが正しい形式か（例: `https://calendar.google.com/calendar/ical/.../public/basic.ics`）

### 改善前後の違い
- **改善前**: 502エラーで全従業員が未設定になる、繰り返しリトライして負荷が高い
- **改善後**: タイムアウトとリトライで安定性向上、キャッシュで負荷軽減、並列処理で高速化

### Netlify
1. GitHubにこのリポジトリをPush
2. Netlifyで「Add new site」→「Import an existing project」
3. 設定
	- Build command: `npm run build`
	- Publish directory: `dist`
4. Deploy

※ SPAとしてのフォールバック用に `netlify.toml` を同梱しています。

### Render（Static Site）
1. GitHubにこのリポジトリをPush
2. Renderで「New」→「Static Site」
3. 設定
	- Build Command: `npm run build`
	- Publish Directory: `dist`
4. Create Static Site

## ローカル起動（Windowsの注意）
PowerShellの実行ポリシーにより `npm.ps1` がブロックされる環境があります。
その場合は「コマンドプロンプト(cmd)」で `npm install` / `npm run dev` / `npm run build` を実行してください。

## GitHubにPushできない場合
この環境で `git` コマンドが使えない場合は、以下のいずれかでPushしてください。
- Git for Windows をインストールして `git` を使う
- GitHub Desktop を使ってこのフォルダをリポジトリとして公開（Publish）する
