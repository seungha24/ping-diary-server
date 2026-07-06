const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { generateComment } = require('../aiComment');

// GET /entries — 내 일기 목록
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('diary_entries')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /entries — 일기 작성
router.post('/', requireAuth, async (req, res) => {
  const {
    content, visibility = 'private', photo_url = null,
    title = '', tags = [], dates = [], persona = '', folder = '',
  } = req.body;
  if (!content) return res.status(400).json({ error: 'content는 필수입니다' });

  const { data, error } = await req.supabase
    .from('diary_entries')
    .insert({
      user_id: req.user.id, content, visibility, photo_url,
      title, tags, dates, persona, folder,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // AI 코멘트는 24시간 후 스케줄러가 생성
  res.status(201).json(data);
});

// GET /entries/:id — 단건 조회 (AI 코멘트 polling용)
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('diary_entries')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: '일기를 찾을 수 없습니다' });
  res.json(data);
});

// POST /entries/:id/comment — AI 코멘트 즉시 생성 (본인 것만, 데모/미리보기용)
router.post('/:id/comment', requireAuth, async (req, res) => {
  const { data: entry } = await req.supabase
    .from('diary_entries')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!entry) return res.status(404).json({ error: '일기를 찾을 수 없습니다' });
  if (entry.user_id !== req.user.id) return res.status(403).json({ error: '본인의 일기만 가능합니다' });

  try {
    const aiComment = await generateComment(entry.content, entry.persona);
    const { data, error } = await req.supabase
      .from('diary_entries')
      .update({ ai_comment: aiComment })
      .eq('id', entry.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'AI 코멘트 생성 실패: ' + e.message });
  }
});

// PATCH /entries/:id — 일기 수정 (본인 것만)
router.patch('/:id', requireAuth, async (req, res) => {
  const { data: entry } = await req.supabase
    .from('diary_entries')
    .select('user_id')
    .eq('id', req.params.id)
    .single();

  if (!entry) return res.status(404).json({ error: '일기를 찾을 수 없습니다' });
  if (entry.user_id !== req.user.id) return res.status(403).json({ error: '본인의 일기만 수정할 수 있습니다' });

  // 허용된 필드만 반영
  const allowed = ['content', 'visibility', 'photo_url', 'title', 'tags', 'dates', 'persona', 'folder'];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }

  const { data, error } = await req.supabase
    .from('diary_entries')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /entries/:id — 일기 삭제
router.delete('/:id', requireAuth, async (req, res) => {
  const { data: entry } = await req.supabase
    .from('diary_entries')
    .select('user_id')
    .eq('id', req.params.id)
    .single();

  if (!entry) return res.status(404).json({ error: '일기를 찾을 수 없습니다' });
  if (entry.user_id !== req.user.id) return res.status(403).json({ error: '본인의 일기만 삭제할 수 있습니다' });

  await req.supabase.from('diary_entries').delete().eq('id', req.params.id);
  res.status(204).send();
});

module.exports = router;
