import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USER = process.env.BOT_USER;

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

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  if (req.method === 'POST' && url.pathname.endsWith('/hook')) {
    let up;
    try { up = await req.json(); } catch { return new Response('ok'); }
    const msg = up.message;
    if (!msg || !msg.text) return new Response('ok');
    const chat = msg.chat.id;
    const m = /^\/start\s+(\S+)/.exec(msg.text);
    if (!m) {
      await tg(chat, 'Вернитесь на сайт Winter и нажмите «Получить код» — я пришлю 6 цифр.');
      return new Response('ok');
    }
    const sid = m[1];
    const raw = await redis.get('sid:' + sid);
    if (!raw) {
      await tg(chat, 'Ссылка устарела. Запросите код на сайте заново.');
      return new Response('ok');
    }
    const code = String(100000 + Math.floor(Math.random() * 900000));
    await redis.set('otp:' + sid, JSON.stringify({ code, chat, tries: 0 }), { ex: 300 });
    await redis.set('sid:' + sid, JSON.stringify({ ready: 1 }), { ex: 300 });
    await tg(chat, '🔐 Код входа в Winter\n\n' + code + '\n\nДействует 5 минут. Никому не сообщайте.');
    return new Response('ok');
  }

  if (req.method !== 'POST') return j({ error: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return j({ error: 'bad json' }, 400); }

  if (url.pathname.endsWith('/send')) {
    const phone = String(body.phone || '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return j({ error: 'Неверный номер' }, 400);
    const rl = await redis.get('rl:' + phone);
    const now = Date.now();
    if (rl && now - rl < 30000) return j({ error: 'Подождите 30 секунд' }, 429);
    await redis.set('rl:' + phone, now, { ex: 60 });
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    await redis.set('sid:' + id, JSON.stringify({ phone, ready: 0 }), { ex: 300 });
    return j({ id, ttl: 300, link: `https://t.me/${BOT_USER}?start=${id}` });
  }

  if (url.pathname.endsWith('/ready')) {
    const raw = await redis.get('sid:' + String(body.id || ''));
    return j({ ready: !!(raw && JSON.parse(raw).ready) });
  }

  if (url.pathname.endsWith('/verify')) {
    const id = String(body.id || '');
    const code = String(body.code || '');
    const raw = await redis.get('otp:' + id);
    if (!raw) return j({ ok: false, error: 'Код не выдан. Откройте бота и нажмите Start.' }, 400);
    const rec = JSON.parse(raw);
    if ((rec.tries || 0) >= 5) {
      await redis.del('otp:' + id);
      return j({ ok: false, error: 'Слишком много попыток' }, 429);
    }
    if (rec.code !== code) {
      await redis.set('otp:' + id, JSON.stringify({ ...rec, tries: (rec.tries || 0) + 1 }), { ex: 300 });
      return j({ ok: false, error: 'Неверный код' }, 400);
    }
    await redis.del('otp:' + id);
    await redis.del('sid:' + id);
    return j({ ok: true });
  }

  return j({ error: 'not found' }, 404);
}

export const config = {
  runtime: 'edge',
};
