const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const { generateComment, generateMonthlyReport, generateMonthlyAwards } = require('../aiComment');
const { notifyGroupsNewEntry, notifyEntryComment } = require('../push');

// 멤버십 검증용 관리자 클라이언트 (group_members는 RLS로 잠겨 있음)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/** 작성자가 현재 속한 그룹 id 목록 */
async function myGroupIds(userId) {
  const { data } = await supabaseAdmin
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId);
  return (data || []).map((m) => m.group_id);
}

/**
 * 클라이언트가 보낸 shared_groups를 작성자가 실제 속한 그룹으로 제한한다.
 * (그룹 id는 순차 정수라, 검증 없이는 임의 그룹 전원에게 푸시를 쏠 수 있음)
 * null("전체 공개")은 '작성 시점에 속한 그룹 전체' 스냅샷으로 확정한다 —
 * null을 그대로 두면 나중에 가입한 그룹에도 과거 일기가 새어 들어간다.
 */
async function sanitizeSharedGroups(userId, sharedGroups) {
  if (sharedGroups === null || sharedGroups === undefined) return myGroupIds(userId);
  if (!Array.isArray(sharedGroups)) return [];
  const ids = sharedGroups.map((v) => parseInt(v, 10)).filter(Number.isFinite);
  if (!ids.length) return [];
  const { data } = await supabaseAdmin
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .in('group_id', ids);
  const mine = new Set((data || []).map((m) => m.group_id));
  return ids.filter((id) => mine.has(id));
}

/** 이 일기를 볼 수 있는가: 내 글이거나, 나와 공유 그룹이 겹치는 friends 공개 글 */
async function canAccessEntry(userId, entryId) {
  const { data: entry } = await supabaseAdmin
    .from('diary_entries')
    .select('id, user_id, visibility, shared_groups')
    .eq('id', entryId)
    .single();
  if (!entry) return { entry: null, allowed: false };
  if (entry.user_id === userId) return { entry, allowed: true };
  if (entry.visibility !== 'friends' || !Array.isArray(entry.shared_groups) || !entry.shared_groups.length) {
    return { entry, allowed: false };
  }
  const mine = await myGroupIds(userId);
  const allowed = entry.shared_groups.some((g) => mine.includes(g));
  return { entry, allowed };
}

/** user_id → 표시 이름/프사 (댓글 표시용) */
async function authorInfo(uid) {
  try {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
    const m = u?.user?.user_metadata || {};
    return {
      name: m.display_name || m.nickname || (u?.user?.email ? u.user.email.split('@')[0] : '멤버'),
      avatar_url: m.avatar_url || null,
    };
  } catch (_) {
    return { name: '멤버', avatar_url: null };
  }
}

// GET /entries/:id/comments — 댓글 목록 (일기 접근 권한 필요)
router.get('/:id/comments', requireAuth, async (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) return res.status(400).json({ error: '유효한 일기 id가 필요합니다' });
  const { allowed } = await canAccessEntry(req.user.id, entryId);
  if (!allowed) return res.status(403).json({ error: '이 일기의 댓글을 볼 수 없습니다' });

  const { data, error } = await supabaseAdmin
    .from('diary_comments')
    .select('id, entry_id, user_id, content, created_at, parent_id')
    .eq('entry_id', entryId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // 작성자 정보는 중복 조회 없이 캐시
  const infoCache = {};
  const rows = [];
  for (const c of data || []) {
    if (!infoCache[c.user_id]) infoCache[c.user_id] = await authorInfo(c.user_id);
    rows.push({ ...c, author: infoCache[c.user_id].name, author_avatar: infoCache[c.user_id].avatar_url, is_me: c.user_id === req.user.id });
  }
  res.json(rows);
});

// POST /entries/:id/comments — 댓글 작성
router.post('/:id/comments', requireAuth, async (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) return res.status(400).json({ error: '유효한 일기 id가 필요합니다' });
  const content = String(req.body?.content ?? '').trim();
  if (!content) return res.status(400).json({ error: '댓글 내용을 입력해 주세요' });
  if (content.length > 500) return res.status(400).json({ error: '댓글은 500자까지 쓸 수 있어요' });

  const { entry, allowed } = await canAccessEntry(req.user.id, entryId);
  if (!allowed) return res.status(403).json({ error: '이 일기에 댓글을 쓸 수 없습니다' });

  // 답글이면 부모 검증 — 깊이는 1단계로 고정 (답글의 답글은 같은 스레드의 루트에 붙임)
  let parentId = null;
  if (req.body?.parent_id != null) {
    const pid = parseInt(req.body.parent_id, 10);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: '유효한 부모 댓글 id가 필요합니다' });
    const { data: parent } = await supabaseAdmin
      .from('diary_comments')
      .select('id, parent_id, entry_id')
      .eq('id', pid)
      .eq('entry_id', entryId)
      .single();
    if (!parent) return res.status(404).json({ error: '답글을 달 댓글을 찾을 수 없어요' });
    parentId = parent.parent_id ?? parent.id;
  }

  // 내 일기에는 '원댓글'만 금지 — 남이 단 댓글에 답글로 대화를 잇는 건 허용
  if (entry.user_id === req.user.id && parentId === null) {
    return res.status(403).json({ error: '내 일기에는 댓글을 쓸 수 없어요' });
  }

  const { data, error } = await supabaseAdmin
    .from('diary_comments')
    .insert({ entry_id: entryId, user_id: req.user.id, content, parent_id: parentId })
    .select('id, entry_id, user_id, content, created_at, parent_id')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const info = await authorInfo(req.user.id);
  // 푸시: 일기 주인 + (답글이면) 원댓글 작성자에게. 자기 자신에게는 보내지 않는다.
  // 응답을 막지 않게 비동기로 처리
  (async () => {
    const { data: e } = await supabaseAdmin.from('diary_entries').select('title').eq('id', entryId).single();
    const targets = new Set();
    if (entry.user_id !== req.user.id) targets.add(entry.user_id);
    if (parentId !== null) {
      const { data: parent } = await supabaseAdmin
        .from('diary_comments').select('user_id').eq('id', parentId).single();
      if (parent && parent.user_id !== req.user.id) targets.add(parent.user_id);
    }
    for (const ownerId of targets) {
      notifyEntryComment({ ownerId, commenterName: info.name, entryTitle: e?.title || '', comment: content });
    }
  })().catch(() => {});
  res.status(201).json({ ...data, author: info.name, author_avatar: info.avatar_url, is_me: true });
});

// DELETE /entries/:id/comments/:commentId — 내 댓글이거나 내 일기의 댓글이면 삭제
router.delete('/:id/comments/:commentId', requireAuth, async (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (!Number.isFinite(entryId) || !Number.isFinite(commentId)) {
    return res.status(400).json({ error: '유효한 id가 필요합니다' });
  }
  const { data: comment } = await supabaseAdmin
    .from('diary_comments')
    .select('id, user_id, entry_id')
    .eq('id', commentId)
    .eq('entry_id', entryId)
    .single();
  if (!comment) return res.status(404).json({ error: '댓글을 찾을 수 없습니다' });

  const { entry } = await canAccessEntry(req.user.id, entryId);
  const isMyComment = comment.user_id === req.user.id;
  const isMyEntry = entry && entry.user_id === req.user.id;
  if (!isMyComment && !isMyEntry) return res.status(403).json({ error: '삭제 권한이 없습니다' });

  const { error } = await supabaseAdmin.from('diary_comments').delete().eq('id', commentId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

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
  // 내가 속한 그룹으로만 공유 대상 제한 (임의 그룹 푸시 스팸 방지)
  const safeSharedGroups = await sanitizeSharedGroups(req.user.id, shared_groups);
  const { data, error } = await req.supabase
    .from('diary_entries')
    .insert({
      user_id: req.user.id, content, visibility, photo_url,
      title, tags, dates, persona, folder, shared_groups: safeSharedGroups,
      photos: Array.isArray(photos) ? photos.slice(0, 3) : [],
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // 그룹에 공개한 글이면 멤버들에게 푸시 (응답을 막지 않도록 대기하지 않음)
  if (visibility === 'friends') {
    notifyGroupsNewEntry({ authorId: req.user.id, groupIds: safeSharedGroups, entryTitle: title });
  }

  // AI 코멘트는 10시간 후 스케줄러가 생성 (scheduler.js COMMENT_DELAY_HOURS)
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

// GET /entries/awards?year=2026&month=7 — 월말 p!ng 어워즈 (페르소나 심사위원 시상식)
router.get('/awards', requireAuth, async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10); // 1~12
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month(1~12)가 필요합니다' });
  }

  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const end = new Date(Date.UTC(year, month, 1)).toISOString();
  const { data: rows, error } = await req.supabase
    .from('diary_entries')
    .select('id, title, content, created_at')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  if (!rows || rows.length === 0) return res.json({ awards: [], closing: null, count: 0 });

  try {
    const items = rows.map((r) => ({
      id: r.id,
      date: `${month}월 ${new Date(r.created_at).getUTCDate()}일`,
      title: r.title,
      content: (r.content || '').slice(0, 500),
    }));
    const result = await generateMonthlyAwards(`${year}년 ${month}월`, items);
    res.json({ ...result, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: 'p0ng 생성 실패: ' + e.message });
  }
});

// PATCH /entries/:id — 일기 수정 (본인 것만)
router.patch('/:id', requireAuth, async (req, res) => {
  const { data: entry } = await req.supabase
    .from('diary_entries')
    .select('user_id, visibility, title')
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
  // 공유 대상은 내가 속한 그룹으로만 제한 (임의 그룹 푸시 스팸 방지)
  if (patch.shared_groups !== undefined) {
    patch.shared_groups = await sanitizeSharedGroups(req.user.id, patch.shared_groups);
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

  // 비공개 → 그룹 공개로 바뀐 순간에만 푸시 (이미 공개된 글 수정은 알리지 않음)
  if (entry.visibility !== 'friends' && data.visibility === 'friends') {
    notifyGroupsNewEntry({
      authorId: req.user.id,
      groupIds: data.shared_groups,
      entryTitle: data.title || entry.title,
    });
  }
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
