// 멀티 프로바이더 AI 서비스 테스트 — fetch를 모킹해 요청 형태/응답 추출/에러 경로를 검증
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    analyzeTable, analyzeSessionLeaks, resolveAiOptions, AI_PROVIDERS, selectHeroHands,
} from '../../src/services/aiService.js';
import { normalizeSettings, DEFAULT_SETTINGS } from '../../src/state/gameReducer.js';
import { computeAllStats } from '../../src/engine/statsEngine.js';
import { pseudonymFor, rejoinDisplayNames } from '../../src/analysis/pseudonyms.js';

const VALID_RESULT = {
    recommendedRange: { AA: 'Raise' },
    strategySummary: [{ icon: '🎯', text: 'x' }],
    playerTips: [],
};

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
    const fn = vi.fn().mockResolvedValue({
        ok,
        status,
        statusText: ok ? 'OK' : 'Bad Request',
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

const TABLE = { blinds: { sb: 1, bb: 2 }, currency: '$', straddleCount: 0, players: [], heroPosition: 'BTN' };

describe('aiService 멀티 프로바이더', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('gemini: 기존 요청 형태 유지 (URL 키, responseMimeType)', async () => {
        const fetchMock = mockFetchOnce({
            candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_RESULT) }] } }],
        });
        await analyzeTable(TABLE, { provider: 'gemini', apiKey: 'gkey', model: 'gemini-3-pro-preview' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('generativelanguage.googleapis.com');
        expect(url).toContain('key=gkey');
        const body = JSON.parse(init.body);
        expect(body.generationConfig.responseMimeType).toBe('application/json');
    });

    it('openai: Bearer 인증 + chat/completions + json_object 모드', async () => {
        const fetchMock = mockFetchOnce({
            choices: [{ message: { content: JSON.stringify(VALID_RESULT) } }],
        });
        const result = await analyzeTable(TABLE, { provider: 'openai', apiKey: 'sk-test' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer sk-test');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('gpt-5.6-sol'); // 모델 미지정 → 기본 모델 (GPT-5.6 Sol)
        expect(body.response_format).toEqual({ type: 'json_object' });
        expect(body.messages[0].role).toBe('user');
        expect(result.recommendedRange.AA).toBe('Raise');
    });

    it('anthropic: 버전/브라우저 헤더 + adaptive thinking + text 블록 추출', async () => {
        const fetchMock = mockFetchOnce({
            stop_reason: 'end_turn',
            content: [
                { type: 'thinking', thinking: '' },
                { type: 'text', text: JSON.stringify(VALID_RESULT) },
            ],
        });
        const result = await analyzeTable(TABLE, { provider: 'anthropic', apiKey: 'sk-ant-test' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(init.headers['x-api-key']).toBe('sk-ant-test');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('claude-opus-4-8'); // 모델 미지정 → 기본 모델
        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.max_tokens).toBeGreaterThan(0);
        expect(result.recommendedRange.AA).toBe('Raise');
    });

    it('anthropic: refusal stop_reason은 한국어 에러로 변환', async () => {
        mockFetchOnce({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
        await expect(
            analyzeTable(TABLE, { provider: 'anthropic', apiKey: 'sk-ant-test' })
        ).rejects.toThrow('AI가 요청을 거절했습니다');
    });

    it('키 누락 시 프로바이더 라벨이 포함된 에러', async () => {
        mockFetchOnce({});
        await expect(analyzeTable(TABLE, { provider: 'openai', apiKey: '' }))
            .rejects.toThrow('ChatGPT (OpenAI) API 키를 입력하세요');
        await expect(analyzeTable(TABLE, { provider: 'anthropic', apiKey: '  ' }))
            .rejects.toThrow('Claude (Anthropic) API 키를 입력하세요');
        await expect(analyzeTable(TABLE, { provider: 'gemini' }))
            .rejects.toThrow('Gemini API 키를 입력하세요');
    });

    it('HTTP 에러 본문에서 프로바이더 error.message 추출', async () => {
        mockFetchOnce({ error: { message: 'invalid model' } }, { ok: false, status: 400 });
        await expect(
            analyzeTable(TABLE, { provider: 'openai', apiKey: 'sk-test' })
        ).rejects.toThrow(/400.*invalid model/);
    });
});

describe('resolveAiOptions / 설정 마이그레이션', () => {
    it('기본값: gemini + 기본 모델', () => {
        const opts = resolveAiOptions({});
        expect(opts.provider).toBe('gemini');
        expect(opts.model).toBe(AI_PROVIDERS.gemini.defaultModel);
    });

    it('선택된 프로바이더의 키/모델을 반환', () => {
        const opts = resolveAiOptions({
            aiProvider: 'anthropic',
            anthropicApiKey: 'sk-ant-x',
            anthropicModel: 'claude-opus-4-8',
        });
        expect(opts.provider).toBe('anthropic');
        expect(opts.apiKey).toBe('sk-ant-x');
        expect(opts.model).toBe('claude-opus-4-8');
        expect(opts.label).toBe('Claude (Anthropic)');
    });

    it('레거시 설정(aiModel)은 gemini 모델로 취급', () => {
        const opts = resolveAiOptions({ geminiApiKey: 'g', aiModel: 'gemini-legacy-model' });
        expect(opts.provider).toBe('gemini');
        expect(opts.model).toBe('gemini-legacy-model');
    });

    it('알 수 없는 프로바이더는 gemini로 폴백', () => {
        expect(resolveAiOptions({ aiProvider: 'nope' }).provider).toBe('gemini');
    });

    it('normalizeSettings: 레거시 aiModel → geminiModel 이식 + 신규 기본값 채움', () => {
        const s = normalizeSettings({ geminiApiKey: 'gk', aiModel: 'gemini-old' });
        expect(s.geminiApiKey).toBe('gk');
        expect(s.geminiModel).toBe('gemini-old');
        expect(s.aiProvider).toBe('gemini');
        expect(s.openaiModel).toBe(DEFAULT_SETTINGS.openaiModel);
        expect(s.anthropicModel).toBe(DEFAULT_SETTINGS.anthropicModel);
    });

    it('normalizeSettings: geminiModel이 이미 있으면 aiModel은 무시', () => {
        const s = normalizeSettings({ geminiModel: 'gemini-new', aiModel: 'gemini-old' });
        expect(s.geminiModel).toBe('gemini-new');
    });

    it('normalizeSettings: 잘못된 aiProvider는 gemini로 교정', () => {
        expect(normalizeSettings({ aiProvider: 'gpt' }).aiProvider).toBe('gemini');
        expect(normalizeSettings({ aiProvider: 'openai' }).aiProvider).toBe('openai');
    });

    it('normalizeSettings: 구 기본값 gpt-5.1은 새 기본(gpt-5.6-sol)으로 승격, 다른 값은 유지', () => {
        expect(normalizeSettings({ openaiModel: 'gpt-5.1' }).openaiModel).toBe('gpt-5.6-sol');
        expect(normalizeSettings({ openaiModel: 'gpt-5.6-terra' }).openaiModel).toBe('gpt-5.6-terra');
        expect(normalizeSettings({}).openaiModel).toBe('gpt-5.6-sol');
    });
});

describe('analyzeSessionLeaks 가명화 (연구 기준서 §12.4 항목 5–6)', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    // 우연히 프롬프트 상용구와 겹치지 않는 독특한 실명 픽스처
    const HERO = 'Zebulon김히어로';
    const VILLAIN = 'Xanthippe박빌런';
    const THIRD = 'Quirinus최서드';
    const heroId = pseudonymFor(HERO);
    const villainId = pseudonymFor(VILLAIN);

    function leakHand(handNo) {
        return {
            id: `hand_leak_${handNo}`,
            handNo,
            dealerSeat: 0,
            straddleCount: 0,
            seats: [
                { seat: 0, name: HERO, sittingOut: false, position: 'BTN' },
                { seat: 1, name: VILLAIN, sittingOut: false, position: 'SB' },
                { seat: 2, name: THIRD, sittingOut: false, position: 'BB' },
            ],
            actions: [
                { seq: 0, seat: 0, name: HERO, position: 'BTN', type: 'raise', raiseLevel: 1, street: 'preflop' },
                { seq: 1, seat: 1, name: VILLAIN, position: 'SB', type: 'fold', raiseLevel: 0, street: 'preflop' },
                { seq: 2, seat: 2, name: THIRD, position: 'BB', type: 'fold', raiseLevel: 0, street: 'preflop' },
            ],
        };
    }

    function buildArgs() {
        const hands = [leakHand(1), leakHand(2)];
        const stats = computeAllStats(hands);
        const opponentStats = [];
        for (const [name, st] of stats) {
            if (name === HERO) continue;
            opponentStats.push({ name, stats: st });
        }
        return { hands, heroName: HERO, opponentStats };
    }

    function mockLeakResponse(payload) {
        return mockFetchOnce({
            candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
        });
    }

    it('전송 프롬프트에 실명이 없고, 가명 ID와 스탯 num/den이 포함된다', async () => {
        const fetchMock = mockLeakResponse({ majorLeaks: [], goodPlays: [], overallScore: 80, summary: 'ok' });
        await analyzeSessionLeaks(buildArgs(), { provider: 'gemini', apiKey: 'gkey' });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const prompt = body.contents[0].parts[0].text;
        // 실명은 히어로/좌석/액션/스탯 어디에도 남지 않는다
        expect(prompt).not.toContain(HERO);
        expect(prompt).not.toContain(VILLAIN);
        expect(prompt).not.toContain(THIRD);
        // 히어로와 좌석/액션은 가명 ID로 식별된다
        expect(prompt).toContain(`Hero id: "${heroId}"`);
        expect(prompt).toContain(`"name": "${villainId}"`);
        // 상대 스탯은 playerId + exact {num, den, pct}
        expect(prompt).toContain(`"playerId": "${villainId}"`);
        expect(prompt).toContain('"num": 0');
        expect(prompt).toContain('"den": 2');
        // FtS: 히어로(BTN) 오픈을 SB가 두 번 마주하고 두 번 폴드 → num 2 / den 2
        expect(prompt).toContain('"num": 2');
    });

    it('반환된 pseudonyms 맵으로 응답 텍스트가 실명으로 라운드트립된다', async () => {
        mockLeakResponse({
            majorLeaks: [{
                title: '블라인드 스틸 부족',
                severity: 'Low',
                description: `${villainId}의 블라인드를 더 자주 공격해야 합니다`,
                fix: '스틸 빈도를 올리세요',
                evidenceHands: [1],
                opponentAdjustments: [{
                    vsPlayer: villainId,
                    basedOnStat: 'fts',
                    advice: `${villainId}는 스틸에 자주 폴드합니다`,
                    statSampleNote: '표본 2핸드 — 낮은 신뢰도',
                }],
            }],
            goodPlays: [{ handNo: 1, text: `${heroId}의 BTN 오픈은 좋았습니다` }],
            overallScore: 82,
            summary: `${heroId}는 ${villainId} 상대로 잘 플레이했습니다`,
        });
        const { result, pseudonyms } = await analyzeSessionLeaks(buildArgs(), { provider: 'gemini', apiKey: 'gkey' });

        // pseudonyms는 id → 실명 평문 객체
        expect(pseudonyms[heroId]).toBe(HERO);
        expect(pseudonyms[villainId]).toBe(VILLAIN);
        expect(pseudonyms[pseudonymFor(THIRD)]).toBe(THIRD);

        // rejoin 라운드트립: 가명화 → rejoin 하면 원래 실명이 나온다
        const inverted = new Map(Object.entries(pseudonyms));
        expect(rejoinDisplayNames(result.summary, inverted))
            .toBe(`${HERO}는 ${VILLAIN} 상대로 잘 플레이했습니다`);
        expect(rejoinDisplayNames(result.majorLeaks[0].description, inverted))
            .toBe(`${VILLAIN}의 블라인드를 더 자주 공격해야 합니다`);
        expect(rejoinDisplayNames(result.majorLeaks[0].opponentAdjustments[0].vsPlayer, inverted)).toBe(VILLAIN);
        expect(rejoinDisplayNames(result.goodPlays[0].text, inverted))
            .toBe(`${HERO}의 BTN 오픈은 좋았습니다`);
        // 결과 골격(방어적 보정)은 유지된다
        expect(result.overallScore).toBe(82);
        expect(Array.isArray(result.majorLeaks)).toBe(true);
    });

    it('malformed 응답도 { result, pseudonyms } 골격으로 보정된다', async () => {
        mockLeakResponse('"not-an-object"');
        const { result, pseudonyms } = await analyzeSessionLeaks(buildArgs(), { provider: 'gemini', apiKey: 'gkey' });
        expect(result.majorLeaks).toEqual([]);
        expect(result.goodPlays).toEqual([]);
        expect(result.overallScore).toBe(0);
        expect(result.summary).toBe('');
        expect(pseudonyms[heroId]).toBe(HERO);
    });
});

describe('selectHeroHands detailed draft policy', () => {
    it('keeps completed detailed hands and excludes interrupted drafts', () => {
        const base = {
            dealerSeat: 0,
            seats: [{ seat: 0, name: 'Hero', sittingOut: false }],
            actions: [{ seat: 0, name: 'Hero', type: 'call' }],
        };
        const draft = { ...base, id: 'draft', detailed: { enabled: true, completed: false } };
        const complete = { ...base, id: 'complete', detailed: { enabled: true, completed: true } };
        const quick = { ...base, id: 'quick' };

        expect(selectHeroHands([draft, complete, quick], 'Hero').map(hand => hand.id))
            .toEqual(['complete', 'quick']);
    });
});
