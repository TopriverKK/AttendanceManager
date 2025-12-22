# 勤怠ダッシュボード (React + Vite + TypeScript)

小規模チーム向けのローカル勤怠ダッシュボードです。ブラウザ保存のみで動作し、Freee連携用CSV(暫定列)を出力できます。

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
- LocalStorage + `/api/state`（Vercel Blob）で複数タブ・端末間の更新を反映
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
- データ保存は主にLocalStorageです。日付跨ぎや丸め処理は実装していません。
- 端末間で共通の状態を保存したい場合は、Vercelにデプロイして Vercel Blob を設定してください（後述）。
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

## 共有ストレージ（Vercel Blob）
デフォルトではブラウザのLocalStorageに保存されますが、Vercel Blob を設定すると全端末で共通の状態を保存できます。

### Vercelでの設定
1. Vercel Dashboard → 対象プロジェクト → Storage → Blob を作成
2. 対象プロジェクトの Environment Variables に `BLOB_READ_WRITE_TOKEN` を設定
3. Redeploy（再デプロイ）

### 動作
- 共有状態の取得: `GET /api/state`
- 共有状態の保存: `POST /api/state`

※ 現状は「全員で1つの共有状態」を保存するMVPです。ログイン/権限分離が必要なら追加実装が必要です。

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
