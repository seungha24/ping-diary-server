const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// RLS를 우회해 그룹 전체 멤버를 집계하기 위한 관리자 클라이언트
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// GET /groups — 내가 속한 그룹 목록 (멤버 수 포함)
router.get('/', requireAuth, async (req, res) => {
  const { data: memberships } = await req.supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', req.user.id);

  const ids = (memberships || []).map((m) => m.group_id);
  if (!ids.length) return res.json([]);

  // groups는 관리자 클라이언트로 조회하되 '내가 속한 id'로만 제한 (초대코드 직접 노출 차단)
  const { data: groups, error } = await supabaseAdmin
    .from('groups')
    .select('*')
    .in('id', ids)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // 각 그룹의 멤버 수 계산 (RLS 우회 위해 관리자 클라이언트 사용)
  const result = [];
  for (const g of groups) {
    const { count } = await supabaseAdmin
      .from('group_members')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', g.id);
    result.push({ ...g, member_count: count ?? 1 });
  }
  res.json(result);
});

// POST /groups — 그룹 생성
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '그룹 이름은 필수입니다' });

  const invite_code = randomCode();

  const { data: group, error } = await supabaseAdmin
    .from('groups')
    .insert({ name, invite_code })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // 생성자를 멤버로 자동 추가
  await supabaseAdmin.from('group_members').insert({ group_id: group.id, user_id: req.user.id });

  res.status(201).json(group);
});

// POST /groups/join — 초대 코드로 참여
router.post('/join', requireAuth, async (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'invite_code는 필수입니다' });

  // 초대코드 조회는 관리자 클라이언트로 (사용자가 groups를 직접 못 읽으므로)
  const { data: group } = await supabaseAdmin
    .from('groups')
    .select('*')
    .eq('invite_code', invite_code.toUpperCase())
    .single();

  if (!group) return res.status(404).json({ error: '유효하지 않은 초대 코드입니다' });

  // 멱등 참여: unique(group_id, user_id) 제약 + upsert라 동시 요청(더블탭)에도 중복 행 없음
  const { error: joinError } = await supabaseAdmin
    .from('group_members')
    .upsert(
      { group_id: group.id, user_id: req.user.id },
      { onConflict: 'group_id,user_id', ignoreDuplicates: true }
    );
  if (joinError) return res.status(500).json({ error: joinError.message });

  res.json({ id: group.id, name: group.name });
});

// GET /groups/:id/entries — 그룹 일기 조회
router.get('/:id/entries', requireAuth, async (req, res) => {
  // id는 정수만 허용 (아래 .or() 필터 문자열에 그대로 들어가므로 선검증)
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isFinite(groupId)) return res.status(400).json({ error: '유효한 그룹 id가 필요합니다' });

  // 멤버 확인
  const { data: membership } = await req.supabase
    .from('group_members')
    .select('id')
    .eq('group_id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (!membership) return res.status(403).json({ error: '그룹 멤버만 조회할 수 있습니다' });

  // 멤버들의 friends 공개 일기 조회 (전체 멤버 조회는 RLS 우회 위해 관리자 클라이언트 사용)
  const { data: members } = await supabaseAdmin
    .from('group_members')
    .select('user_id')
    .eq('group_id', req.params.id);

  // 내가 차단한 사용자 목록 → 그들의 글은 제외 (신고/차단 기능)
  let blocked = [];
  try {
    const { data: me } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
    blocked = me?.user?.user_metadata?.blocked_users || [];
  } catch (_) {}

  const memberIds = members.map(m => m.user_id).filter((id) => !blocked.includes(id));
  if (memberIds.length === 0) return res.json([]);

  // shared_groups가 null이면 모든 그룹에 공개(기존 동작), 배열이면 이 그룹이 포함된 글만
  const { data, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, user_id, content, photo_url, photos, created_at, title, tags, dates, persona, ai_comment, shared_groups')
    .in('user_id', memberIds)
    .eq('visibility', 'friends')
    .or(`shared_groups.is.null,shared_groups.cs.{${groupId}}`)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // 작성자 표시용: user_id → 표시이름/닉네임(없으면 이메일 앞부분) + 프로필 사진
  const authorMap = {};
  const avatarMap = {};
  for (const uid of memberIds) {
    try {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
      const m = u?.user?.user_metadata || {};
      authorMap[uid] = m.display_name || m.nickname || (u?.user?.email ? u.user.email.split('@')[0] : '멤버');
      avatarMap[uid] = m.avatar_url || null;
    } catch (_) {}
  }
  const enriched = (data || []).map((e) => ({
    ...e,
    author: authorMap[e.user_id] || '멤버',
    author_avatar: avatarMap[e.user_id] || null,
  }));
  res.json(enriched);
});

// PATCH /groups/:id/photo — 그룹 커버 사진 변경 (멤버만, 전체 멤버 공유)
router.patch('/:id/photo', requireAuth, async (req, res) => {
  const { photo_url } = req.body;

  // 멤버 확인
  const { data: membership } = await req.supabase
    .from('group_members')
    .select('id')
    .eq('group_id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (!membership) return res.status(403).json({ error: '그룹 멤버만 변경할 수 있습니다' });

  const { data, error } = await supabaseAdmin
    .from('groups')
    .update({ photo_url: photo_url || null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /groups/:id/leave — 그룹 나가기 (본인 멤버십만 삭제, RLS 우회)
router.post('/:id/leave', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('group_members')
    .delete()
    .eq('group_id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// PATCH /groups/:id — 그룹 이름 수정 (멤버만)
router.patch('/:id', requireAuth, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '그룹 이름은 필수입니다' });

  const { data: membership } = await supabaseAdmin
    .from('group_members')
    .select('user_id')
    .eq('group_id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!membership) return res.status(403).json({ error: '이 그룹의 멤버만 수정할 수 있습니다' });

  const { data, error } = await supabaseAdmin
    .from('groups')
    .update({ name })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /groups/:id — 그룹 삭제 (멤버만 가능). 멤버 전원 제거 후 그룹 삭제.
router.delete('/:id', requireAuth, async (req, res) => {
  // 요청자가 이 그룹의 멤버인지 확인
  const { data: membership } = await supabaseAdmin
    .from('group_members')
    .select('user_id')
    .eq('group_id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!membership) return res.status(403).json({ error: '이 그룹의 멤버만 삭제할 수 있습니다' });

  // 멤버 관계 먼저 제거 후 그룹 삭제 (FK 제약 회피)
  await supabaseAdmin.from('group_members').delete().eq('group_id', req.params.id);
  const { error } = await supabaseAdmin.from('groups').delete().eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
