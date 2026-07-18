const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 토큰 검증 캐시 — 같은 토큰의 재검증 왕복(요청마다 수백 ms)을 줄인다.
// 토큰 자체가 1시간 만료라 60초 캐시는 보안상 안전. 만료·로그아웃된 토큰은 60초 내 자연 소멸.
const AUTH_CACHE_TTL = 60 * 1000;
const authCache = new Map(); // token → { user, exp }

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }

  const token = authHeader.split(' ')[1];

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const cached = authCache.get(token);
  if (cached && cached.exp > Date.now()) {
    req.user = cached.user;
    req.supabase = supabase;
    return next();
  }

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다' });
  }

  authCache.set(token, { user, exp: Date.now() + AUTH_CACHE_TTL });
  if (authCache.size > 500) { // 무한 증식 방지
    for (const [k, v] of authCache) { if (v.exp < Date.now()) authCache.delete(k); }
  }

  req.user = user;
  req.supabase = supabase; // 이 supabase는 해당 유저 권한으로 동작
  next();
}

module.exports = { requireAuth };
