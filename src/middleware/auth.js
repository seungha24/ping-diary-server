const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }

  const token = authHeader.split(' ')[1];

  // 토큰으로 사용자 확인
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다' });
  }

  req.user = user;
  req.supabase = supabase; // 이 supabase는 해당 유저 권한으로 동작
  next();
}

module.exports = { requireAuth };
