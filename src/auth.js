// Google 로그인 + 즐겨찾기 동기화
// - 화면에서 "Google로 로그인" → Google이 준 ID 토큰(JWT)을 /api/auth/google 로 보냄
// - 여기서 Google 공개키로 서명·발급자·대상(client id)·만료를 검증한 뒤, 자체 세션 쿠키(HMAC 서명)를 발급
// - 즐겨찾기는 D1(favorites)에 Google 계정 고유 id(sub) 기준으로 저장
// - 저장하는 개인정보: Google 고유 id, 이름, 프로필 사진 주소 (이메일은 저장하지 않음)

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com'];
const SESSION_COOKIE = 'gd_session';
const SESSION_SEC = 30 * 24 * 60 * 60;
const MAX_FAVS = 500;
const ITEM_ID_RE = /^[\p{Ll}\p{N}-]{1,100}$/u;   // 'mórrigans-insight' 같은 악센트 포함 id 허용

export { ITEM_ID_RE };

export async function handleAuth(req, url, env) {
  const p = url.pathname;
  if (p === '/api/me' && req.method === 'GET') return me(req, env);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  // 다른 사이트에서 쿠키를 실어 보내는 요청(CSRF) 차단
  if (req.headers.get('Origin') !== url.origin) return json({ error: 'bad origin' }, 403);
  if (p === '/api/auth/google') return login(req, env);
  if (p === '/api/auth/logout') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  if (p === '/api/favs') return setFav(req, env);
  return json({ error: 'not found' }, 404);
}

async function me(req, env) {
  const uid = await sessionUser(req, env);
  const clientId = env.GOOGLE_CLIENT_ID || null;
  if (!uid) return json({ user: null, clientId }, 200, noStore());
  const user = await env.DB.prepare('SELECT name, picture FROM users WHERE id = ?').bind(uid).first();
  if (!user) return json({ user: null, clientId }, 200, { ...noStore(), 'Set-Cookie': cookie('', 0) });
  return json({ user, favs: await listFavs(env, uid), clientId }, 200, noStore());
}

async function login(req, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) return json({ error: '로그인 설정이 아직 안 되어 있습니다' }, 503);
  const body = await req.json().catch(() => ({}));
  let p;
  try {
    p = await verifyGoogleIdToken(String(body.credential || ''), env.GOOGLE_CLIENT_ID);
  } catch (e) {
    return json({ error: '로그인 확인 실패: ' + e.message }, 401);
  }
  const now = Date.now();
  const uid = 'g:' + p.sub;
  await env.DB.prepare(
    `INSERT INTO users (id, name, picture, created_at, last_login) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO UPDATE SET name = ?2, picture = ?3, last_login = ?4`
  ).bind(uid, p.name || null, p.picture || null, now).run();

  // 로그인 전 이 브라우저에 담아둔 즐겨찾기를 계정에 합침
  const local = (Array.isArray(body.favs) ? body.favs : []).filter(id => typeof id === 'string' && ITEM_ID_RE.test(id));
  if (local.length) {
    const have = await countFavs(env, uid);
    const add = local.slice(0, Math.max(0, MAX_FAVS - have));
    if (add.length) {
      await env.DB.batch(add.map(id =>
        env.DB.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?, ?, ?)').bind(uid, id, now)));
    }
  }
  const token = await signSession(uid, env.SESSION_SECRET);
  return json(
    { user: { name: p.name || null, picture: p.picture || null }, favs: await listFavs(env, uid) },
    200,
    { ...noStore(), 'Set-Cookie': cookie(token, SESSION_SEC) }
  );
}

async function setFav(req, env) {
  const uid = await sessionUser(req, env);
  if (!uid) return json({ error: '로그인이 필요합니다' }, 401);
  const { id, on } = await req.json().catch(() => ({}));
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) return json({ error: 'bad id' }, 400);
  if (on) {
    if ((await countFavs(env, uid)) >= MAX_FAVS) return json({ error: `즐겨찾기는 ${MAX_FAVS}개까지입니다` }, 400);
    await env.DB.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?, ?, ?)')
      .bind(uid, id, Date.now()).run();
  } else {
    await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').bind(uid, id).run();
  }
  return json({ ok: true }, 200, noStore());
}

async function listFavs(env, uid) {
  const r = await env.DB.prepare('SELECT item_id FROM favorites WHERE user_id = ? ORDER BY created_at').bind(uid).all();
  return r.results.map(x => x.item_id);
}
async function countFavs(env, uid) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?').bind(uid).first();
  return r ? r.n : 0;
}

// ── Google ID 토큰 검증 ─────────────────────────────────────────────────
export async function verifyGoogleIdToken(token, clientId, certs) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('형식 오류');
  const header = JSON.parse(b64urlText(parts[0]));
  const payload = JSON.parse(b64urlText(parts[1]));
  if (header.alg !== 'RS256') throw new Error('알고리즘 오류');

  const keys = certs || (await googleCerts());
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('알 수 없는 키');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('서명 불일치');

  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISS.includes(payload.iss)) throw new Error('발급자 오류');
  if (payload.aud !== clientId) throw new Error('대상 오류');
  if (!(payload.exp > now - 60)) throw new Error('만료됨');
  if (!payload.sub) throw new Error('계정 id 없음');
  return payload;
}

async function googleCerts() {
  // Google 공개키는 몇 시간 단위로 바뀌므로 엣지 캐시에 응답의 Cache-Control만큼 보관
  const cache = caches.default;
  let r = await cache.match(GOOGLE_CERTS);
  if (!r) {
    r = await fetch(GOOGLE_CERTS);
    if (!r.ok) throw new Error('Google 키 조회 실패');
    await cache.put(GOOGLE_CERTS, r.clone());
  }
  return (await r.json()).keys;
}

// ── 세션 쿠키 (uid.만료.서명) ───────────────────────────────────────────
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

export async function signSession(uid, secret, now = Date.now()) {
  const body = b64url(new TextEncoder().encode(uid)) + '.' + (Math.floor(now / 1000) + SESSION_SEC);
  return body + '.' + (await hmac(secret, body));
}

export async function readSession(token, secret, now = Date.now()) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const body = parts[0] + '.' + parts[1];
  const sig = await hmac(secret, body);
  if (sig.length !== parts[2].length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ parts[2].charCodeAt(i);
  if (diff) return null;
  if (!(Number(parts[1]) > now / 1000)) return null;
  return b64urlText(parts[0]);
}

async function sessionUser(req, env) {
  if (!env.SESSION_SECRET) return null;
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return m ? readSession(m[1], env.SESSION_SECRET) : null;
}

function cookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

// ── 공통 ─────────────────────────────────────────────────────────────────
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

function noStore() { return { 'Cache-Control': 'no-store' }; }

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
