import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USER = process.env.BOT_USER;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Content-Type': 'application/json'
};

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: cors });
}

async function tg(chat, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text })
  });
}

export default async function handler(req) {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  // 1. Telegram webhook
  if (req.method === 'POST' && url.pathname.endsWith('/hook')) {
    let up;
    try { up = await req.json(); } catch { return new Response('ok'); }
    
    const msg = up.message;
    if (!msg || !msg.text) return new Response('ok');
    
    const chat = msg.chat.id;
    const text = msg.text.trim();

    if (text === '/start') {
      await tg(chat, '👋 Привет!\n\nПришлите ваш @username из Winter (без символа @), чтобы привязать аккаунт.\n\nНапример: kotik');
      return new Response('ok');
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
      return new Response('ok');
    }

    // Проверяем, не привязан ли уже этот Telegram
    const existing = await redis.get('user:' + chat);
    if (existing) {
      await tg(chat, `⚠️ Ваш Telegram уже привязан к @${existing.username}.\n\nЧтобы перепривязать — напишите /reset`);
      return new Response('ok');
    }

    // Сохраняем связь
    const username = text.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      await tg(chat, '❌ Неверный формат. Напишите только буквы, цифры и _ (3-32 символа), без @.');
      return new Response('ok');
    }

    await redis.set('user:' + chat, { username, chat, ts: Date.now() });
    await redis.set('tg:' + username, { chat, username, ts: Date.now() });
    await tg(chat, `✅ Готово! Аккаунт @${username} успешно привязан к этому Telegram.`);
    return new Response('ok');
  }

  // 2. Проверка привязки по username (для сайта)
  if (url.pathname.endsWith('/check') && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return j({ error: 'bad json' }, 400); }
    const username = String(body.username || '').replace(/^@/, '').toLowerCase();
    const rec = await redis.get('tg:' + username);
    return j({ linked: !!rec, chat: rec ? rec.chat : null });
  }

  // 3. Проверка привязки по chat_id (для сайта)
  if (url.pathname.endsWith('/me') && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return j({ error: 'bad json' }, 400); }
    const chat = body.chat;
    const rec = await redis.get('user:' + chat);
    return j({ linked: !!rec, username: rec ? rec.username : null });
  }

  return j({ error: 'POST only' }, 405);
}

export const config = { runtime: 'edge' };
