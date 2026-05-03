# Agar Canvas

HTML5 Canvas だけで動く Agar.io 風のブラウザゲームです。`index.html` を GitHub Pages に置くだけで、シングルプレイと手動シグナリングによる 2P 接続を試せます。

## ローカルで確認

静的表示だけなら `index.html` をブラウザで開けます。

リレーサーバーも使って確認する場合は Node.js で起動します。

```bash
node server.js
```

起動後、ブラウザで `http://localhost:8080` を開きます。

## GitHub Pages で公開

1. このフォルダの内容を GitHub リポジトリへ push します。
2. GitHub のリポジトリ画面で `Settings` -> `Pages` を開きます。
3. `Build and deployment` の `Source` を `GitHub Actions` にします。
4. `main` ブランチへ push すると、`.github/workflows/pages.yml` が自動で公開します。

公開URLは Actions の `Deploy to GitHub Pages` 実行結果、または `Settings` -> `Pages` に表示されます。

## オンライン機能について

GitHub Pages は静的ホスティングなので、`server.js` の WebSocket リレーは GitHub Pages 上では動きません。

- `HOST` / `JOIN` / `ANSWER`: 画面の Offer / Answer を相手と手動で受け渡して接続します。
- `RELAY HOST` / `RELAY JOIN`: `server.js` を別の Node.js 実行環境にデプロイし、その WebSocket URL を入力して使います。

GitHub Pages だけで公開する場合も、通常のゲーム本体は `index.html` だけで動作します。
