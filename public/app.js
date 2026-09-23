// WOFF コンテンツストアの画面側。
// 決済・購入判定・本文の配信はすべて Worker (/api/*) が行い、ここは表示だけを担う。
// アクセストークンや URL の # 以降は画面・console に出さないこと。

// Endpoint URL の ?woffId=... か、WOFF URL 経由で渡る woff.state の中から値を読む
function readParam(name) {
    const params = new URLSearchParams(location.search);
    if (params.get(name)) return params.get(name);
    const state = params.get('woff.state');
    if (state && state.includes('?')) {
        const stateQuery = state.slice(state.indexOf('?') + 1).split('#')[0];
        return new URLSearchParams(stateQuery).get(name);
    }
    return null;
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + woff.getAccessToken(),
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
}

function notice(text, kind) {
    const el = document.getElementById('notice');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'notice ' + (kind || '');
}

// URL から session_id などを消す (再読み込みで confirm が繰り返されないように)。
// # 以降にトークンが載るため、location.href をそのまま使ったり表示したりしない
function cleanUrl() {
    const url = new URL(location.href);
    url.search = '?woffId=' + encodeURIComponent(readParam('woffId') || '');
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
}

// 決済方式の切り替え (比較検証用)。既定は埋め込み (embedded)。
// 画面の「決済方式を切り替える」ボタンか、WOFF URL の後ろの ?checkout=hosted で hosted になる。
// iOS アプリではトークに貼ったクエリ付き WOFF URL が「一時的に利用できません」で開けなかったため、ボタンも用意している
let checkoutMode = readParam('checkout') === 'hosted' ? 'hosted' : 'embedded';

function showMode() {
    document.getElementById('mode').textContent =
        checkoutMode === 'hosted' ? '決済方式: Hosted (checkout.stripe.com に移動)' : '決済方式: Embedded (ページ内に埋め込み)';
}

let publishableKey = null;
let checkout = null;

async function render() {
    const data = await api('/api/products');
    const { user, products } = data;
    publishableKey = data.publishableKey;
    document.getElementById('greeting').textContent = (user.name || 'ようこそ') + ' さん';
    // スクリーンショットでどちらの方式か分かるように表示する
    showMode();

    const list = document.getElementById('products');
    list.replaceChildren();
    for (const p of products) {
        const li = document.createElement('li');
        const title = document.createElement('h2');
        title.textContent = p.name;
        const teaser = document.createElement('p');
        teaser.textContent = p.teaser;
        const button = document.createElement('button');
        if (p.purchased) {
            button.textContent = '読む';
            button.onclick = () => openContent(p.id);
            li.classList.add('purchased');
        } else {
            button.textContent = '¥' + p.price.toLocaleString() + ' で購入';
            button.onclick = () => buy(p.id, button);
        }
        li.append(title, teaser, button);
        list.append(li);
    }
}

// Stripe Checkout をこのページの中に埋め込む。
// 別ページの Checkout に移動すると、WOFF のアプリ内ブラウザでは URL の # 以降が落ちて開けないため。
// 支払い後は return_url (WOFF URL) に移動し、WOFF として開き直される
async function buy(productId, button) {
    button.disabled = true;
    button.textContent = '決済フォームを準備中...';
    notice('');
    if (checkoutMode === 'hosted') return buyHosted(productId, button);
    try {
        if (!publishableKey) throw new Error('公開可能キーが設定されていません');
        const stripe = Stripe(publishableKey);
        checkout = await stripe.createEmbeddedCheckoutPage({
            fetchClientSecret: async () => {
                const { clientSecret } = await api('/api/checkout', {
                    method: 'POST',
                    body: JSON.stringify({ productId }),
                });
                return clientSecret;
            },
        });
        document.getElementById('products').hidden = true;
        document.getElementById('checkoutSection').hidden = false;
        checkout.mount('#checkout');
    } catch (e) {
        notice('決済を開始できませんでした: ' + e.message, 'error');
        closeCheckout();
        await render();
    }
}

// 比較用: Stripe のホストするページに同じ画面のまま移動する。
// WOFF の Android アプリではこの方式で URL の # 以降が落ち、"This link is incomplete" になった
async function buyHosted(productId, button) {
    try {
        const { url } = await api('/api/checkout', {
            method: 'POST',
            body: JSON.stringify({ productId, mode: 'hosted' }),
        });
        location.href = url;
    } catch (e) {
        notice('決済を開始できませんでした: ' + e.message, 'error');
        button.disabled = false;
        await render();
    }
}

function closeCheckout() {
    if (checkout) {
        checkout.destroy();
        checkout = null;
    }
    document.getElementById('checkoutSection').hidden = true;
    document.getElementById('products').hidden = false;
}

async function openContent(productId) {
    const { name, body } = await api('/api/content/' + productId);
    document.getElementById('viewerTitle').textContent = name;
    document.getElementById('viewerBody').textContent = body;
    document.getElementById('viewer').hidden = false;
}

// 決済から戻ってきたとき: session_id を Worker に渡し、Stripe に問い合わせて確定してもらう
async function handleReturn() {
    const sessionId = readParam('session_id');
    cleanUrl();
    if (sessionId) {
        notice('購入を確認しています...');
        const result = await api('/api/confirm', {
            method: 'POST',
            body: JSON.stringify({ sessionId }),
        });
        notice(result.paid ? '購入が完了しました。「読む」から開けます。' : '支払いを確認できませんでした。',
            result.paid ? 'success' : 'error');
    }
}

async function main() {
    document.getElementById('checkoutCancel').onclick = closeCheckout;
    document.getElementById('modeToggle').onclick = () => {
        checkoutMode = checkoutMode === 'hosted' ? 'embedded' : 'hosted';
        showMode();
    };
    showMode();
    document.getElementById('viewerClose').onclick = () => {
        document.getElementById('viewer').hidden = true;
    };

    const woffId = readParam('woffId');
    if (!woffId) {
        notice('Endpoint URL に ?woffId=<WOFF ID> を付けて登録してください。', 'error');
        return;
    }
    try {
        await woff.init({ woffId });
        if (!woff.isLoggedIn()) {
            woff.login();
            return;
        }
        await handleReturn();
        await render();
    } catch (e) {
        notice('エラー: ' + (e.code ? e.code + ' ' : '') + e.message, 'error');
    }
}

main();
