# Agar Canvas

HTML5 Canvas で動く Agar.io 風のブラウザゲームです。`index.html` を GitHub Pages に置くだけで、シングルプレイと部屋名を使った 2P 接続を試せます。

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

## 友達と遊ぶ

1. 2人とも GitHub Pages の公開URLを開きます。
2. 同じ `room` 名を入力します。例: `daiki`
3. 片方が `CREATE ROOM` を押します。
4. もう片方が `JOIN ROOM` を押します。
5. `ONLINE 2P` が `CONNECTED` になったら開始です。

`CREATE ROOM` / `JOIN ROOM` は PeerJS Cloud を使って WebRTC 接続を作ります。混雑や学校・会社・携帯回線の制限でつながらない場合があります。その場合は別回線で試すか、下のリレーサーバー方式を使ってください。

## リレーサーバーについて

GitHub Pages は静的ホスティングなので、`server.js` の WebSocket リレーは GitHub Pages 上では動きません。

- `CREATE ROOM` / `JOIN ROOM`: 公開シグナリングを使って、部屋名だけで接続します。
- `ANSWER`: 手動シグナリング用の予備ボタンです。
- `RELAY HOST` / `RELAY JOIN`: `server.js` を別の Node.js 実行環境にデプロイし、その WebSocket URL を入力して使います。

GitHub Pages だけで公開する場合も、通常のゲーム本体は `index.html` だけで動作します。
