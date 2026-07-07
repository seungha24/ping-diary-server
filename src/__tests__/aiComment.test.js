const { PERSONA_PROMPTS, DEFAULT_PROMPT, generateComment } = require('../aiComment');

describe('페르소나 프롬프트 데이터', () => {
  test('PERSONA_PROMPTS는 최소 1개 이상의 페르소나를 가진다', () => {
    expect(typeof PERSONA_PROMPTS).toBe('object');
    expect(Object.keys(PERSONA_PROMPTS).length).toBeGreaterThan(0);
  });

  test('모든 페르소나 프롬프트는 비어있지 않은 문자열이다', () => {
    for (const [name, prompt] of Object.entries(PERSONA_PROMPTS)) {
      expect(typeof prompt).toBe('string');
      expect(prompt.trim().length).toBeGreaterThan(0);
    }
  });

  test('DEFAULT_PROMPT는 비어있지 않은 문자열이다', () => {
    expect(typeof DEFAULT_PROMPT).toBe('string');
    expect(DEFAULT_PROMPT.trim().length).toBeGreaterThan(0);
  });

  test('generateComment 함수가 export 된다', () => {
    expect(typeof generateComment).toBe('function');
  });
});
