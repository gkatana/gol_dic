// POE2 시세 · 판매 계산기 — Cloudflare Worker
// - 10분마다(cron) poe.ninja 카테고리별 시세 + 카카오 공식 거래소 한글 이름을 받아 KV에 "한 키"로 저장
//   (카테고리별로 따로 쓰면 무료 KV 쓰기 한도 하루 1,000회를 넘김 → 반드시 한 번에 저장)
// - /api/snapshot : 리그별 아이템 목록 (KV에서 읽음)
// - /api/item     : 아이템 하나의 화폐별 직거래 시세 (poe.ninja details를 엣지 캐시로 10분 보관)
// - 그 외 경로는 public/ 정적 파일

const NINJA = 'https://poe.ninja/poe2/api';
const KAKAO_STATIC = 'https://poe.game.daum.net/api/trade2/data/static';
const UA = 'Mozilla/5.0 (compatible; gol-dic/1.0; PoE2 KR price helper)';

// poe.ninja 교환소 카테고리 (데이터가 있는 것만)
const TYPES = [
  'Currency', 'Fragments', 'Verisium', 'Runes', 'SoulCores', 'Expedition', 'Delirium',
  'Breach', 'Ritual', 'Abyss', 'Essences', 'UncutGems', 'LineageSupportGems',
];
const TYPE_KO = {
  Currency: '화폐', Fragments: '조각', Verisium: '베리시움', Runes: '룬', SoulCores: '영혼 핵',
  Expedition: '탐험', Delirium: '환영', Breach: '균열', Ritual: '의식', Abyss: '심연의 뼈',
  Essences: '에센스', UncutGems: '미가공 젬', LineageSupportGems: '혈통 보조 젬',
};

const SNAPSHOT_KEY = 'snapshot';
const NAMES_KEY = 'names';
const NAMES_TTL_MS = 24 * 60 * 60 * 1000;   // 한글 이름은 리그 바뀔 때만 변하므로 하루 한 번
const ITEM_CACHE_SEC = 600;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/snapshot') return await handleSnapshot(url, env);
      if (url.pathname === '/api/item') return await handleItem(req, url, env, ctx);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};

function leaguesOf(env) {
  return (env.LEAGUES || 'Standard').split(',').map(s => s.trim()).filter(Boolean);
}

async function getJson(u) {
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
}

// ── 한글 이름표 (id → 한글) ────────────────────────────────────────────────
async function loadNames(env) {
  const cur = await env.DATA.get(NAMES_KEY, 'json');
  if (cur && Date.now() - cur.updatedAt < NAMES_TTL_MS) return cur.map;
  try {
    const j = await getJson(KAKAO_STATIC);
    const map = {};
    for (const cat of j.result || []) {
      for (const e of cat.entries || []) if (e.id && e.text) map[e.id] = e.text;
    }
    await env.DATA.put(NAMES_KEY, JSON.stringify({ updatedAt: Date.now(), map }));
    return map;
  } catch (e) {
    console.error('names', e);
    return cur ? cur.map : {};   // 실패하면 이전 이름표 유지 (없으면 영어 이름으로 표시)
  }
}

// ── 시세 수집 ─────────────────────────────────────────────────────────────
async function fetchLeague(league, names) {
  const q = encodeURIComponent(league);
  const results = await Promise.allSettled(
    TYPES.map(t => getJson(`${NINJA}/economy/exchange/current/overview?league=${q}&type=${t}`))
  );
  let rates = null;
  const items = [];
  results.forEach((res, i) => {
    if (res.status !== 'fulfilled') { console.error(league, TYPES[i], res.reason); return; }
    const j = res.value;
    if (!rates && j.core && j.core.rates) rates = { ...j.core.rates, primary: j.core.primary || 'divine' };
    const meta = {};
    for (const it of j.items || []) meta[it.id] = it;
    for (const l of j.lines || []) {
      const m = meta[l.id] || {};
      items.push({
        id: l.id,                                             // 한글 이름표(카카오)와 같은 id
        did: m.detailsId || l.id,                             // poe.ninja 상세 조회용 id (예: chaos → chaos-orb)
        en: m.name || l.id,
        ko: names[l.id] || null,
        type: TYPES[i],
        img: m.image || null,
        div: l.primaryValue,                                  // 1개당 디바인 가치
        vol: l.volumePrimaryValue,                            // 하루 거래량 (디바인 환산)
        ch7: l.sparkline ? l.sparkline.totalChange : null,    // 7일 변동 %
      });
    }
  });
  if (!items.length) throw new Error('no data for ' + league);
  return { rates, items };
}

async function refresh(env) {
  const names = await loadNames(env);
  const prev = (await env.DATA.get(SNAPSHOT_KEY, 'json')) || { leagues: {} };
  const out = { updatedAt: new Date().toISOString(), leagues: {} };
  for (const league of leaguesOf(env)) {
    try {
      out.leagues[league] = await fetchLeague(league, names);
    } catch (e) {
      console.error('league', league, e);
      if (prev.leagues[league]) out.leagues[league] = prev.leagues[league];   // 실패 시 이전 값 유지
    }
  }
  await env.DATA.put(SNAPSHOT_KEY, JSON.stringify(out));   // 하루 144회 (10분 주기) — 무료 한도 1,000회 이내
  return out;
}

// ── API ──────────────────────────────────────────────────────────────────
async function handleSnapshot(url, env) {
  let snap = await env.DATA.get(SNAPSHOT_KEY, 'json');
  if (!snap) snap = await refresh(env);   // 첫 배포 직후 cron이 아직 안 돌았을 때
  const all = leaguesOf(env).filter(l => snap.leagues[l]);
  const league = all.includes(url.searchParams.get('league')) ? url.searchParams.get('league') : all[0];
  const data = snap.leagues[league] || { rates: null, items: [] };
  return json(
    { updatedAt: snap.updatedAt, leagues: all, league, typeKo: TYPE_KO, rates: data.rates, items: data.items },
    200,
    { 'Cache-Control': 'public, max-age=120' }
  );
}

async function handleItem(req, url, env, ctx) {
  const league = url.searchParams.get('league');
  const type = url.searchParams.get('type');
  const id = url.searchParams.get('id');
  if (!leaguesOf(env).includes(league) || !TYPES.includes(type) || !/^[a-z0-9-]{1,100}$/.test(id || '')) {
    return json({ error: 'bad params' }, 400);
  }

  const cacheKey = new Request(`https://cache.local/item?league=${encodeURIComponent(league)}&type=${type}&id=${id}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const j = await getJson(
    `${NINJA}/economy/exchange/current/details?league=${encodeURIComponent(league)}&type=${type}&id=${id}`
  );
  const body = {
    id,
    rates: j.core && j.core.rates ? j.core.rates : null,
    // pair.rate = 아이템 1개당 받는 해당 화폐 개수
    pairs: (j.pairs || []).map(p => ({
      id: p.id,
      rate: p.rate,
      vol: p.volumePrimaryValue,
      history: (p.history || []).slice(0, 14).map(h => ({ t: h.timestamp, rate: h.rate })).reverse(),
    })),
  };
  const res = json(body, 200, { 'Cache-Control': `public, max-age=${ITEM_CACHE_SEC}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
