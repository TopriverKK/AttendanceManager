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
- LocalStorage同期（storageイベント + 1分ごとの再読込）で複数タブ・端末間の更新を反映
- 月単位での一覧閲覧・CSV出力（年月を選択）
- Freee勤怠インポートを想定したCSVを暫定出力（社員番号, 日付, 出勤時刻, 退勤時刻, 休憩開始, 休憩終了, 勤務場所, メモ）

## 月次の閲覧・CSV出力
画面上部の「月次出力/閲覧」から、年月を選択して一覧を確認し、必要に応じてCSVをダウンロードします。

## CSV仕様について
添付のCSVは従業員一括インポート用で打刻フォーマットとは異なるため、公式の勤怠インポート仕様に合わせて列を調整してください（現状は暫定列）。

## 留意事項
- データ保存はLocalStorageのみ。日付跨ぎや丸め処理は実装していません。
- LocalStorage同期は擬似的なため、端末間で常に最新を保証するにはバックエンドが必要です。
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
