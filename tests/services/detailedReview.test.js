import { describe, expect, it } from 'vitest';
import {
    buildDecisionPrompt,
    buildDetailedReviewPayload,
    validateDecisionReview,
    validateDetailedReviewPayload,
} from '../../src/services/detailedReview.js';

function action(seq, street, seat, type, amountTo, amountAdded, extra = {}) {
    return {
        seq,
        street,
        seat,
        name: seat === 0 ? 'Hero Real Name' : 'Villain Real Name',
        position: seat === 0 ? 'BTN' : 'BB',
        type,
        raiseLevel: 0,
        amountTo,
        amountAdded,
        precision: 'exact',
        isAllIn: false,
        ...extra,
    };
}

function completedHand({ future = 'A' } = {}) {
    const commonActions = [
        action(0, 'preflop', 0, 'call', 2, 1),
        action(1, 'preflop', 1, 'check', 2, 0),
        action(2, 'flop', 1, 'bet', 4, 4),
        action(3, 'flop', 0, 'call', 4, 4),
    ];
    const futureActions = future === 'A'
        ? [
            action(4, 'turn', 1, 'check', 0, 0),
            action(5, 'turn', 0, 'bet', 12, 12),
            action(6, 'turn', 1, 'fold', 0, 0),
        ]
        : [
            action(4, 'turn', 1, 'bet', 20, 20),
            action(5, 'turn', 0, 'call', 20, 20),
            action(6, 'river', 1, 'bet', 40, 40),
            action(7, 'river', 0, 'fold', 20, 0),
        ];

    return {
        id: 'hand_cutoff_regression',
        handNo: 7,
        dealerSeat: 0,
        straddleCount: 0,
        blinds: { sb: 1, bb: 2 },
        seats: [
            { seat: 0, name: 'Hero Real Name', position: 'BTN', sittingOut: false },
            { seat: 1, name: 'Villain Real Name', position: 'BB', sittingOut: false },
        ],
        actions: [...commonActions, ...futureActions],
        result: future === 'A' ? { winner: 0, amount: 16 } : { winner: 1, amount: 120 },
        showdown: future === 'A' ? ['Ac', 'Ad'] : ['Kh', 'Kd'],
        detailed: {
            enabled: true,
            heroSeat: 0,
            chipUnit: 1,
            startingStacks: { 0: 200, 1: 200 },
            street: future === 'A' ? 'turn' : 'river',
            board: future === 'A'
                ? { flop: ['Qs', '7h', '2c'], turn: ['9h'], river: ['2s'] }
                : { flop: ['Qs', '7h', '2c'], turn: ['Kc'], river: ['As'] },
            heroCards: ['Ah', 'Qh'],
            reveals: future === 'A'
                ? [{ seat: 1, cards: ['Qd', 'Jd'] }]
                : [{ seat: 1, cards: ['Ks', 'Qc'] }],
            completed: true,
            winners: future === 'A' ? [{ seat: 0, potIndex: null }] : [{ seat: 1, potIndex: null }],
        },
    };
}

function built() {
    return buildDetailedReviewPayload(completedHand(), [{
        decisionSeq: 3,
        // Deliberately hostile/future fields: the builder must ignore all except decisionSeq.
        futureActions: [{ seq: 99, street: 'river', type: 'raise' }],
        showdown: ['Ac', 'Ad'],
        result: { winner: 0 },
    }]);
}

function validRawReview(decision) {
    return {
        analysisMode: 'heuristic_no_solver',
        decisionId: decision.decisionId,
        assessment: 'plausible',
        confidence: { value: 0.9 },
        headline: '콜은 검토 가능한 휴리스틱 선택입니다.',
        reasoning: [{
            text: '결정 직전 팟오즈와 실제 액션을 함께 확인해야 합니다.',
            factRefs: ['state.potOddsRequiredPct', 'actualAction'],
        }],
        alternatives: [{
            action: 'raise',
            condition: '상대의 작은 베팅이 매우 넓은 범위라고 판단될 때',
            why: '조건부로 공격적인 대응을 검토할 수 있습니다.',
        }],
        unknowns: ['상대의 플랍 베팅 범위'],
        reflectionQuestion: '콜 당시 상대의 가치 범위를 어떻게 예상했나요?',
    };
}

describe('buildDetailedReviewPayload knowledge cutoff', () => {
    it('미래 runout/action/showdown/result가 달라도 같은 prefix payload와 prompt를 만든다', () => {
        const payloadA = buildDetailedReviewPayload(completedHand({ future: 'A' }), [{ decisionSeq: 3 }]);
        const payloadB = buildDetailedReviewPayload(completedHand({ future: 'B' }), [{ decisionSeq: 3 }]);

        expect(payloadA).toEqual(payloadB);
        expect(buildDecisionPrompt(payloadA.shared, payloadA.decisions[0]))
            .toBe(buildDecisionPrompt(payloadB.shared, payloadB.decisions[0]));
    });

    it('snapshot별 visible board/action cutoff와 익명 playerId를 보장한다', () => {
        const payload = built();
        const decision = payload.decisions[0];
        const serialized = JSON.stringify(payload);

        expect(payload.analysisMode).toBe('heuristic_no_solver');
        expect(decision.street).toBe('flop');
        expect(decision.visibleBoard).toEqual(['Qs', '7h', '2c']);
        expect(decision.priorActions.map(item => item.seq)).toEqual([0, 1, 2]);
        expect(decision.actualAction.seq).toBe(3);
        expect(decision.state.legalActions).toEqual(expect.arrayContaining(['fold', 'call', 'raise']));
        expect(serialized).not.toContain('Hero Real Name');
        expect(serialized).not.toContain('Villain Real Name');
        expect(serialized).not.toContain('showdown');
        expect(serialized).not.toContain('winner');
        expect(serialized).not.toContain('9h');
        expect(serialized).not.toContain('2s');
    });

    it('turn 카드가 unknown이어도 이미 알려진 flop 3장은 보존한다', () => {
        const hand = completedHand({ future: 'A' });
        hand.detailed.board.turn = [];
        const payload = buildDetailedReviewPayload(hand, [{ decisionSeq: 5 }]);
        expect(payload.decisions[0].street).toBe('turn');
        expect(payload.decisions[0].visibleBoard).toEqual(['Qs', '7h', '2c']);
        expect(payload.decisions[0].dataQuality.unknownFields).toContain('visibleBoard');
    });

    it('대략 입력한 시작 스택 품질을 decision snapshot에 보존한다', () => {
        const hand = completedHand();
        hand.detailed.startingStackPrecisions = { 0: 'estimated', 1: 'estimated' };
        const payload = buildDetailedReviewPayload(hand, [{ decisionSeq: 3 }]);
        expect(payload.decisions[0].state.stackQuality).toBe('estimated');
        expect(payload.decisions[0].dataQuality.overall).toBe('estimated');
    });

    it('replay engine이 반영하지 않는 ante 게임은 분석 payload 생성을 거부한다', () => {
        const hand = completedHand();
        hand.blinds.ante = 1;
        expect(() => buildDetailedReviewPayload(hand, [{ decisionSeq: 3 }]))
            .toThrow(/ante is not supported/);
    });

    it('payload validator는 추가 결과 필드를 거부한다', () => {
        const payload = built();
        expect(() => validateDetailedReviewPayload({ ...payload, result: { winner: 0 } }))
            .toThrow(/payload\.result.*not allowed/);
    });

    it('prompt는 no-solver 제한과 exact factRef/legal action 계약을 포함한다', () => {
        const payload = built();
        const prompt = buildDecisionPrompt(payload.shared, payload.decisions[0]);
        expect(prompt).toContain('heuristic_no_solver');
        expect(prompt).toContain('no solver and no equity engine');
        expect(prompt).toContain('decision.allowedFactRefs');
        expect(prompt).toContain('decision.state.legalActions');
        expect(prompt).not.toContain('Villain Real Name');
    });

    it('익명화는 프롬프트 게이트의 불변식이다 — 실명 좌석에서 만든 최종 프롬프트에 이름이 없다', () => {
        // completedHand의 좌석/액션은 전부 'Hero Real Name'/'Villain Real Name'을 담는다.
        const payload = buildDetailedReviewPayload(completedHand(), [{ decisionSeq: 3 }]);
        const prompt = buildDecisionPrompt(payload.shared, payload.decisions[0]);

        expect(prompt).not.toContain('Hero Real Name');
        expect(prompt).not.toContain('Villain Real Name');
        // 게이트의 재귀 sanitizer: 어떤 깊이에서도 name 필드는 직렬화되지 않는다
        expect(prompt).not.toMatch(/"name"\s*:/);
        // 익명 좌석 id는 유지
        expect(prompt).toContain('"playerId": "seat:0"');
        expect(prompt).toContain('"playerId": "seat:1"');
    });
});

describe('validateDecisionReview', () => {
    it('응답을 whitelist하고 confidence를 0.45로 cap한다', () => {
        const decision = built().decisions[0];
        const result = validateDecisionReview(validRawReview(decision), decision);
        expect(result.schemaVersion).toBe('heuristic-decision-review.v1');
        expect(result.assessment).toBe('plausible');
        expect(result.confidence).toEqual({ value: 0.45, cap: 0.45 });
        expect(result.street).toBe('flop');
    });

    it('합법 액션이 아닌 대안을 거부한다', () => {
        const decision = built().decisions[0];
        const raw = validRawReview(decision);
        raw.alternatives[0].action = 'check';
        expect(() => validateDecisionReview(raw, decision)).toThrow(/alternative is not legal/);
    });

    it('whitelist 밖 factRef를 거부한다', () => {
        const decision = built().decisions[0];
        const raw = validRawReview(decision);
        raw.reasoning[0].factRefs = ['showdown.cards'];
        expect(() => validateDecisionReview(raw, decision)).toThrow(/reference is not allowed/);
    });

    it('호출자가 조작한 decision factRef whitelist도 신뢰하지 않는다', () => {
        const decision = built().decisions[0];
        const tampered = {
            ...decision,
            allowedFactRefs: [...decision.allowedFactRefs, 'showdown.cards'],
        };
        expect(() => validateDecisionReview(validRawReview(decision), tampered))
            .toThrow(/unsafe reference/);
    });

    it('assessment enum과 추가 EV 필드를 거부한다', () => {
        const decision = built().decisions[0];
        const wrongAssessment = validRawReview(decision);
        wrongAssessment.assessment = 'gto_mistake';
        expect(() => validateDecisionReview(wrongAssessment, decision)).toThrow(/must be one of/);

        const extraEv = { ...validRawReview(decision), evLoss: 12.5 };
        expect(() => validateDecisionReview(extraEv, decision)).toThrow(/evLoss.*not allowed/);
    });

    it('한국어가 아닌 prose와 본문 속 exact EV/GTO 주장을 거부한다', () => {
        const decision = built().decisions[0];
        const english = validRawReview(decision);
        english.headline = 'This is a good call';
        expect(() => validateDecisionReview(english, decision)).toThrow(/Korean prose required/);

        const exactClaim = validRawReview(decision);
        exactClaim.reasoning[0].text = '이 선택의 EV는 정확히 높습니다.';
        expect(() => validateDecisionReview(exactClaim, decision)).toThrow(/claims are not allowed/);
    });
});
