# 実機での確認結果

2026-09-23 に確認した結果。いずれも各環境で 1〜2 回の試行であり、すべての端末・バージョンで同じになることを保証するものではない。

## 確認した環境

| 環境 | OS | LINE WORKS アプリ |
|---|---|---|
| Android | Android 17 | 4.6.5 |
| iOS | iOS 18.6.2 | 4.6.1 |
| 外部ブラウザ | (ブラウザの種類と OS は未記録) | - |

PC アプリは WOFF を外部ブラウザで開くため、外部ブラウザと同じ経路になる。PC アプリを起点にした購入は試していない。

## Checkout の方式ごとの結果

| 環境 | Hosted Checkout | Embedded Checkout |
|---|---|---|
| Android | **開けない** ("This link is incomplete") | 購入完了 |
| iOS | **開けない** ("This link is incomplete") | 購入完了 (通常カード・3D セキュアカードとも) |
| 外部ブラウザ | 未確認 | 購入完了 (3D セキュアカード) |

- Hosted Checkout: Checkout Session の `url` (`https://checkout.stripe.com/c/pay/cs_test_...#...`) に `location.href` で移動する方式。
  アプリ内ブラウザで `checkout.stripe.com` は開くが、Stripe の画面に "This link is incomplete" と表示される。
  Checkout の URL は `#` 以降が必須で、これが落ちていると考えられる
- Android では、自分のサーバーのエンドポイントから 303 で Checkout の URL にリダイレクトする方法も試したが、同じ結果だった
- Embedded Checkout: `ui_mode=embedded_page` で Session を作り、Stripe.js の `createEmbeddedCheckoutPage()` でページ内に埋め込む方式。
  ページを移動しないので `#` の問題が起きない。支払い後は `return_url` (WOFF URL) に移動し、WOFF として開き直される

## 購入の記録

`/api/confirm` (戻ってきたときの確認) と webhook の両方で記録し、どちらで記録されたかを KV の経路ログに残している。

- 確認したすべての購入 (4 回) で、confirm と webhook の両方の記録が残った
- 4 回とも webhook の記録が confirm より 2〜4 秒早かった

## 利用者の特定

`woff.getAccessToken()` のアクセストークンで `GET https://www.worksapis.com/v1.0/users/me` を呼び、利用者を特定できた。
WOFF のドキュメントには、アクセストークンをサーバー側で検証する方法の記載が見当たらなかったため、この方法を使っている。
Developer Console アプリの OAuth Scopes に user 系のスコープが必要。

## その他に観察したこと

- WOFF ID を 1 文字取り違えて `woff.init()` に渡すと `INIT_FAILED Failed to validate feature_token` になった
- iOS アプリで、トークに貼った**クエリ付きの** WOFF URL (`https://woff.worksmobile.com/woff/<WOFF ID>?checkout=hosted`) を
  タップすると、WOFF が開かずにトーク画面に「一時的に利用できません。管理者にお問い合わせください。」と表示された。
  クエリなしの URL は開けた。1 回の観察で、原因は特定できていない。
  このため、決済方式は画面のボタンでも切り替えられるようにしている
- テストに使った Stripe アカウントでは Managed Payments が既定で有効になっており、商品に `tax_code` を指定しないと
  Checkout Session の作成がエラーになった。Session ごとに `managed_payments[enabled]=false` を付けて回避している。
  どのアカウントで既定が有効になるのかは確認していない
