// WOFF + Stripe Checkout でコンテンツを販売するデモの Worker。
//
//   GET  /api/products          商品一覧 (本文は含まない。購入済みフラグ付き)
//   POST /api/checkout          Checkout Session を作成して URL を返す
//   POST /api/confirm           戻ってきたときに Session を Stripe に問い合わせて購入を確定する
//   GET  /api/content/:id       購入済みなら本文を返す
//   POST /api/webhook           Stripe からの通知 (checkout.session.completed)
//   GET  /api/redirect/:id      比較用: Hosted Checkout の URL に 303 で転送する
//
// 利用者の特定は、WOFF のアクセストークンで LINE WORKS API の users/me を呼んで行う。
// クライアントから送られた userId は信用しない。

const WORKS_API = 'https://www.worksapis.com/v1.0';
const STRIPE_API = 'https://api.stripe.com/v1';

// Checkout Session の metadata に入れる識別子。Stripe の webhook の送信先はアカウント単位で、
// 同じアカウントを使う別のアプリ (LIFF 版など) の購入通知も届くため、自分の Session だけを記録する
const PLATFORM = 'woff';
const CHECKOUT_MODES = ['embedded', 'hosted', 'hosted303'];

// デモ用の商品。本文 (body) はこの Worker からしか返さない
const PRODUCTS = [
  {
    id: 'guide-basic',
    name: 'はじめての WOFF 活用ガイド',
    price: 300,
    teaser: 'WOFF でできることを 5 分で把握できるミニガイド。',
    body: '(購入者だけが読める本文) WOFF は LINE WORKS アプリ内で動く Web アプリです。…',
  },
  {
    id: 'template-pack',
    name: '業務フォーム テンプレート集',
    price: 1200,
    teaser: '日報・出欠・備品申請など、すぐ使えるフォーム 10 種。',
    body: '(購入者だけが読める本文) テンプレート 1: 日報 …',
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }

      // 比較用: 自サーバーの 303 を経由して Hosted Checkout に移動する。
      // 画面遷移なので Authorization ヘッダーは付かない。Stripe から Session を取り直し、
      // このデモが作った未完了の Session の url にだけ転送する (任意の URL には飛ばさない)
      const redirect = url.pathname.match(/^\/api\/redirect\/(cs_(?:test|live)_\w+)$/);
      if (redirect && request.method === 'GET') {
        const session = await stripe(env, 'GET', `/checkout/sessions/${redirect[1]}`);
        if (session.metadata?.platform !== PLATFORM || session.status !== 'open' || !session.url) {
          throw new HttpError(410, 'この決済ページは使えません');
        }
        return new Response(null, { status: 303, headers: { Location: session.url, 'Cache-Control': 'no-store' } });
      }

      // webhook 以外は WOFF のアクセストークンが必須
      const user = await authenticate(request);

      if (url.pathname === '/api/products' && request.method === 'GET') {
        const products = await Promise.all(
          PRODUCTS.map(async (p) => ({
            id: p.id,
            name: p.name,
            price: p.price,
            teaser: p.teaser,
            purchased: await isPurchased(env, user.userId, p.id),
          })),
        );
        // 公開可能キー (pk_test_...) は画面で Stripe.js を初期化するのに使う。公開してよい値
        return json({ user: { name: user.name }, publishableKey: env.STRIPE_PUBLISHABLE_KEY, products });
      }

      if (url.pathname === '/api/checkout' && request.method === 'POST') {
        const { productId, mode } = await request.json();
        return await createCheckout(env, user, findProduct(productId), CHECKOUT_MODES.includes(mode) ? mode : 'embedded');
      }

      if (url.pathname === '/api/confirm' && request.method === 'POST') {
        const { sessionId } = await request.json();
        return await confirmSession(env, user, sessionId);
      }

      const m = url.pathname.match(/^\/api\/content\/([\w-]+)$/);
      if (m && request.method === 'GET') {
        const product = findProduct(m[1]);
        if (!(await isPurchased(env, user.userId, product.id))) {
          throw new HttpError(403, 'まだ購入されていません');
        }
        return json({ id: product.id, name: product.name, body: product.body });
      }

      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
};

// ------------------------------------------------------------
// 利用者の特定
// ------------------------------------------------------------
async function authenticate(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'アクセストークンがありません');

  const res = await fetch(`${WORKS_API}/users/me`, { headers: { Authorization: auth } });
  if (!res.ok) {
    // トークンの値はログに出さない。API のエラー本文 (code/description) だけ残す
    console.warn('users/me failed', res.status, await res.text());
    throw new HttpError(401, `利用者を確認できませんでした (users/me: ${res.status})`);
  }
  const me = await res.json();
  const name = me.userName
    ? `${me.userName.lastName ?? ''} ${me.userName.firstName ?? ''}`.trim()
    : '';
  return { userId: me.userId, name };
}

// ------------------------------------------------------------
// 購入記録 (KV)
// ------------------------------------------------------------
function purchaseKey(userId, productId) {
  return `purchase:${userId}:${productId}`;
}

async function isPurchased(env, userId, productId) {
  return (await env.PURCHASES.get(purchaseKey(userId, productId))) !== null;
}

// confirm と webhook の両方から呼ばれる。同じ Session で何度呼ばれても結果は同じ。
// source ('confirm' | 'webhook') ごとに別キーで記録ログを残す。
// 同じキーを読んで書き足す方式だと、両方がほぼ同時に来たとき片方の記録が消えるため
async function recordPurchase(env, session, source) {
  const { platform, userId, productId } = session.metadata || {};
  // 同じ Stripe アカウントを使う別のアプリの Session は記録しない (webhook には 200 を返す)
  if (platform !== PLATFORM) return false;
  if (!userId || !productId || session.payment_status !== 'paid') return false;
  const at = new Date().toISOString();
  await Promise.all([
    env.PURCHASES.put(
      purchaseKey(userId, productId),
      JSON.stringify({ sessionId: session.id, amount: session.amount_total, at }),
    ),
    env.PURCHASES.put(`log:${session.id}:${source}`, JSON.stringify({ productId, at })),
  ]);
  return true;
}

// ------------------------------------------------------------
// Stripe
// ------------------------------------------------------------
async function stripe(env, method, path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.warn('stripe error', res.status, data.error?.type, data.error?.message);
    throw new HttpError(502, `Stripe エラー: ${data.error?.message ?? res.status}`);
  }
  return data;
}

async function createCheckout(env, user, product, checkoutMode) {
  if (await isPurchased(env, user.userId, product.id)) {
    throw new HttpError(409, '購入済みです');
  }
  // 戻り先は WOFF URL。WOFF を経由して開き直すので、戻った後も woff.init() が使える。
  // 後ろに付けたクエリは woff.state でページに渡る
  const woffUrl = `https://woff.worksmobile.com/woff/${env.WOFF_ID}`;
  const common = {
    mode: 'payment',
    // アカウントで Managed Payments が既定で有効だと、商品ごとの tax_code が必須になる。
    // デモでは使わないのでセッション単位で無効にする
    'managed_payments[enabled]': 'false',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'jpy',
    'line_items[0][price_data][unit_amount]': String(product.price),
    'line_items[0][price_data][product_data][name]': product.name,
    client_reference_id: user.userId,
    'metadata[platform]': PLATFORM,
    'metadata[userId]': user.userId,
    'metadata[productId]': product.id,
  };

  if (checkoutMode === 'hosted' || checkoutMode === 'hosted303') {
    // 比較用: Stripe のホストするページに移動する方式。URL の # 以降が必須だが、
    // WOFF のアプリ内ブラウザで移動すると # 以降が落ちて "This link is incomplete" になった。
    // hosted は Checkout の URL に直接、hosted303 は /api/redirect/... の 303 を経由して移動する
    const session = await stripe(env, 'POST', '/checkout/sessions', {
      ...common,
      success_url: `${woffUrl}?checkout=${checkoutMode}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${woffUrl}?checkout=${checkoutMode}`,
    });
    return json({ url: checkoutMode === 'hosted303' ? `/api/redirect/${session.id}` : session.url });
  }

  // 既定: Checkout をページ内に埋め込む (ui_mode=embedded_page)。ページを移動しないので # の問題が起きない
  const session = await stripe(env, 'POST', '/checkout/sessions', {
    ...common,
    ui_mode: 'embedded_page',
    return_url: `${woffUrl}?session_id={CHECKOUT_SESSION_ID}`,
  });
  return json({ clientSecret: session.client_secret });
}

// 戻り URL の session_id だけでは解放しない。Stripe に問い合わせて、
// 支払い済みであること・購入者が今の利用者であることを確かめてから記録する
async function confirmSession(env, user, sessionId) {
  if (!/^cs_(test|live)_\w+$/.test(sessionId || '')) throw new HttpError(400, 'session_id が不正です');
  const session = await stripe(env, 'GET', `/checkout/sessions/${sessionId}`);
  if (session.metadata?.userId !== user.userId) throw new HttpError(403, '別の利用者の購入です');
  const ok = await recordPurchase(env, session, 'confirm');
  return json({ paid: ok, productId: session.metadata?.productId });
}

async function handleWebhook(request, env) {
  const payload = await request.text();
  const valid = await verifyStripeSignature(
    payload,
    request.headers.get('Stripe-Signature') || '',
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!valid) return json({ error: 'invalid signature' }, 400);

  const event = JSON.parse(payload);
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    await recordPurchase(env, event.data.object, 'webhook');
  }
  return json({ received: true });
}

// Stripe-Signature: t=<timestamp>,v1=<hex HMAC-SHA256 of "t.payload">
async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=')).filter((a) => a.length === 2).map(([k, v]) => [k, v]),
  );
  const signatures = header.split(',').filter((s) => s.startsWith('v1=')).map((s) => s.slice(3));
  const t = Number(parts.t);
  if (!t || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((s) => timingSafeEqual(s, expected));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------
// 小物
// ------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function findProduct(id) {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) throw new HttpError(404, '商品が見つかりません');
  return p;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
