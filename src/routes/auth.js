const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../supabase');
const { requireAuth } = require('../middleware/auth');

// 서비스 키 클라이언트 (계정 삭제 등 관리 작업용, RLS 우회)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /auth/signup
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호는 필수입니다' });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  res.status(201).json({ user: { id: data.user.id, email: data.user.email } });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호는 필수입니다' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸습니다' });

  res.json({
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email },
  });
});

// POST /auth/password — 비밀번호 변경 (로그인 상태)
router.post('/password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다' });
  }

  // req.supabase는 해당 유저 토큰으로 동작하므로 본인 비밀번호만 바뀜
  const { error } = await req.supabase.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ ok: true });
});

// DELETE /auth/account — 계정 및 모든 데이터 삭제 (탈퇴)
router.delete('/account', requireAuth, async (req, res) => {
  const userId = req.user.id;

  // 본인 데이터부터 정리 (RLS 우회 위해 admin 사용)
  await supabaseAdmin.from('diary_entries').delete().eq('user_id', userId);
  await supabaseAdmin.from('group_members').delete().eq('user_id', userId);

  // 인증 계정 삭제
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

module.exports = router;
