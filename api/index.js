import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USER = process.env.BOT_USER;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
// Секрет вебхука: без него любой может подделать сообщение «от Telegram».
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const RESERVED = ['winter', 'ai'];
const LOGIN_TTL = 300; // секунд на подтверждение входа

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Content-Type': 'application/json'
};

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: cors });
}

async function tgApi(method, payload) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

function tg(chat, text, extra) {
  return tgApi('sendMessage', Object.assign({ chat_id: chat, text }, extra || {}));
}

const OK = () => new Response('ok');

export default async function handler(req) {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  // 1. Telegram webhook
  if (req.method === 'POST' && url.pathname.endsWith('/hook')) {
    if (WEBHOOK_SECRET && req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 401 });
    }

    let up;
    try { up = await req.json(); } catch { return OK(); }

    // 1a. Нажатие кнопки «Это я» / «Это не я» при входе на сайт
    const cq = up.callback_query;
    if (cq) {
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
      const chat = cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id;
      const m = /^(ok|no):([a-z0-9]{16,40})$/.exec(String(cq.data || ''));
      if (!m || !WEBHOOK_SECRET) return OK();
      const req2 = await redis.get('loginreq:' + m[2]);
      if (!req2 || String(req2.chat) !== String(chat)) {
        await tg(chat, '⌛ Запрос входа устарел. Нажмите «Войти через Telegram» на сайте ещё раз.');
        return OK();
      }
      await redis.del('loginreq:' + m[2]);
      if (m[1] === 'ok') {
        await redis.set('login:' + m[2], { username: req2.username }, { ex: LOGIN_TTL });
        await tg(chat, '✅ Вход подтверждён. Вернитесь на сайт.');
      } else {
        await tg(chat, '🚫 Вход отменён.');
      }
      return OK();
    }

    const msg = up.message;
    if (!msg || !msg.text) return OK();

    const chat = msg.chat.id;
    const text = msg.text.trim();

    // 1b. Вход на сайт: /start login_<токен>
    const lm = /^\/start login_([a-z0-9]{16,40})$/.exec(text);
    if (lm) {
      const token = lm[1];
      if (!WEBHOOK_SECRET) {
        await tg(chat, 'Вход через Telegram пока не включён.');
        return OK();
      }
      const rec = await redis.get('user:' + chat);
      if (!rec) {
        await redis.set('login:' + token, { error: 'not_linked' }, { ex: LOGIN_TTL });
        await tg(chat, '⚠️ К этому Telegram не привязан ник.\n\nНапишите /start и пришлите ваш ник из Winter, потом повторите вход.');
        return OK();
      }
      await redis.set('loginreq:' + token, { chat, username: rec.username }, { ex: LOGIN_TTL });
      await tg(chat, `🔐 Вход в Winter как @${rec.username}.\n\nЭто вы? Если вы ничего не нажимали на сайте — выберите «Это не я».`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Это я, войти', callback_data: 'ok:' + token },
          { text: '❌ Это не я', callback_data: 'no:' + token }
        ]] }
      });
      return OK();
    }

    if (text === '/start') {
      await tg(chat, '👋 Привет!\n\nПришлите ваш @username из Winter (без символа @), чтобы привязать аккаунт.\n\nНапример: kotik');
      return OK();
    }

    if (text === '/reset') {
      const rec = await redis.get('user:' + chat);
      if (rec) {
        await redis.del('user:' + chat);
        await redis.del('tg:' + rec.username);
        await tg(chat, '✅ Привязка сброшена. Напишите /start, чтобы привязать новый аккаунт.');
      } else {
        await tg(chat, 'У вас нет привязанного аккаунта.');
      }
      return OK();
    }

    // Один Telegram — один аккаунт
    const existing = await redis.get('user:' + chat);
    if (existing) {
      await tg(chat, `⚠️ Ваш Telegram уже привязан к @${existing.username}.\n\nЧтобы перепривязать — напишите /reset`);
      return OK();
    }

    const username = text.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      await tg(chat, '❌ Неверный формат. Напишите только буквы, цифры и _ (3-32 символа), без @.');
      return OK();
    }
    if (RESERVED.includes(username)) {
      await tg(chat, '❌ Этот ник зарезервирован. Выберите другой.');
      return OK();
    }

    // Один ник — один Telegram: если ник уже занят, второй раз не привязать
    const claimed = await redis.set('tg:' + username, { chat, username, ts: Date.now() }, { nx: true });
    if (!claimed) {
      await tg(chat, `⛔ Ник @${username} уже привязан к другому Telegram. Выберите другой ник.`);
      return OK();
    }
    await redis.set('user:' + chat, { username, chat, ts: Date.now() });
    await tg(chat, `✅ Готово! Аккаунт @${username} успешно привязан к этому Telegram.`);
    return OK();
  }

  // 2. Проверка привязки по нику (для сайта)
  if (url.pathname.endsWith('/check') && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return j({ error: 'bad json' }, 400); }
    const username = String(body.username || '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return j({ linked: false });
    const rec = await redis.get('tg:' + username);
    return j({ linked: !!rec });
  }

  // 3. Вход через Telegram: сайт спрашивает, подтвердили ли вход по токену
  if (url.pathname.endsWith('/login') && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return j({ error: 'bad json' }, 400); }
    const token = String(body.token || '');
    if (!/^[a-z0-9]{16,40}$/.test(token)) return j({ ok: false, pending: true });
    const rec = await redis.get('login:' + token);
    if (!rec) return j({ ok: false, pending: true });
    await redis.del('login:' + token); // токен одноразовый
    if (rec.error) return j({ ok: false, error: rec.error });
    return j({ ok: true, username: rec.username });
  }

  return j({ error: 'POST only' }, 405);
}

export const config = { runtime: 'edge' };
