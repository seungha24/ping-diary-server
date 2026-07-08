const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { generateComment } = require('./aiComment');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // RLS 우회해서 전체 조회
);

async function generatePendingComments() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: entries, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, content, persona, title, tags')
    .is('ai_comment', null)
    .lt('created_at', yesterday);

  if (error || !entries?.length) return;

  console.log(`AI 코멘트 생성 대상: ${entries.length}개`);

  for (const entry of entries) {
    try {
      const aiComment = await generateComment(entry.content, entry.persona, { title: entry.title, tags: entry.tags });
      await supabaseAdmin
        .from('diary_entries')
        .update({ ai_comment: aiComment })
        .eq('id', entry.id);

      console.log(`일기 #${entry.id} 코멘트 생성 완료`);
    } catch (e) {
      console.error(`일기 #${entry.id} 코멘트 생성 실패:`, e.message);
    }
  }
}

// 매 시간 정각마다 실행
cron.schedule('0 * * * *', () => {
  console.log('스케줄러 실행 — 24시간 지난 일기 AI 코멘트 생성 중...');
  generatePendingComments();
});

console.log('AI 코멘트 스케줄러 시작 (매 시간 정각 실행)');
