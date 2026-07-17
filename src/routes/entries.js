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

// GET /entries/comments/inbox — 알림창용: 내 일기에 달린 댓글 + 내 댓글에 달린 답글 (최신 30개)
// 주의: '/:id/comments'보다 먼저 선언해야 한다
router.get('/comments/inbox', requireAuth, async (req, res) => {
  const uid = req.user.id;

  // 내 일기 id·제목 (알림 본문에 제목 표기용)
  const { data: myEntries, error: e1 } = await supabaseAdmin
    .from('diary_entries')
    .select('id, title')
    .eq('user_id', uid);
  if (e1) return res.status(500).json({ error: e1.message });
  const titleById = {};
  for (const r of myEntries || []) titleById[r.id] = r.title;
  const entryIds = Object.keys(titleById).map(Number);

  // 1) 내 일기에 남이 단 댓글
  let onMine = [];
  if (entryIds.length) {
    const { data } = await supabaseAdmin
      .from('diary_comments')
      .select('id, entry_id, user_id, content, created_at, parent_id, group_id')
      .in('entry_id', entryIds)
      .neq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(30);
    onMine = data || [];
  }

  // 2) 남의 일기에서 내 댓글에 달린 답글
  const { data: myComments } = await supabaseAdmin
    .from('diary_comments').select('id, entry_id, created_at').eq('user_id', uid);
  const myCommentIds = (myComments || []).map((r) => r.id);
  let replies = [];
  if (myCommentIds.length) {
    const { data } = await supabaseAdmin
      .from('diary_comments')
      .select('id, entry_id, user_id, content, created_at, parent_id, group_id')
      .in('parent_id', myCommentIds)
      .neq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(30);
    replies = data || [];
  }

  // 3) 내가 댓글 단 남의 일기에 다른 멤버가 이어서 단 댓글 (스레드 참여 알림)
  // 내가 처음 댓글 단 시각 이후의 것만 — 그 전 댓글은 댓글 달 때 이미 봤다
  const firstMineByEntry = {};
  for (const c of myComments || []) {
    if (titleById[c.entry_id] !== undefined) continue; // 내 일기는 1)에서 커버
    if (!firstMineByEntry[c.entry_id] || c.created_at < firstMineByEntry[c.entry_id]) {
      firstMineByEntry[c.entry_id] = c.created_at;
    }
  }
  const threadEntryIds = Object.keys(firstMineByEntry).map(Number);
  let thread = [];
  if (threadEntryIds.length) {
    const { data } = await supabaseAdmin
      .from('diary_comments')
      .select('id, entry_id, user_id, content, created_at, parent_id, group_id')
      .in('entry_id', threadEntryIds)
      .neq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(30);
    // 그룹 스코프: 내가 속한 그룹의 댓글만 (레거시 null은 모두에게 보임)
    const mineGroups = await myGroupIds(uid);
    thread = (data || []).filter(
      (c) => c.created_at > firstMineByEntry[c.entry_id]
        && (c.group_id == null || mineGroups.includes(c.group_id))
    );
  }

  // 합치기 — 겹치는 항목(내 댓글의 답글이 스레드에도 잡히는 등)은 앞선 이유가 우선
  const seen = new Set();
  const merged = [
    ...onMine.map((c) => ({ ...c, reason: 'on_my_entry' })),
    ...replies.map((c) => ({ ...c, reason: 'reply' })),
    ...thread.map((c) => ({ ...c, reason: 'thread' })),
  ]
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 30);

  // 작성자 표시 정보 + 일기 제목 동봉 (남의 일기 제목은 개별 조회)
  const infoCache = {};
  const rows = [];
  for (const c of merged) {
    if (!infoCache[c.user_id]) infoCache[c.user_id] = await authorInfo(c.user_id);
    let title = titleById[c.entry_id];
    if (title === undefined) {
      const { data: e } = await supabaseAdmin
        .from('diary_entries').select('title').eq('id', c.entry_id).single();
      title = e?.title || '';
    }
    rows.push({
      ...c,
      author: infoCache[c.user_id].name,
      author_avatar: infoCache[c.user_id].avatar_url,
      entry_title: title || '',
    });
  }
  res.json(rows);
});

// GET /entries/:id/comments — 댓글 목록 (일기 접근 권한 필요)
router.get('/:id/comments', requireAuth, async (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) return res.status(400).json({ error: '유효한 일기 id가 필요합니다' });
  const { allowed } = await canAccessEntry(req.user.id, entryId);
  if (!allowed) return res.status(403).json({ error: '이 일기의 댓글을 볼 수 없습니다' });

  // photo_url 컬럼 미적용 DB(마이그레이션 전) 호환: 스키마 에러면 없이 재시도
  let { data, error } = await supabaseAdmin
    .from('diary_comments')
    .select('id, entry_id, user_id, content, created_at, parent_id, group_id, photo_url')
    .eq('entry_id', entryId)
    .order('created_at', { ascending: true });
  if (error && /photo_url/.test(error.message)) {
    ({ data, error } = await supabaseAdmin
      .from('diary_comments')
      .select('id, entry_id, user_id, content, created_at, parent_id, group_id')
      .eq('entry_id', entryId)
      .order('created_at', { ascending: true }));
  }
  if (error) return res.status(500).json({ error: error.message });

  // 그룹 스코프: 일기 주인은 전부, 그 외에는 자기가 속한 그룹의 댓글만
  // (group_id가 null인 레거시 댓글은 기존처럼 모두에게 보임)
  let visible = data || [];
  const { entry: entryRow } = await canAccessEntry(req.user.id, entryId);
  if (entryRow && entryRow.user_id !== req.user.id) {
    const mine = await myGroupIds(req.user.id);
    visible = visible.filter((c) => c.group_id == null || mine.includes(c.group_id));
  }

  // 작성자 정보는 중복 없이 모아 병렬 조회
  const uids = [...new Set(visible.map((c) => c.user_id))];
  const infoCache = {};
  await Promise.all(uids.map(async (uid) => { infoCache[uid] = await authorInfo(uid); }));
  const rows = visible.map((c) => ({
    ...c,
    author: infoCache[c.user_id].name,
    author_avatar: infoCache[c.user_id].avatar_url,
    is_me: c.user_id === req.user.id,
  }));
  res.json(rows);
});

// POST /entries/:id/comments — 댓글 작성
router.post('/:id/comments', requireAuth, async (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(entryId)) return res.status(400).json({ error: '유효한 일기 id가 필요합니다' });
  const content = String(req.body?.content ?? '').trim();
  // 사진 첨부: 우리 스토리지 공개 URL만 허용 (임의 외부 이미지 주입 방지)
  let photoUrl = null;
  if (typeof req.body?.photo_url === 'string' && req.body.photo_url.trim()) {
    const u = req.body.photo_url.trim();
    const allowedPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/photos/`;
    if (!u.startsWith(allowedPrefix)) return res.status(400).json({ error: '유효한 사진이 아니에요' });
    photoUrl = u.slice(0, 500);
  }
  if (!content && !photoUrl) return res.status(400).json({ error: '댓글 내용을 입력해 주세요' });
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

  // 댓글이 속할 그룹 결정 — 답글은 루트 댓글의 그룹을 상속, 원댓글은 요청값(검증) 또는 추론
  let groupId = null;
  if (parentId !== null) {
    const { data: root } = await supabaseAdmin
      .from('diary_comments').select('group_id').eq('id', parentId).single();
    groupId = root?.group_id ?? null;
  } else {
    const mine = await myGroupIds(req.user.id);
    const shared = Array.isArray(entry.shared_groups) ? entry.shared_groups : [];
    const candidates = shared.filter((g) => mine.includes(g));
    const requested = req.body?.group_id != null ? parseInt(req.body.group_id, 10) : null;
    if (requested != null && candidates.includes(requested)) groupId = requested;
    else groupId = candidates[0] ?? null; // 구버전 앱(group_id 미전송) 호환: 겹치는 첫 그룹
  }

  // 내 일기에는 '원댓글'만 금지 — 남이 단 댓글에 답글로 대화를 잇는 건 허용
  if (entry.user_id === req.user.id && parentId === null) {
    return res.status(403).json({ error: '내 일기에는 댓글을 쓸 수 없어요' });
  }

  // photo_url 컬럼 미적용 DB(마이그레이션 전) 호환: 스키마 에러면 없이 재시도
  let { data, error } = await supabaseAdmin
    .from('diary_comments')
    .insert({ entry_id: entryId, user_id: req.user.id, content, parent_id: parentId, group_id: groupId, photo_url: photoUrl })
    .select('id, entry_id, user_id, content, created_at, parent_id, group_id, photo_url')
    .single();
  if (error && /photo_url/.test(error.message)) {
    ({ data, error } = await supabaseAdmin
      .from('diary_comments')
      .insert({ entry_id: entryId, user_id: req.user.id, content, parent_id: parentId, group_id: groupId })
      .select('id, entry_id, user_id, content, created_at, parent_id, group_id')
      .single());
  }
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
    // 이 일기에서 대화에 참여한(댓글 단) 멤버들에게도 — 그룹 댓글이면 그 그룹 멤버로 제한
    const { data: participants } = await supabaseAdmin
      .from('diary_comments').select('user_id').eq('entry_id', entryId);
    let partIds = [...new Set((participants || []).map((p) => p.user_id))]
      .filter((id) => id !== req.user.id);
    if (groupId != null && partIds.length) {
      const { data: members } = await supabaseAdmin
        .from('group_members').select('user_id').eq('group_id', groupId).in('user_id', partIds);
      partIds = (members || []).map((m) => m.user_id);
    }
    partIds.forEach((id) => targets.add(id));
    for (const ownerId of targets) {
      notifyEntryComment({ ownerId, commenterName: info.name, entryTitle: e?.title || '', comment: content || '(사진)', entryId });
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

// GET /entries — 내 일기 목록 (댓글 수 포함 — 주인은 모든 그룹의 댓글을 셈)
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('diary_entries')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const ids = (data || []).map((e) => e.id);
  const commentCount = {};
  if (ids.length) {
    const { data: cs } = await supabaseAdmin
      .from('diary_comments')
      .select('entry_id')
      .in('entry_id', ids);
    for (const c of cs || []) commentCount[c.entry_id] = (commentCount[c.entry_id] || 0) + 1;
  }
  res.json((data || []).map((e) => ({ ...e, comment_count: commentCount[e.id] || 0 })));
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
    notifyGroupsNewEntry({ authorId: req.user.id, groupIds: safeSharedGroups, entryTitle: title, entryId: data.id });
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
    // 페르소나별 p0ng 캐시 — 이미 이 말투로 받아봤다면 다시 생성하지 않고 그대로 복원
    // (페르소나 1→2→1로 오가도 1의 멘트가 유지되고, 생성 비용도 아낀다)
    const cache = entry.ai_comments && typeof entry.ai_comments === 'object' ? entry.ai_comments : {};
    const aiComment = cache[persona]
      || await generateComment(entry.content, persona, { title: entry.title, tags: entry.tags });
    const { data, error } = await req.supabase
      .from('diary_entries')
      .update({ ai_comment: aiComment, persona, ai_comments: { ...cache, [persona]: aiComment } })
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
      entryId: data.id,
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
