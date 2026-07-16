import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeDetailedHand } from '../../src/services/aiService.js';

function action(seq, street, seat, type, amountTo, amountAdded) {
    return {
        seq,
        street,
        seat,
        name: seat === 0 ? 'Hero Secret Name' : 'Villain Secret Name',
        position: seat === 0 ? 'BTN' : 'BB',
        type,
        raiseLevel: 0,
        amountTo,
        amountAdded,
        precision: 'exact',
        isAllIn: false,
    };
}

function detailedHand() {
    return {
        id: 'provider_hand_1',
        handNo: 1,
        dealerSeat: 0,
        straddleCount: 0,
        blinds: { sb: 1, bb: 2 },
        seats: [
            { seat: 0, name: 'Hero Secret Name', position: 'BTN', sittingOut: false },
            { seat: 1, name: 'Villain Secret Name', position: 'BB', sittingOut: false },
        ],
        actions: [
            action(0, 'preflop', 0, 'call', 2, 1),
            action(1, 'preflop', 1, 'check', 2, 0),
            action(2, 'flop', 1, 'bet', 4, 4),
            action(3, 'flop', 0, 'call', 4, 4),
            action(4, 'turn', 1, 'check', 0, 0),
            action(5, 'turn', 0, 'bet', 12, 12),
            action(6, 'turn', 1, 'fold', 0, 0),
        ],
        result: { winner: 0, amount: 40 },
        showdown: ['Qd', 'Jd'],
        detailed: {
            enabled: true,
            heroSeat: 0,
            chipUnit: 1,
            startingStacks: { 0: 200, 1: 200 },
            street: 'turn',
            board: { flop: ['Qs', '7h', '2c'], turn: ['9h'], river: ['2s'] },
            heroCards: ['Ah', 'Qh'],
            reveals: [{ seat: 1, cards: ['Qd', 'Jd'] }],
            completed: true,
            winners: [{ seat: 0, potIndex: null }],
        },
    };
}

function promptFromInit(init) {
    return JSON.parse(init.body).messages[0].content;
}

function decisionSeqOf(prompt) {
    const match = prompt.match(/"decisionSeq":\s*(\d+)/);
    if (!match) throw new Error('decisionSeq missing from prompt');
    return Number(match[1]);
}

function decisionIdOf(prompt) {
    const match = prompt.match(/"decisionId":\s*"([^"]+)"/);
    if (!match) throw new Error('decisionId missing from prompt');
    return match[1];
}

function validReview(prompt) {
    return {
        analysisMode: 'heuristic_no_solver',
        decisionId: decisionIdOf(prompt),
        assessment: 'plausible',
        confidence: { value: 0.3 },
        headline: '검토 가능한 휴리스틱 선택입니다.',
        reasoning: [{
            text: '실제 액션과 당시 합법 선택지를 함께 살펴볼 수 있습니다.',
            factRefs: ['actualAction', 'state.legalActions'],
        }],
        alternatives: [],
        unknowns: ['상대의 구체적인 범위 정보'],
        reflectionQuestion: '이 선택에서 가장 중요하게 본 정보는 무엇인가요?',
    };
}

function openAiResponse(review) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: JSON.stringify(review) } }] }),
        text: async () => '',
    };
}

const OPENAI_OPTIONS = { provider: 'openai', apiKey: 'sk-test', model: 'test-model' };

describe('analyzeDetailedHand provider integration', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('decision마다 별도 호출하고 provider prompt에서 미래 정보를 차단한다', async () => {
        const fetchMock = vi.fn(async (_url, init) => {
            const prompt = promptFromInit(init);
            return openAiResponse(validReview(prompt));
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await analyzeDetailedHand(detailedHand(), OPENAI_OPTIONS);

        expect(result.analysisMode).toBe('heuristic_no_solver');
        expect(result.handId).toBe('provider_hand_1');
        expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
        expect(result.items.map(item => item.decision.decisionSeq)).toEqual([0, 3, 5]);
        expect(result.items.every(item => item.review && item.error === null)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        const prompts = fetchMock.mock.calls.map(([, init]) => promptFromInit(init));
        const preflop = prompts.find(prompt => decisionSeqOf(prompt) === 0);
        const flop = prompts.find(prompt => decisionSeqOf(prompt) === 3);
        const turn = prompts.find(prompt => decisionSeqOf(prompt) === 5);

        expect(preflop).not.toContain('Qs');
        expect(flop).toContain('Qs');
        expect(flop).not.toContain('9h');
        expect(flop).not.toContain('2s');
        expect(turn).toContain('9h');
        for (const prompt of prompts) {
            expect(prompt).not.toContain('Qd');
            expect(prompt).not.toContain('Jd');
            expect(prompt).not.toContain('Hero Secret Name');
            expect(prompt).not.toContain('Villain Secret Name');
            expect(prompt).not.toContain('"winners"');
            expect(prompt).not.toContain('"result"');
        }
    });

    it('malformed model 응답은 해당 decision의 validation error로 격리한다', async () => {
        const fetchMock = vi.fn(async (_url, init) => {
            const prompt = promptFromInit(init);
            const review = validReview(prompt);
            if (decisionSeqOf(prompt) === 3) review.assessment = 'definitely_wrong';
            return openAiResponse(review);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await analyzeDetailedHand(detailedHand(), OPENAI_OPTIONS);
        const failed = result.items.find(item => item.decision.decisionSeq === 3);

        expect(failed.review).toBeNull();
        expect(failed.error.type).toBe('validation');
        expect(failed.error.message).toMatch(/must be one of/);
        expect(result.items.filter(item => item.review).map(item => item.decision.decisionSeq)).toEqual([0, 5]);
    });

    it('동시 호출을 2개로 제한하고 완료 순서와 무관하게 decision 순서/부분 실패를 유지한다', async () => {
        let active = 0;
        let maxActive = 0;
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fetchMock = vi.fn(async (_url, init) => {
            const prompt = promptFromInit(init);
            const seq = decisionSeqOf(prompt);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, seq === 0 ? 30 : 2));
            active -= 1;
            if (seq === 3) {
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Unavailable',
                    text: async () => JSON.stringify({ error: { message: 'temporary outage' } }),
                };
            }
            return openAiResponse(validReview(prompt));
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await analyzeDetailedHand(detailedHand(), OPENAI_OPTIONS);

        expect(maxActive).toBeLessThanOrEqual(2);
        expect(result.items.map(item => item.decision.decisionSeq)).toEqual([0, 3, 5]);
        expect(result.items[0].review).not.toBeNull();
        expect(result.items[1]).toMatchObject({ review: null, error: { type: 'provider' } });
        expect(result.items[1].error.message).toContain('temporary outage');
        expect(result.items[2].review).not.toBeNull();
        expect(consoleSpy).toHaveBeenCalled();
    });

    it('키 누락은 decision별 중복 오류가 아니라 기존 UX와 같은 blocking throw다', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(analyzeDetailedHand(detailedHand(), { provider: 'openai', apiKey: '' }))
            .rejects.toThrow('ChatGPT (OpenAI) API 키를 입력하세요');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('키가 유효한 뒤 모든 provider 호출이 실패해도 부분 결과 구조를 반환한다', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
        })));

        const result = await analyzeDetailedHand(detailedHand(), OPENAI_OPTIONS);
        expect(result.items).toHaveLength(3);
        expect(result.items.every(item => item.review === null && item.error?.type === 'provider')).toBe(true);
        expect(result.items.every(item => item.error.message.includes('rate limited'))).toBe(true);
    });
});
