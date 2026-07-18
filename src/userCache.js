// 사용자 표시 정보(이름·프사) 인메모리 캐시 — admin.getUserById 왕복(~150ms/명)을 줄인다.
// 프로필 변경은 최대 TTL만큼 늦게 반영되는 트레이드오프 (목록 표시용이라 허용)
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TTL = 5 * 60 * 1000;
const cache = new Map(); // uid → { info, exp }

async function getUserInfoCached(uid) {
  const hit = cache.get(uid);
  if (hit && hit.exp > Date.now()) return hit.info;
  let info = { name: '멤버', username: null, avatar_url: null };
  try {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
    const m = u?.user?.user_metadata || {};
    info = {
      name: m.display_name || m.nickname || (u?.user?.email ? u.user.email.split('@')[0] : '멤버'),
      username: m.username || null,
      avatar_url: m.avatar_url || null,
    };
  } catch (_) {}
  cache.set(uid, { info, exp: Date.now() + TTL });
  if (cache.size > 2000) {
    for (const [k, v] of cache) { if (v.exp < Date.now()) cache.delete(k); }
  }
  return info;
}

/** 프로필 저장 직후 최신 반영이 필요할 때 호출 */
function invalidateUserInfo(uid) { cache.delete(uid); }

module.exports = { getUserInfoCached, invalidateUserInfo };
