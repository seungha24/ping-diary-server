const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { generateComment } = require('./aiComment');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // RLS 우회해서 전체 조회
);

// 작성 후 이 시간이 지난 일기에 AI 코멘트를 단다
const COMMENT_DELAY_HOURS = 10;

// 배치가 1시간을 넘겨 다음 정각과 겹쳐도 같은 일기에 이중 생성(비용 중복)되지 않게
let running = false;

async function generatePendingComments() {
  if (running) return; // 이전 배치가 아직 도는 중이면 이번 틱은 건너뜀
  running = true;
  try {
    await generatePendingCommentsInner();
  } finally {
    running = false;
  }
}

async function generatePendingCommentsInner() {
  const cutoff = new Date(Date.now() - COMMENT_DELAY_HOURS * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // 과거 기준(10시간 경과) + 미래 날짜 일기(달력에서 미래를 고른 경우,
  // created_at > now라 영영 cutoff를 못 넘던 것)도 대상에 포함
  const { data: entries, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, content, persona, title, tags')
    .is('ai_comment', null)
    .or(`created_at.lt.${cutoff},created_at.gt.${now}`);

  if (error || !entries?.length) return;

  console.log(`AI 코멘트 생성 대상: ${entries.length}개`);

  for (const entry of entries) {
    try {
      const aiComment = await generateComment(entry.content, entry.persona, { title: entry.title, tags: entry.tags });
      const cache = entry.ai_comments && typeof entry.ai_comments === 'object' ? entry.ai_comments : {};
      await supabaseAdmin
        .from('diary_entries')
        .update({ ai_comment: aiComment, ai_comments: { ...cache, [entry.persona]: aiComment } })
        .eq('id', entry.id);

      console.log(`일기 #${entry.id} 코멘트 생성 완료`);
    } catch (e) {
      console.error(`일기 #${entry.id} 코멘트 생성 실패:`, e.message);
    }
  }
}

// 매 시간 정각마다 실행
cron.schedule('0 * * * *', () => {
  console.log(`스케줄러 실행 — ${COMMENT_DELAY_HOURS}시간 지난 일기 AI 코멘트 생성 중...`);
  generatePendingComments();
});

console.log('AI 코멘트 스케줄러 시작 (매 시간 정각 실행)');
