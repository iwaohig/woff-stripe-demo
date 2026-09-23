# woff-stripe-demo

LINE WORKS の WOFF アプリで、Stripe の決済を使って有料コンテンツを販売するデモです。
購入した利用者にだけ、コンテンツの本文を表示します。

- WOFF アプリの中で Stripe の決済フォームを表示し、支払いまで完了できる
- 購入者は WOFF のアクセストークンでサーバー側で特定する (クライアントから送られた ID は信用しない)
- 購入の確定は Stripe に問い合わせて行い、webhook でも記録する
- Cloudflare Workers (静的ファイル + Worker + KV) だけで動く。依存パッケージなし

> **Stripe はテストモード専用のデモです。** 本番の決済に使う場合は、商品・価格の管理、
> 返金、特定商取引法に基づく表記などを別途検討してください。

## WOFF で使う決済方式について

Stripe Checkout には、Stripe のページに移動する **Hosted Checkout** と、自分のページに埋め込む
**Embedded Checkout** があります。**WOFF のアプリ内ブラウザでは、Hosted Checkout に移動すると
"This link is incomplete" と表示されて開けませんでした** (Android・iOS で確認)。
Checkout の URL は `#` 以降が必須で、移動の途中でこれが落ちていると考えられます。

このデモは **Embedded Checkout (`ui_mode=embedded_page`)** を使っています。
比較のため、画面の「決済方式を切り替える」で Hosted Checkout も試せます。

確認した環境と結果は [docs/verification.md](docs/verification.md) にまとめています。

## 仕組み

```
WOFF (ブラウザ)                    Worker (Cloudflare)                 Stripe / LINE WORKS
─────────────────                  ───────────────────                 ───────────────────
woff.init()
GET /api/products  ──token──▶      GET users/me で利用者を特定  ──────▶ LINE WORKS API
「購入」
POST /api/checkout ──token──▶      Checkout Session を作成     ──────▶ Stripe
決済フォームを埋め込んで表示 ◀──── client_secret
支払い
return_url (WOFF URL) で開き直す
POST /api/confirm  ──token──▶      Session を取得し、支払い済み  ──────▶ Stripe
                                   かつ購入者が本人なら KV に記録
                                   POST /api/webhook  ◀──────────────── checkout.session.completed
                                   (署名を検証して KV に記録)
GET /api/content/:id ──token──▶    KV に記録があれば本文を返す
```

- 戻ってきた URL の `session_id` だけでは本文を解放しません。必ず Worker が Stripe に問い合わせ、
  支払い済みであることと、Session の metadata の利用者が今の利用者と一致することを確かめます
- webhook は、支払い後に画面を閉じてしまった場合の保険です。confirm と webhook のどちらで記録されても結果は同じです
- 戻り先の WOFF URL は Worker の設定 (`WOFF_ID`) から組み立てます。クライアントから受け取らないので、
  任意の URL に飛ばされることはありません
- アクセストークンや URL の `#` 以降 (トークンが含まれる) は、画面にもログにも出しません

### エンドポイント

| エンドポイント | 内容 |
|---|---|
| `GET /api/products` | 商品一覧 (本文を含まない。購入済みフラグ付き) |
| `POST /api/checkout` | Checkout Session を作成 |
| `POST /api/confirm` | 戻ってきたときに Session を確認して購入を記録 |
| `GET /api/content/:id` | 購入済みなら本文を返す |
| `POST /api/webhook` | Stripe からの通知 (署名を検証) |

`/api/webhook` 以外は、`Authorization: Bearer <WOFF のアクセストークン>` が必要です。

## 必要なもの

- LINE WORKS の Developer Console で WOFF アプリを登録できること
- Stripe アカウント (テストモード / サンドボックス)
- Cloudflare アカウントと Node.js (`npx wrangler` を使います)

## セットアップ

### 1. Cloudflare

```bash
npx wrangler login
npx wrangler kv namespace create PURCHASES
```

表示された KV の `id` を `wrangler.jsonc` の `<YOUR_KV_NAMESPACE_ID>` に書きます。

### 2. LINE WORKS Developer Console

1. アプリの OAuth Scopes に user 系のスコープ (`user.profile.read` など) を追加する。
   サーバーが `users/me` を呼んで利用者を特定するために使います
2. WOFF アプリを登録し、WOFF ID を `wrangler.jsonc` の `<YOUR_WOFF_ID>` に書く。
   WOFF ID は画面から手で写さずコピーしてください (小文字の l と大文字の I を取り違えやすい)

### 3. Stripe のキーを登録してデプロイ

```bash
npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_...
npx wrangler secret put STRIPE_PUBLISHABLE_KEY   # pk_test_...
npx wrangler deploy
```

デプロイ後に表示された URL を使って、WOFF アプリの Endpoint URL を設定します。

```
https://woff-stripe-demo.<your-subdomain>.workers.dev/?woffId=<WOFF ID>
```

### 4. Stripe の webhook

Stripe ダッシュボード (テストモード) の「開発者」→「Webhook」→「送信先を追加」で次のように設定します。

| 項目 | 値 |
|---|---|
| イベントの送信元 | お客様のアカウント |
| ペイロードのスタイル | スナップショット |
| イベント | `checkout.session.completed`, `checkout.session.async_payment_succeeded` |
| 送信先の種類 | Webhook エンドポイント |
| URL | `https://woff-stripe-demo.<your-subdomain>.workers.dev/api/webhook` |

作成後に表示される署名シークレットを登録します。

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_...
```

## 試す

1. LINE WORKS アプリで WOFF URL (`https://woff.worksmobile.com/woff/<WOFF ID>`) を開く
2. 「購入」を押し、テストカードで支払う

| カード番号 | 内容 |
|---|---|
| `4242 4242 4242 4242` | 支払い成功 |
| `4000 0025 0000 3155` | 3D セキュア認証あり |

有効期限は未来の日付、CVC は任意の 3 桁です。

3. 「購入が完了しました」と表示され、ボタンが「読む」に変わる

### 購入の記録を見る・消す (PowerShell)

```powershell
pwsh -File .\check-purchases.ps1                 # confirm / webhook のどちらで記録されたかを一覧
pwsh -File .\reset-purchases.ps1                 # 購入記録を消す前に対象を確認
pwsh -File .\reset-purchases.ps1 -Yes            # 購入記録を消して全員を未購入に戻す
pwsh -File .\reset-purchases.ps1 -Yes -IncludeLogs  # 経路の記録も消す
```

どちらも利用者 ID は表示しません。`-Local` を付けると `wrangler dev` のローカル KV が対象になります。
自分の値を入れた設定を `wrangler.local.jsonc` (git 管理外) に置いている場合は、それを使います。

## うまく動かないとき

| 症状 | 原因と対処 |
|---|---|
| `INIT_FAILED Failed to validate feature_token` | Endpoint URL の `woffId` が WOFF アプリの ID と一致していない |
| `利用者を確認できませんでした (users/me: ...)` | OAuth Scopes に user 系のスコープがあるか確認する。Worker のログ (`wrangler tail`) に API のエラー本文が出る |
| `the product tax code is missing` | Stripe アカウントで Managed Payments が既定で有効。このデモは Session ごとに `managed_payments[enabled]=false` を付けている |
| Hosted に切り替えると "This link is incomplete" | WOFF のアプリ内ブラウザで Hosted Checkout を開いたときの既知の症状。Embedded を使う |

## 注意

- 個人の立場で作成したもので、所属組織の見解を示すものではありません
- WOFF のアクセストークンをサーバー側で検証する方法はドキュメントに見当たらなかったため、
  このデモは `users/me` の呼び出しが成功するかどうかで利用者を特定しています
- 商品と本文は `src/index.js` に直接書いています (デモのため)

## ライセンス

MIT
