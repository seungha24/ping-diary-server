const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { generateComment, generateMonthlyReport } = require('../aiComment');

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
    shared_groups = null, // 공유할 그룹 id 목록 (null이면 모든 그룹)
    photos = [],          // 추가 사진 URL 목록 (대표는 photo_url, 최대 3)
    created_at = null,    // 일기 날짜 (달력에서 고른 날짜, 없으면 서버 기본=지금)
  } = req.body;
  if (!content) return res.status(400).json({ error: 'content는 필수입니다' });

  const createdAt = created_at && !isNaN(Date.parse(created_at)) ? created_at : null;
  const { data, error } = await req.supabase
    .from('diary_entries')
    .insert({
      user_id: req.user.id, content, visibility, photo_url,
      title, tags, dates, persona, folder, shared_groups,
      photos: Array.isArray(photos) ? photos.slice(0, 3) : [],
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // AI 코멘트는 24시간 후 스케줄러가 생성
  res.status(201).json(data);
});

// GET /entries/:id — 단건 조회 (AI 코멘트 polling용)
// GET /entries/report?year=2026&month=7 — 한 달 기록 AI 심층 리포트
// ':id' 라우트보다 앞에 있어야 'report'가 id로 잡히지 않는다.
router.get('/report', requireAuth, async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10); // 1~12
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month(1~12)가 필요합니다' });
  }

  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const end = new Date(Date.UTC(year, month, 1)).toISOString();
  const { data: rows, error } = await req.supabase
    .from('diary_entries')
    .select('title, content, created_at')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  if (!rows || rows.length === 0) return res.json({ report: null, count: 0 });

  try {
    const items = rows.map((r) => ({
      date: `${month}월 ${new Date(r.created_at).getUTCDate()}일`,
      title: r.title,
      content: (r.content || '').slice(0, 500), // 프롬프트 과대 방지
    }));
    const report = await generateMonthlyReport(`${year}년 ${month}월`, items);
    res.json({ report, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: 'AI 리포트 생성 실패: ' + e.message });
  }
});

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

  // 본문에 persona가 오면 그 말투로 다시 생성하고, 바뀐 페르소나를 일기에도 저장한다.
  const persona = typeof req.body.persona === 'string' && req.body.persona.trim()
    ? req.body.persona.trim()
    : entry.persona;

  try {
    const aiComment = await generateComment(entry.content, persona, { title: entry.title, tags: entry.tags });
    const { data, error } = await req.supabase
      .from('diary_entries')
      .update({ ai_comment: aiComment, persona })
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
  const allowed = ['content', 'visibility', 'photo_url', 'title', 'tags', 'dates', 'persona', 'folder', 'shared_groups', 'photos'];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  // 일기 날짜 변경 (유효한 날짜 문자열일 때만)
  if (req.body.created_at && !isNaN(Date.parse(req.body.created_at))) {
    patch.created_at = req.body.created_at;
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
