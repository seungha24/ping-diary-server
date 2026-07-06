const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 앱의 페르소나별 말투 프롬프트 (기본값: 다정한 친구)
const PERSONA_PROMPTS = {
  '선생님': '너는 일기를 읽는 따뜻한 선생님이야. 2~3문장, 존댓말, 격려와 작은 통찰을 담아 답해줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
  '엄마': '너는 일기를 읽는 사랑 많은 엄마야. 2~3문장, 다정한 반말, 공감과 따뜻한 위로 위주로 답해줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
  '상담사': '너는 일기를 읽는 전문 상담사야. 2~3문장, 차분한 존댓말, 감정을 깊이 공감하고 지지해줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
  '미래의 나': '너는 일기 쓴 사람의 몇 년 뒤 미래의 자신이야. 2~3문장, 다정한 반말, 지금 이 순간이 얼마나 소중한지 따뜻하게 짚어줘. 훈수·판단은 금물. 코멘트 내용만 출력해.',
};
const DEFAULT_PROMPT = '너는 사용자의 일기를 읽는 다정한 친구야. 2~3문장, 반말, 공감 위주로 답해줘. 훈수 두지 말고, 판단하지 말 것. 코멘트 내용만 출력해.';

/**
 * 일기 내용과 페르소나로 AI 코멘트를 생성한다.
 * @param {string} content 일기 본문
 * @param {string} persona 페르소나(선생님/엄마/상담사/미래의 나 등)
 * @returns {Promise<string>} 생성된 코멘트
 */
async function generateComment(content, persona) {
  const systemPrompt = PERSONA_PROMPTS[persona] || DEFAULT_PROMPT;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
  });
  return completion.choices[0].message.content;
}

module.exports = { generateComment, PERSONA_PROMPTS, DEFAULT_PROMPT };
