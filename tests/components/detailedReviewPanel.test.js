// DetailedReviewPanel의 리뷰 소스 가드 — 패널은 analyzeDetailedHand가 반환하는
// 검증 통과 형태({items:[{decision, review}]})만 렌더한다. 대체 형태 폴백은
// validateDecisionReview를 우회한 미검증 리뷰를 화면에 올리는 통로였다.
import { describe, expect, it } from 'vitest';
import { reviewsFromResult } from '../../src/components/history/DetailedReviewPanel.jsx';

const review = {
    schemaVersion: 'heuristic-decision-review.v1',
    decisionId: 'hand_1:a3',
    assessment: 'plausible',
    confidence: { value: 0.3, cap: 0.45 },
};
const decision = {
    decisionId: 'hand_1:a3',
    decisionSeq: 3,
    street: 'flop',
    dataQuality: { overall: 'estimated', unknownFields: [] },
};

describe('reviewsFromResult', () => {
    it('서비스 items 형태만 review+decision(dataQuality 포함)으로 매핑한다', () => {
        const result = {
            analysisMode: 'heuristic_no_solver',
            items: [
                { decision, review, error: null },
                { decision, review: null, error: { type: 'provider', message: 'x' } },
            ],
        };
        const reviews = reviewsFromResult(result);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({
            decisionId: 'hand_1:a3',
            assessment: 'plausible',
            decision: { decisionSeq: 3 },
            dataQuality: { overall: 'estimated' },
        });
    });

    it('검증을 우회하는 대체 형태는 하나도 렌더하지 않는다', () => {
        expect(reviewsFromResult([review])).toEqual([]);                       // bare array
        expect(reviewsFromResult({ reviews: [review] })).toEqual([]);          // result.reviews
        expect(reviewsFromResult({ results: [review] })).toEqual([]);          // result.results
        expect(reviewsFromResult({ decisions: [{ analysis: review }] })).toEqual([]); // result.decisions
        expect(reviewsFromResult({ review })).toEqual([]);                     // result.review
        expect(reviewsFromResult({ assessment: 'plausible' })).toEqual([]);    // assessment 객체
        // items 안이라도 validateDecisionReview를 통과한 review 없이 raw item은 불가
        expect(reviewsFromResult({ items: [{ assessment: 'plausible' }] })).toEqual([]);
        expect(reviewsFromResult(null)).toEqual([]);
        expect(reviewsFromResult(undefined)).toEqual([]);
    });
});
