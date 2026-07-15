// Expo 푸시 알림 발송 (그룹 새 글)
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * 그룹 멤버(작성자 제외)에게 새 글 푸시를 보낸다.
 * 실패해도 throw하지 않는다 — 글 저장 흐름을 막으면 안 되기 때문.
 * @param {{ authorId: string, groupIds: number[]|null, entryTitle?: string, entryId?: number }} p
 *   groupIds가 null이면 작성자가 속한 모든 그룹에 공개된 것으로 본다.
 */
async function notifyGroupsNewEntry({ authorId, groupIds, entryTitle, entryId }) {
  try {
    let ids = Array.isArray(groupIds) ? groupIds.map(Number).filter(Number.isFinite) : null;
    if (!ids) {
      const { data } = await supabaseAdmin
        .from('group_members').select('group_id').eq('user_id', authorId);
      ids = (data || []).map((r) => r.group_id);
    }
    if (!ids.length) return;

    const [{ data: groups }, { data: members }, authorRes] = await Promise.all([
      supabaseAdmin.from('groups').select('id, name').in('id', ids),
      supabaseAdmin.from('group_members').select('group_id, user_id').in('group_id', ids),
      supabaseAdmin.auth.admin.getUserById(authorId),
    ]);
    const authorMeta = authorRes?.data?.user?.user_metadata || {};
    const authorName = authorMeta.display_name
      || (authorRes?.data?.user?.email || '').split('@')[0] || '멤버';
    const nameById = new Map((groups || []).map((g) => [g.id, g.name]));

    // 여러 그룹에 겹치는 멤버에게는 한 번만 (뮤트 안 한 첫 그룹 이름으로)
    const groupsByUser = new Map();
    for (const m of members || []) {
      if (m.user_id === authorId) continue;
      if (!groupsByUser.has(m.user_id)) groupsByUser.set(m.user_id, []);
      groupsByUser.get(m.user_id).push(m.group_id);
    }

    const messages = [];
    for (const [userId, userGroupIds] of groupsByUser) {
      const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
      const meta = data?.user?.user_metadata || {};
      // 알림을 끈 그룹은 제외 (그룹별 알림 설정) — 전부 뮤트면 발송 안 함
      const muted = new Set(Array.isArray(meta.muted_groups) ? meta.muted_groups : []);
      const groupId = userGroupIds.find((id) => !muted.has(id));
      if (groupId === undefined) continue;
      const tokens = meta.push_tokens || [];
      const gname = nameById.get(groupId) || '그룹';
      for (const to of tokens) {
        messages.push({
          to,
          sound: 'default',
          title: `${gname}에 새 p!ng이 도착했어요`,
          body: entryTitle ? `${authorName}님 · ${entryTitle}` : `${authorName}님이 새 일기를 올렸어요`,
          // 알림 탭 → 해당 글로 이동 (앱의 알림 응답 리스너가 사용)
          data: { type: 'group_entry', entryId: entryId ?? null, groupId },
        });
      }
    }
    if (!messages.length) return;

    // Expo 푸시 API는 요청당 최대 100개
    for (let i = 0; i < messages.length; i += 100) {
      const r = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
      if (!r.ok) console.error('푸시 발송 응답 오류:', r.status, await r.text());
    }
  } catch (e) {
    console.error('푸시 발송 실패:', e.message);
  }
}

/**
 * 내 일기에 댓글이 달렸을 때 일기 주인에게 푸시를 보낸다.
 * 실패해도 throw하지 않는다.
 * @param {{ ownerId: string, commenterName: string, entryTitle?: string, comment: string, entryId?: number }} p
 */
async function notifyEntryComment({ ownerId, commenterName, entryTitle, comment, entryId }) {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(ownerId);
    const tokens = data?.user?.user_metadata?.push_tokens || [];
    if (!tokens.length) return;
    const preview = comment.length > 60 ? `${comment.slice(0, 60)}…` : comment;
    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title: entryTitle ? `${commenterName}님이 '${entryTitle}'에 댓글을 남겼어요` : `${commenterName}님이 댓글을 남겼어요`,
      body: preview,
      data: { type: 'comment', entryId: entryId ?? null },
    }));
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!r.ok) console.error('댓글 푸시 응답 오류:', r.status, await r.text());
  } catch (e) {
    console.error('댓글 푸시 발송 실패:', e.message);
  }
}

module.exports = { notifyGroupsNewEntry, notifyEntryComment };
