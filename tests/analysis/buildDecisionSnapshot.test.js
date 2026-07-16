import { describe, expect, it } from 'vitest';
import { buildDecisionSnapshot, SNAPSHOT_BUILDER_VERSION } from '../../src/analysis/snapshot/buildDecisionSnapshot.js';
import {
    validateDecisionSnapshot,
    verifySnapshotInputHash,
    isAnalyzableSnapshot,
} from '../../src/analysis/contracts/decisionSnapshot.js';
import { pseudonymFor } from '../../src/analysis/pseudonyms.js';

const HERO_ID = pseudonymFor('Hero Real Name');
const VILLAIN_ID = pseudonymFor('Villain Real Name');

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

// detailedReview.test.js와 같은 컷오프 회귀 픽스처: 결정(seq 3) 이후의 미래가 A/B로 다르다.
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

describe('buildDecisionSnapshot 골든 스냅샷', () => {
    it('작은 상세 핸드에서 정확한 DecisionSnapshot v1 형태를 만든다', async () => {
        const snapshot = await buildDecisionSnapshot(completedHand(), 3);

        expect(snapshot).toEqual({
            schemaVersion: 'decision-snapshot.v1',
            handId: 'hand_cutoff_regression',
            decisionId: 'hand_cutoff_regression:seq:3',
            analysisContext: 'post_hand',
            knowledgeCutoff: { decisionSeq: 3, street: 'flop', visibleThroughActionSeq: 2 },
            game: {
                variant: 'NLHE',
                format: 'cash',
                currencyMode: null,
                chipUnit: 1,
                smallBlind: 1,
                bigBlind: 2,
                ante: 0,
                rake: null,
                dealerSeat: 0,
                straddlePosts: [],
            },
            hero: { playerId: HERO_ID, seat: 0, position: 'BTN', holeCards: ['Ah', 'Qh'] },
            players: [
                {
                    playerId: HERO_ID, seat: 0, position: 'BTN', startingStack: 200,
                    stackBefore: 198, stackPrecision: 'exact', folded: false, allIn: false,
                },
                {
                    playerId: VILLAIN_ID, seat: 1, position: 'BB', startingStack: 200,
                    stackBefore: 194, stackPrecision: 'exact', folded: false, allIn: false,
                },
            ],
            visibleBoard: ['Qs', '7h', '2c'],
            priorActions: [
                {
                    seq: 0, street: 'preflop', playerId: HERO_ID, action: 'call',
                    amountTo: 2, amountAdded: 1, potFraction: 0.3333, isAllIn: false, precision: 'exact',
                },
                {
                    seq: 1, street: 'preflop', playerId: VILLAIN_ID, action: 'check',
                    amountTo: 2, amountAdded: 0, potFraction: null, isAllIn: false, precision: 'exact',
                },
                {
                    seq: 2, street: 'flop', playerId: VILLAIN_ID, action: 'bet',
                    amountTo: 4, amountAdded: 4, potFraction: 1, isAllIn: false, precision: 'exact',
                },
            ],
            state: {
                potBeforeAction: 8,
                potPrecision: 'exact',
                contestablePots: [{ potId: 'main', amount: 4, eligiblePlayerIds: [HERO_ID, VILLAIN_ID] }],
                currentBetTo: 4,
                heroCommittedThisStreet: 0,
                toCall: 4,
                minRaiseTo: 8,
                maxRaiseTo: 198,
                heroStackBefore: 198,
                heroSprBefore: 24.75,
                potOddsRequiredPct: 33.3333,
                legalOptions: [
                    { action: 'fold' },
                    { action: 'call', amountAdded: 4 },
                    { action: 'raise', minTo: 8, maxTo: 198 },
                    { action: 'all-in', amountAdded: 198 },
                ],
            },
            opponentModelRef: null,
            actualAction: { action: 'call', amountTo: 4, amountAdded: 4, isAllIn: false, precision: 'exact' },
            dataQuality: {
                overall: 'exact',
                unknownFields: ['game.rake'],
                estimatedFields: [],
                validationErrors: [],
            },
            provenance: {
                source: 'holdemhud.manual_capture',
                sourceSchemaVersion: 2,
                snapshotBuilderVersion: SNAPSHOT_BUILDER_VERSION,
                inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            },
        });
        expect(validateDecisionSnapshot(snapshot)).toEqual({ ok: true, errors: [] });
        expect(isAnalyzableSnapshot(snapshot)).toBe(true);
        await expect(verifySnapshotInputHash(snapshot)).resolves.toBe(true);
    });

    it('snapshot에는 표시 이름이 어디에도 없다 (가명 불변식)', async () => {
        const snapshot = await buildDecisionSnapshot(completedHand(), 3);
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('Hero Real Name');
        expect(serialized).not.toContain('Villain Real Name');
        expect(serialized).not.toMatch(/"name"\s*:/);
        expect(HERO_ID).toMatch(/^player:[0-9a-f]{8}$/);
    });

    it('컷오프: 미래 거리 액션/보드/쇼다운/승자는 제거된다', async () => {
        const snapshot = await buildDecisionSnapshot(completedHand({ future: 'A' }), 3);
        const serialized = JSON.stringify(snapshot);
        expect(snapshot.priorActions.map(item => item.seq)).toEqual([0, 1, 2]);
        expect(snapshot.visibleBoard).toEqual(['Qs', '7h', '2c']);
        expect(serialized).not.toContain('"9h"');   // 미래 turn 카드
        expect(serialized).not.toContain('"2s"');   // 미래 river 카드
        expect(serialized).not.toContain('"Qd"');   // 상대 reveal
        expect(serialized).not.toContain('showdown');
        expect(serialized).not.toContain('winners');
        expect(serialized).not.toContain('reveals');
        expect(serialized).not.toContain('result');
    });

    it('미래(runout/쇼다운/승자)가 달라도 같은 snapshot과 같은 inputHash를 만든다', async () => {
        const snapshotA = await buildDecisionSnapshot(completedHand({ future: 'A' }), 3);
        const snapshotB = await buildDecisionSnapshot(completedHand({ future: 'B' }), 3);
        expect(snapshotA).toEqual(snapshotB);
        expect(snapshotA.provenance.inputHash).toBe(snapshotB.provenance.inputHash);
    });

    it('같은 입력은 같은 해시, 입력 필드가 바뀌면 다른 해시', async () => {
        const first = await buildDecisionSnapshot(completedHand(), 3);
        const second = await buildDecisionSnapshot(completedHand(), 3);
        expect(first.provenance.inputHash).toBe(second.provenance.inputHash);

        const changed = completedHand();
        changed.detailed.startingStacks = { 0: 300, 1: 200 };
        const third = await buildDecisionSnapshot(changed, 3);
        expect(third.provenance.inputHash).not.toBe(first.provenance.inputHash);
    });

    it('salt를 주면 가명 ID가 달라진다 (내용은 동일 구조)', async () => {
        const salted = await buildDecisionSnapshot(completedHand(), 3, { salt: 'device-1' });
        expect(salted.hero.playerId).toBe(pseudonymFor('Hero Real Name', 'device-1'));
        expect(salted.hero.playerId).not.toBe(HERO_ID);
        expect(validateDecisionSnapshot(salted).ok).toBe(true);
    });

    it('opponentStatsAsOf가 있으면 opponentModelRef를 채우고, 현재 핸드 포함이면 거부한다', async () => {
        const snapshot = await buildDecisionSnapshot(completedHand(), 3, {
            opponentStatsAsOf: { asOfHandId: 'hand_previous', includedHands: 12 },
        });
        expect(snapshot.opponentModelRef).toEqual({
            modelId: expect.stringMatching(/^opponent-model:[0-9a-f]{16}$/),
            asOfHandId: 'hand_previous',
            includedHands: 12,
        });

        await expect(buildDecisionSnapshot(completedHand(), 3, {
            opponentStatsAsOf: { asOfHandId: 'hand_cutoff_regression', includedHands: 12 },
        })).rejects.toThrow(/future information/);
    });

    it('Hero가 아닌 좌석의 액션이나 없는 seq는 결정으로 받지 않는다', async () => {
        await expect(buildDecisionSnapshot(completedHand(), 2)).rejects.toThrow(/must belong to hero/);
        await expect(buildDecisionSnapshot(completedHand(), 99)).rejects.toThrow(/was not found/);
    });

    it('replay engine이 다루지 못하는 ante 게임은 거부한다', async () => {
        const hand = completedHand();
        hand.blinds.ante = 1;
        await expect(buildDecisionSnapshot(hand, 3)).rejects.toThrow(/ante is not supported/);
    });

    it('turn 카드가 unknown이어도 알려진 flop 3장은 보존하고 unknownFields에 표시한다', async () => {
        const hand = completedHand({ future: 'A' });
        hand.detailed.board.turn = [];
        const snapshot = await buildDecisionSnapshot(hand, 5);
        expect(snapshot.knowledgeCutoff.street).toBe('turn');
        expect(snapshot.visibleBoard).toEqual(['Qs', '7h', '2c']);
        expect(snapshot.dataQuality.unknownFields).toContain('visibleBoard');
        expect(validateDecisionSnapshot(snapshot).ok).toBe(true);
    });
});
