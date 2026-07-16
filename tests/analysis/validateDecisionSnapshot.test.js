import { describe, expect, it } from 'vitest';
import { buildDecisionSnapshot } from '../../src/analysis/snapshot/buildDecisionSnapshot.js';
import {
    validateDecisionSnapshot,
    verifySnapshotInputHash,
    isAnalyzableSnapshot,
    allowedFactRefsForSnapshot,
} from '../../src/analysis/contracts/decisionSnapshot.js';

function action(seq, street, seat, type, amountTo, amountAdded) {
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
    };
}

function smallHand() {
    return {
        id: 'hand_validate',
        handNo: 1,
        dealerSeat: 0,
        straddleCount: 0,
        blinds: { sb: 1, bb: 2 },
        seats: [
            { seat: 0, name: 'Hero Real Name', position: 'BTN', sittingOut: false },
            { seat: 1, name: 'Villain Real Name', position: 'BB', sittingOut: false },
        ],
        actions: [
            action(0, 'preflop', 0, 'call', 2, 1),
            action(1, 'preflop', 1, 'check', 2, 0),
            action(2, 'flop', 1, 'bet', 4, 4),
            action(3, 'flop', 0, 'call', 4, 4),
        ],
        detailed: {
            enabled: true,
            heroSeat: 0,
            chipUnit: 1,
            startingStacks: { 0: 200, 1: 200 },
            street: 'flop',
            board: { flop: ['Qs', '7h', '2c'], turn: [], river: [] },
            heroCards: ['Ah', 'Qh'],
            reveals: [],
            completed: false,
            winners: [],
        },
    };
}

async function golden() {
    return buildDecisionSnapshot(smallHand(), 3);
}

function mutated(snapshot, mutate) {
    const clone = structuredClone(snapshot);
    mutate(clone);
    return clone;
}

describe('validateDecisionSnapshot — 미래정보 주입 거부', () => {
    it('유효한 빌더 출력은 통과한다', async () => {
        expect(validateDecisionSnapshot(await golden())).toEqual({ ok: true, errors: [] });
    });

    it('decisionSeq 이후의 priorAction 주입을 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.priorActions.push({
                seq: 5, street: 'flop', playerId: clone.players[1].playerId, action: 'bet',
                amountTo: 20, amountAdded: 20, potFraction: null, isAllIn: false, precision: 'exact',
            });
            clone.knowledgeCutoff.visibleThroughActionSeq = 5;
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/future action at\/after the decision/);
    });

    it('미래 거리 액션 주입을 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.priorActions[2].street = 'river';
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/future-street action/);
    });

    it('컷오프 거리보다 긴 보드 주입을 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.visibleBoard = ['Qs', '7h', '2c', '9h']; // flop 결정에 turn 카드 추가
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/card count must be one of/);
    });

    it('showdown/winners/result 계열 필드는 어느 깊이에서도 거부한다', async () => {
        const base = await golden();
        for (const mutate of [
            clone => { clone.showdown = ['Ac', 'Ad']; },
            clone => { clone.state.winners = [{ seat: 1 }]; },
            clone => { clone.game.result = { winner: 0 }; },
            clone => { clone.players[0].reveals = [['Kd', 'Kc']]; },
        ]) {
            const { ok, errors } = validateDecisionSnapshot(mutated(base, mutate));
            expect(ok).toBe(false);
            expect(errors.join('\n')).toMatch(/forbidden key|field is not allowed/);
        }
    });

    it('알 수 없는 root 필드(미래 whitelist 우회)를 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.futureBoard = ['9h', '2s'];
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/futureBoard: field is not allowed/);
    });

    it('표시 이름/PII 키 주입을 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.players[0].name = 'Hero Real Name';
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/forbidden key/);
    });

    it('가명이 아닌 playerId를 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.hero.playerId = 'Hero Real Name';
            clone.players[0].playerId = 'Hero Real Name';
            clone.priorActions[0].playerId = 'Hero Real Name';
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/pseudonymous playerId required/);
    });

    it('opponentModelRef가 현재 핸드를 포함하면 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.opponentModelRef = { modelId: 'opponent-model:x', asOfHandId: clone.handId, includedHands: 3 };
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/must not include the current hand/);
    });

    it('replay bound와 다른 legal option size를 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            const raise = clone.state.legalOptions.find(option => option.action === 'raise');
            raise.minTo = 4; // state.minRaiseTo(8)와 불일치 — 임의 완화 시도
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/must equal state\.minRaiseTo/);
    });

    it('actualAction이 legal option 밖이면 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.actualAction.action = 'check';
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/must be a legal option/);
    });

    it('amountAdded > amountTo (의미 혼용)를 거부한다', async () => {
        const snapshot = mutated(await golden(), clone => {
            clone.priorActions[0].amountAdded = 10;
        });
        const { ok, errors } = validateDecisionSnapshot(snapshot);
        expect(ok).toBe(false);
        expect(errors.join('\n')).toMatch(/must not exceed amountTo/);
    });
});

describe('inputHash 검증과 분석 가능성', () => {
    it('필드를 조작하면 verifySnapshotInputHash가 false가 된다', async () => {
        const snapshot = await golden();
        await expect(verifySnapshotInputHash(snapshot)).resolves.toBe(true);
        const tampered = mutated(snapshot, clone => {
            clone.state.toCall = 1;
            const call = clone.state.legalOptions.find(option => option.action === 'call');
            call.amountAdded = 1;
        });
        await expect(verifySnapshotInputHash(tampered)).resolves.toBe(false);
    });

    it('validationErrors가 있는 snapshot은 분석 대상이 아니다 (불변조건 10)', async () => {
        const snapshot = await golden();
        expect(isAnalyzableSnapshot(snapshot)).toBe(true);
        const degraded = mutated(snapshot, clone => {
            clone.dataQuality.validationErrors = ['flop advanced before betting closed'];
            clone.dataQuality.overall = 'unknown';
        });
        expect(isAnalyzableSnapshot(degraded)).toBe(false);
    });

    it('allowedFactRefsForSnapshot는 결정론적 whitelist를 만든다', async () => {
        const snapshot = await golden();
        const refs = allowedFactRefsForSnapshot(snapshot);
        expect(refs).toContain('state.potOddsRequiredPct');
        expect(refs).toContain('actualAction');
        expect(refs).toContain(`players:${snapshot.hero.playerId}`);
        expect(refs).toContain('priorActions:2');
        expect(refs).not.toContain('priorActions:3');
        expect(refs).not.toContain('showdown');
    });
});
