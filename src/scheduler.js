const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // RLS 우회해서 전체 조회
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generatePendingComments() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: entries, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, content')
    .is('ai_comment', null)
    .lt('created_at', yesterday);

  if (error || !entries?.length) return;

  console.log(`AI 코멘트 생성 대상: ${entries.length}개`);

  for (const entry of entries) {
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: '너는 사용자의 일기를 읽는 다정한 친구야. 2~3문장, 반말, 공감 위주로 답해줘. 훈수 두지 말고, 판단하지 말 것. 코멘트 내용만 출력해.',
          },
          { role: 'user', content: entry.content },
        ],
      });

      const aiComment = completion.choices[0].message.content;
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
