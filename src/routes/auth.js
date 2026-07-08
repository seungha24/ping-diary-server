const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../supabase');
const { requireAuth } = require('../middleware/auth');

// 서비스 키 클라이언트 (계정 삭제 등 관리 작업용, RLS 우회)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── 카카오 로그인 (커스텀 OAuth) ──────────────────────────────
// Supabase 기본 카카오 provider는 이메일 scope를 강제 요청하는데, 이메일은
// 카카오 비즈니스 앱 전환이 있어야 받을 수 있다. 그래서 닉네임(profile_nickname)만
// 요청하는 OAuth를 직접 구현해 Supabase 세션을 발급한다.
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || 'dda0e9624bcabd9b2bacdd9f9109878f';
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET || ''; // 카카오에서 Client Secret '사용함'일 때만 필요
const SERVER_URL = process.env.SERVER_URL || 'https://ping-diary-server-production.up.railway.app';
const KAKAO_REDIRECT_URI = `${SERVER_URL}/auth/kakao/callback`;
const APP_URL_DEFAULT = process.env.APP_URL || 'https://ping-diary.vercel.app';

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

  // admin으로 본인 계정(req.user.id) 비밀번호만 변경 (user-scoped 클라이언트는 세션이 없어 updateUser 불가)
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, { password });
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

// GET /auth/kakao/start — 카카오 인가 페이지로 리디렉트 (닉네임만 요청)
router.get('/kakao/start', (req, res) => {
  const ret = typeof req.query.return === 'string' ? req.query.return : APP_URL_DEFAULT;
  const params = new URLSearchParams({
    client_id: KAKAO_REST_KEY,
    redirect_uri: KAKAO_REDIRECT_URI,
    response_type: 'code',
    scope: 'profile_nickname',
    state: ret,
  });
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params.toString()}`);
});

// GET /auth/kakao/callback — 카카오 code → Supabase 세션 발급 후 앱으로 리디렉트
router.get('/kakao/callback', async (req, res) => {
  const { code, state, error: kakaoErr } = req.query;
  const appUrl =
    typeof state === 'string' && /^https?:\/\//.test(state) ? state : APP_URL_DEFAULT;
  const fail = (msg) => res.redirect(`${appUrl}?kakao_error=${encodeURIComponent(msg)}`);

  try {
    if (kakaoErr) return fail(String(kakaoErr));
    if (!code) return fail('no_code');

    // 1) 인가 코드 → 카카오 액세스 토큰
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KAKAO_REST_KEY,
      redirect_uri: KAKAO_REDIRECT_URI,
      code: String(code),
    });
    if (KAKAO_CLIENT_SECRET) tokenBody.set('client_secret', KAKAO_CLIENT_SECRET);
    const tokRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: tokenBody.toString(),
    });
    const tok = await tokRes.json();
    if (!tok.access_token) return fail('token_' + (tok.error || tokRes.status));

    // 2) 카카오 프로필 (닉네임)
    const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const me = await meRes.json();
    const kakaoId = me.id;
    if (!kakaoId) return fail('no_profile');
    const nickname =
      me.kakao_account?.profile?.nickname || me.properties?.nickname || `카카오사용자${kakaoId}`;

    // 3) Supabase 사용자 확보 — 합성 이메일 + 결정적 비밀번호 (재로그인 시 동일)
    const email = `kakao_${kakaoId}@ping-diary.app`;
    const password = crypto
      .createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'ping-kakao-secret')
      .update(`kakao:${kakaoId}`)
      .digest('hex');

    // 없으면 생성, 이미 있으면 에러가 나므로 무시하고 로그인으로 진행
    await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { provider: 'kakao', kakao_id: kakaoId, nickname },
    });

    // 4) 결정적 비밀번호로 로그인해 Supabase 세션 발급
    const { data: sess, error: signErr } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signErr || !sess?.session) return fail('signin_failed');

    // 5) 앱으로 토큰 전달 (해시 프래그먼트 → 서버 로그에 안 남음)
    const at = encodeURIComponent(sess.session.access_token);
    const rt = encodeURIComponent(sess.session.refresh_token);
    return res.redirect(`${appUrl}#kakao_at=${at}&kakao_rt=${rt}`);
  } catch (e) {
    return fail('exception');
  }
});

module.exports = router;
