// Expo 푸시 알림 발송 (그룹 새 글)
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * 그룹 멤버(작성자 제외)에게 새 글 푸시를 보낸다.
 * 실패해도 throw하지 않는다 — 글 저장 흐름을 막으면 안 되기 때문.
 * @param {{ authorId: string, groupIds: number[]|null, entryTitle?: string }} p
 *   groupIds가 null이면 작성자가 속한 모든 그룹에 공개된 것으로 본다.
 */
async function notifyGroupsNewEntry({ authorId, groupIds, entryTitle }) {
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

    // 여러 그룹에 겹치는 멤버에게는 한 번만 (첫 그룹 이름으로)
    const groupByUser = new Map();
    for (const m of members || []) {
      if (m.user_id === authorId) continue;
      if (!groupByUser.has(m.user_id)) groupByUser.set(m.user_id, m.group_id);
    }

    const messages = [];
    for (const [userId, groupId] of groupByUser) {
      const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
      const tokens = data?.user?.user_metadata?.push_tokens || [];
      const gname = nameById.get(groupId) || '그룹';
      for (const to of tokens) {
        messages.push({
          to,
          sound: 'default',
          title: `${gname}에 새 p!ng이 도착했어요`,
          body: entryTitle ? `${authorName}님 · ${entryTitle}` : `${authorName}님이 새 일기를 올렸어요`,
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

module.exports = { notifyGroupsNewEntry };
