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

  const { data: groups, error } = await req.supabase
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

  const { data: group, error } = await req.supabase
    .from('groups')
    .insert({ name, invite_code })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // 생성자를 멤버로 자동 추가
  await req.supabase.from('group_members').insert({ group_id: group.id, user_id: req.user.id });

  res.status(201).json(group);
});

// POST /groups/join — 초대 코드로 참여
router.post('/join', requireAuth, async (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'invite_code는 필수입니다' });

  const { data: group } = await req.supabase
    .from('groups')
    .select('*')
    .eq('invite_code', invite_code.toUpperCase())
    .single();

  if (!group) return res.status(404).json({ error: '유효하지 않은 초대 코드입니다' });

  await req.supabase
    .from('group_members')
    .upsert({ group_id: group.id, user_id: req.user.id });

  res.json({ id: group.id, name: group.name });
});

// GET /groups/:id/entries — 그룹 일기 조회
router.get('/:id/entries', requireAuth, async (req, res) => {
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

  const memberIds = members.map(m => m.user_id);

  const { data, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, user_id, content, photo_url, created_at')
    .in('user_id', memberIds)
    .eq('visibility', 'friends')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
