const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getUserInfoCached } = require('../userCache');
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
  // 멤버 수는 한 번에 조회해 그룹별 집계 (그룹 수만큼 왕복하던 것 제거)
  const { data: allMembers } = await supabaseAdmin
    .from('group_members')
    .select('group_id')
    .in('group_id', ids);
  const countMap = {};
  for (const m of allMembers || []) countMap[m.group_id] = (countMap[m.group_id] || 0) + 1;
  res.json(groups.map((g) => ({ ...g, member_count: countMap[g.id] ?? 1 })));
});

// POST /groups — 그룹 생성
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '그룹 이름은 필수입니다' });

  const invite_code = randomCode();

  let { data: group, error } = await supabaseAdmin
    .from('groups')
    .insert({ name, invite_code, created_by: req.user.id }) // 만든 사람 = 방장
    .select()
    .single();

  // created_by 컬럼이 아직 없는 DB(마이그레이션 전)에서도 생성은 되도록 폴백
  if (error && /created_by/i.test(error.message)) {
    ({ data: group, error } = await supabaseAdmin
      .from('groups')
      .insert({ name, invite_code })
      .select()
      .single());
  }

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

// GET /groups/:id/members — 그룹 멤버 목록 (이름·아이디·프사·방장 표시)
router.get('/:id/members', requireAuth, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isFinite(groupId)) return res.status(400).json({ error: '유효한 그룹 id가 필요합니다' });

  // 멤버만 조회 가능
  const { data: membership } = await req.supabase
    .from('group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', req.user.id)
    .single();
  if (!membership) return res.status(403).json({ error: '그룹 멤버만 조회할 수 있습니다' });

  const { data: group } = await supabaseAdmin
    .from('groups')
    .select('created_by')
    .eq('id', groupId)
    .single();

  const { data: members, error } = await supabaseAdmin
    .from('group_members')
    .select('user_id, created_at')
    .eq('group_id', groupId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const result = await Promise.all((members || []).map(async (m) => {
    const info = await getUserInfoCached(m.user_id);
    return {
      id: m.user_id,
      name: info.name,
      username: info.username,
      avatar_url: info.avatar_url,
      is_owner: group?.created_by === m.user_id,
      is_me: req.user.id === m.user_id,
    };
  }));
  res.json(result);
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

  // 이 그룹이 shared_groups에 명시된 글만 (null 레거시는 마이그레이션으로 확정됨 — 새 그룹 가입 시 과거 글 유입 방지)
  const { data, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, user_id, content, photo_url, photos, created_at, title, tags, dates, persona, ai_comment, shared_groups')
    .in('user_id', memberIds)
    .eq('visibility', 'friends')
    .contains('shared_groups', [groupId])
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // 작성자 표시용: user_id → 표시이름/닉네임(없으면 이메일 앞부분) + 프로필 사진
  const authorMap = {};
  const avatarMap = {};
  // 사용자 정보는 인메모리 캐시(5분)로 — 두 번째 요청부터는 왕복 없음
  await Promise.all(memberIds.map(async (uid) => {
    const info = await getUserInfoCached(uid);
    authorMap[uid] = info.name;
    avatarMap[uid] = info.avatar_url;
  }));
  // 카드에 표시할 댓글 수 — 이 그룹에서 보이는 댓글(이 그룹 소속 + 레거시 공용)만 집계
  const entryIds = (data || []).map((e) => e.id);
  const commentCount = {};
  if (entryIds.length) {
    const { data: cs } = await supabaseAdmin
      .from('diary_comments')
      .select('entry_id, group_id')
      .in('entry_id', entryIds);
    for (const c of cs || []) {
      if (c.group_id == null || c.group_id === groupId) {
        commentCount[c.entry_id] = (commentCount[c.entry_id] || 0) + 1;
      }
    }
  }

  const enriched = (data || []).map((e) => ({
    ...e,
    comment_count: commentCount[e.id] || 0,
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

// DELETE /groups/:id — 그룹 삭제 (방장만 가능). 멤버 전원 제거 후 그룹 삭제.
router.delete('/:id', requireAuth, async (req, res) => {
  const { data: group } = await supabaseAdmin
    .from('groups')
    .select('created_by')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!group) return res.status(404).json({ error: '그룹을 찾을 수 없습니다' });
  if (group.created_by && group.created_by !== req.user.id) {
    return res.status(403).json({ error: '그룹을 만든 사람만 삭제할 수 있어요' });
  }
  // created_by가 비어있는 레거시 그룹은 기존처럼 멤버면 삭제 가능 (백필 SQL 실행 후엔 도달 안 함)
  if (!group.created_by) {
    const { data: membership } = await supabaseAdmin
      .from('group_members')
      .select('user_id')
      .eq('group_id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!membership) return res.status(403).json({ error: '이 그룹의 멤버만 삭제할 수 있습니다' });
  }

  // 멤버 관계 먼저 제거 후 그룹 삭제 (FK 제약 회피)
  await supabaseAdmin.from('group_members').delete().eq('group_id', req.params.id);
  const { error } = await supabaseAdmin.from('groups').delete().eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
