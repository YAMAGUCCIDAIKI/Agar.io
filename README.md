# Agar Canvas

HTML5 Canvas の Agar.io 風ブラウザゲームです。

## ローカル起動

```bash
npm start
```

または:

```bash
node server.js
```

起動後、ブラウザで `http://localhost:8080` を開きます。オンラインは同じ部屋名で `オンライン参加` を押します。

## GitHub Pages でオンライン参加する場合

GitHub Pages は静的ホスティングなので、WebSocket サーバーは Pages 上では動きません。

このリポジトリは `main` ブランチへ push すると、GitHub Actions で GitHub Pages へ自動反映されます。手動で起動する必要があるのは `server.js` の Node.js リレーサーバーだけです。

オンライン参加には、このリポジトリの `server.js` を自分のPC、Render、Fly.io、Railway、VPS など Node.js が起動できる場所で動かし、発行された WebSocket URL をゲーム画面のリレーURL欄へ入力します。

例:

```text
wss://your-agar-relay.example.com/ws
```

URL パラメータでも指定できます。

```text
https://yourname.github.io/Agar.io/?relay=wss://your-agar-relay.example.com/ws
```

一度入力したリレーURLと部屋名はブラウザに保存されます。

## サーバー仕様

- `server.js` は `/` で `index.html` を配信します。
- `/ws` で WebSocket リレーを受け付けます。
- 部屋ごとに参加者へ `p1`, `p2`, `p3`... のIDを割り当てます。
- 人数上限は設けていません。
- 現在のホストが閉じた、または停止した場合は、残っている参加者が自動的にホストへ昇格します。
