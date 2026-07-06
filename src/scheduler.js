const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // RLS 우회해서 전체 조회
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 앱의 페르소나별 말투 프롬프트 (기본값: 다정한 친구)
const PERSONA_PROMPTS = {
  '선생님': '너는 일기를 읽는 따뜻한 선생님이야. 2~3문장, 존댓말, 격려와 작은 통찰을 담아 답해줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
  '엄마': '너는 일기를 읽는 사랑 많은 엄마야. 2~3문장, 다정한 반말, 공감과 따뜻한 위로 위주로 답해줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
  '상담사': '너는 일기를 읽는 전문 상담사야. 2~3문장, 차분한 존댓말, 감정을 깊이 공감하고 지지해줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
  '미래의 나': '너는 일기 쓴 사람의 몇 년 뒤 미래의 자신이야. 2~3문장, 다정한 반말, 지금 이 순간이 얼마나 소중한지 따뜻하게 짚어줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
};
const DEFAULT_PROMPT = '너는 사용자의 일기를 읽는 다정한 친구야. 2~3문장, 반말, 공감 위주로 답해줘. 훈수 두지 말고, 판단하지 말 것. 코멘트 내용만 출력해.';

async function generatePendingComments() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: entries, error } = await supabaseAdmin
    .from('diary_entries')
    .select('id, content, persona')
    .is('ai_comment', null)
    .lt('created_at', yesterday);

  if (error || !entries?.length) return;

  console.log(`AI 코멘트 생성 대상: ${entries.length}개`);

  for (const entry of entries) {
    try {
      const systemPrompt = PERSONA_PROMPTS[entry.persona] || DEFAULT_PROMPT;
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
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
