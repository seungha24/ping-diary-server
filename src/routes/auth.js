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
// 카카오에서 Client Secret '사용함'일 때 필요. Railway가 이 변수만 주입을 거부하는
// 문제가 있어 기본값으로 박아둔다(env가 있으면 env 우선). 노출되면 카카오 콘솔에서 재발급.
const KAKAO_CLIENT_SECRET =
  process.env.KAKAO_CLIENT_SECRET || 'R0c1slSF0MdXS9vnDJq7sqPSKWD7CXyF';
const SERVER_URL = process.env.SERVER_URL || 'https://ping-diary-server-production.up.railway.app';
const KAKAO_REDIRECT_URI = `${SERVER_URL}/auth/kakao/callback`;
const APP_URL_DEFAULT = process.env.APP_URL || 'https://ping-diary.vercel.app';

// ── 네이버 로그인 (커스텀 OAuth) ──────────────────────────────
// 카카오와 동일하게 서버에서 네이버 OAuth를 처리해 Supabase 세션을 발급한다.
// 네이버 개발자센터(developers.naver.com) 애플리케이션 값.
// Client ID는 공개값이라 코드에 두고, Client Secret은 Railway 환경변수(NAVER_CLIENT_SECRET)로.
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || 'CF9zPOtTy5G9j7jwjw0Z';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const NAVER_REDIRECT_URI = `${SERVER_URL}/auth/naver/callback`;

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

// GET /auth/me — 내 프로필 (folder_covers 등 user_metadata)
router.get('/me', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  const meta = data.user?.user_metadata || {};
  res.json({
    email: data.user?.email || null,
    folder_covers: meta.folder_covers || {},
    theme: meta.theme || null,
    folders: meta.folders || [],
    hidden_folders: meta.hidden_folders || [],
    display_name: meta.display_name || null,
    username: meta.username || null,
  });
});

// PATCH /auth/hidden-folders — 숨긴(삭제한) 기본 폴더 id 목록 저장
router.patch('/hidden-folders', requireAuth, async (req, res) => {
  const { hidden } = req.body;
  if (!Array.isArray(hidden)) return res.status(400).json({ error: 'hidden 배열이 필요합니다' });
  const clean = hidden.slice(0, 50).map((s) => String(s).slice(0, 40)).filter(Boolean);
  const { data: cur } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const meta = cur.user?.user_metadata || {};
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    user_metadata: { ...meta, hidden_folders: clean },
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ hidden_folders: clean });
});

// PATCH /auth/profile — 표시 이름/아이디 저장 (user_metadata)
router.patch('/profile', requireAuth, async (req, res) => {
  const { display_name, username } = req.body;
  const { data: cur } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const meta = cur.user?.user_metadata || {};
  const next = { ...meta };
  if (typeof display_name === 'string') next.display_name = display_name.trim().slice(0, 30);
  if (typeof username === 'string') next.username = username.trim().slice(0, 30);

  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    user_metadata: next,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ display_name: next.display_name || null, username: next.username || null });
});

// PATCH /auth/folders — 사용자가 만든 폴더 목록 저장 (user_metadata)
router.patch('/folders', requireAuth, async (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders 배열이 필요합니다' });

  const clean = folders.slice(0, 50).map((f) => ({
    id: String(f.id || '').slice(0, 40),
    name: String(f.name || '').slice(0, 30),
    emoji: String(f.emoji || '📁').slice(0, 8),
  })).filter((f) => f.id && f.name);

  const { data: cur } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const meta = cur.user?.user_metadata || {};
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    user_metadata: { ...meta, folders: clean },
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ folders: clean });
});

// PATCH /auth/theme — 선택한 테마를 user_metadata에 저장
router.patch('/theme', requireAuth, async (req, res) => {
  const { theme } = req.body;
  if (!theme) return res.status(400).json({ error: 'theme은 필수입니다' });

  const { data: cur } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const meta = cur.user?.user_metadata || {};
  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    user_metadata: { ...meta, theme },
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ theme });
});

// PATCH /auth/folder-covers — 폴더 커버 사진 저장 (user_metadata에 병합)
router.patch('/folder-covers', requireAuth, async (req, res) => {
  const { folder_id, photo_url } = req.body;
  if (!folder_id) return res.status(400).json({ error: 'folder_id는 필수입니다' });

  const { data: cur } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const meta = cur.user?.user_metadata || {};
  const covers = { ...(meta.folder_covers || {}) };
  if (photo_url) covers[folder_id] = photo_url;
  else delete covers[folder_id];

  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    user_metadata: { ...meta, folder_covers: covers },
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ folder_covers: covers });
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

// GET /auth/naver/diag — 네이버 secret 주입 여부 진단 (값 노출 안 함, 임시)
router.get('/naver/diag', (_req, res) => {
  res.json({
    client_id_tail: NAVER_CLIENT_ID.slice(-4),
    naver_secret_set: !!NAVER_CLIENT_SECRET,
    naver_secret_len: NAVER_CLIENT_SECRET.length,
    naver_env_raw: !!process.env.NAVER_CLIENT_SECRET,
    redirect_uri: NAVER_REDIRECT_URI,
  });
});

// GET /auth/naver/start — 네이버 인가 페이지로 리디렉트
router.get('/naver/start', (req, res) => {
  const ret = typeof req.query.return === 'string' ? req.query.return : APP_URL_DEFAULT;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: NAVER_CLIENT_ID,
    redirect_uri: NAVER_REDIRECT_URI,
    state: ret, // 네이버는 state 필수 (CSRF). 반환 URL을 겸해 전달.
  });
  res.redirect(`https://nid.naver.com/oauth2.0/authorize?${params.toString()}`);
});

// GET /auth/naver/callback — 네이버 code → Supabase 세션 발급 후 앱으로 리디렉트
router.get('/naver/callback', async (req, res) => {
  const { code, state, error: naverErr } = req.query;
  const appUrl =
    typeof state === 'string' && /^https?:\/\//.test(state) ? state : APP_URL_DEFAULT;
  const fail = (msg) => res.redirect(`${appUrl}?naver_error=${encodeURIComponent(msg)}`);

  try {
    if (naverErr) return fail(String(naverErr));
    if (!code) return fail('no_code');

    // 1) 인가 코드 → 네이버 액세스 토큰
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: NAVER_CLIENT_ID,
      client_secret: NAVER_CLIENT_SECRET,
      code: String(code),
      state: String(state || ''),
    });
    const tokRes = await fetch(`https://nid.naver.com/oauth2.0/token?${tokenParams.toString()}`, {
      method: 'POST',
    });
    const tok = await tokRes.json();
    if (!tok.access_token) return fail('token_' + (tok.error || tokRes.status));

    // 2) 네이버 프로필
    const meRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const me = await meRes.json();
    const prof = me.response;
    if (!prof || !prof.id) return fail('no_profile');
    const naverId = String(prof.id);
    const nickname = prof.nickname || prof.name || '네이버사용자';

    // 3) Supabase 사용자 확보 — 합성 이메일(네이버 id 해시로 유효성 보장) + 결정적 비밀번호
    const emailLocal = crypto.createHash('sha256').update(`naver:${naverId}`).digest('hex').slice(0, 24);
    const email = `naver_${emailLocal}@ping-diary.app`;
    const password = crypto
      .createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'ping-naver-secret')
      .update(`naver:${naverId}`)
      .digest('hex');

    await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { provider: 'naver', naver_id: naverId, nickname },
    });

    // 4) 결정적 비밀번호로 로그인해 세션 발급
    const { data: sess, error: signErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signErr || !sess?.session) return fail('signin_failed');

    // 5) 앱으로 토큰 전달 (해시 프래그먼트)
    const at = encodeURIComponent(sess.session.access_token);
    const rt = encodeURIComponent(sess.session.refresh_token);
    return res.redirect(`${appUrl}#naver_at=${at}&naver_rt=${rt}`);
  } catch (e) {
    return fail('exception');
  }
});

module.exports = router;
