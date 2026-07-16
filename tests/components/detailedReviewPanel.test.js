// DetailedReviewPanel의 리뷰 소스 가드 — 패널은 analysisGateway가 반환하는 검증 통과
// 형태({result: poker-analysis-result.v1, review})만 렌더한다. 대체 형태 폴백은
// validateAnalysisResult를 우회한 미검증 응답을 화면에 올리는 통로이므로 금지.
import { describe, expect, it } from 'vitest';
import { cardModelFromOutcome, heroDecisionSeqs } from '../../src/components/history/DetailedReviewPanel.jsx';

const result = {
    schemaVersion: 'poker-analysis-result.v1',
    decisionId: 'hand_1:seq:3',
    inputHash: 'sha256:abc',
    analysisMode: 'heuristic_no_solver',
    recommendation: { primaryAction: 'call', alternatives: ['raise'] },
    confidence: { overall: 0.3 },
    explanation: {
        headline: '무난한 콜입니다',
        reasoning: [{ text: '근거', factRefs: ['state.toCall'] }],
        alternatives: [{ action: 'raise', condition: '조건', why: '이유' }],
        studyQuestions: ['다음 street 계획은?'],
    },
    unknowns: ['상대 성향 미상'],
};
const review = {
    schemaVersion: 'heuristic-decision-review.v1',
    decisionId: 'hand_1:a3',
    assessment: 'plausible',
    street: 'flop',
    confidence: { value: 0.3, cap: 0.45 },
};

describe('cardModelFromOutcome', () => {
    it('게이트웨이 outcome({result, review})만 카드 모델로 매핑한다', () => {
        const card = cardModelFromOutcome({ result, review, cached: true });
        expect(card).toMatchObject({
            decisionId: 'hand_1:seq:3',
            analysisMode: 'heuristic_no_solver',
            assessment: 'plausible',
            street: 'flop',
            confidence: 0.3,
            headline: '무난한 콜입니다',
            unknowns: ['상대 성향 미상'],
            studyQuestion: '다음 street 계획은?',
            cached: true,
        });
        expect(card.reasoning).toHaveLength(1);
        expect(card.alternatives).toHaveLength(1);
    });

    it('review 사이드카가 없으면 assessment는 not_gradable로 강등된다 (승격 금지)', () => {
        const card = cardModelFromOutcome({ result, review: null, cached: false });
        expect(card.assessment).toBe('not_gradable');
        expect(card.cached).toBe(false);
    });

    it('검증을 우회하는 대체 형태는 하나도 렌더하지 않는다', () => {
        // envelope schemaVersion이 없거나 다르면 미검증 응답으로 간주
        expect(cardModelFromOutcome({ result: { ...result, schemaVersion: 'other.v9' } })).toBeNull();
        expect(cardModelFromOutcome({ result: { assessment: 'plausible' } })).toBeNull();
        // 게이트웨이를 우회한 원시 리뷰/레거시 items 형태
        expect(cardModelFromOutcome({ result: review })).toBeNull();
        expect(cardModelFromOutcome({ review })).toBeNull();
        expect(cardModelFromOutcome({ result: [result] })).toBeNull();
        expect(cardModelFromOutcome({ items: [{ review }] })).toBeNull();
        expect(cardModelFromOutcome(review)).toBeNull();
        expect(cardModelFromOutcome(null)).toBeNull();
        expect(cardModelFromOutcome(undefined)).toBeNull();
    });
});

describe('heroDecisionSeqs', () => {
    const hand = {
        detailed: { enabled: true, heroSeat: 0 },
        actions: [
            { seq: 0, seat: 1, type: 'bet' },
            { seq: 3, seat: 0, type: 'call' },
            { seq: 1, seat: 0, type: 'fold' },
            { seq: 3, seat: 0, type: 'call' },      // 중복 seq는 1회만
            { seq: 5, seat: 0, type: 'straddle' },  // 상세 액션 어휘 밖 — 제외
            { seq: 7, seat: 0 },                    // type 없음 — 제외
        ],
    };

    it('Hero 좌석의 상세 액션 seq만 오름차순·중복 제거로 고른다', () => {
        expect(heroDecisionSeqs(hand)).toEqual([1, 3]);
    });

    it('Hero 좌석/액션이 없으면 빈 배열', () => {
        expect(heroDecisionSeqs(null)).toEqual([]);
        expect(heroDecisionSeqs({ detailed: { heroSeat: null }, actions: [] })).toEqual([]);
        expect(heroDecisionSeqs({ detailed: { heroSeat: 0 } })).toEqual([]);
    });
});
