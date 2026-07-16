// handEngine 테스트 (docs/REBUILD_DESIGN.md §3, §9)
import { describe, it, expect } from 'vitest';
import { createSeat, createHand } from '../../src/engine/schema.js';
import {
    positionsForHand,
    lastOptionSeat,
    firstToActSeat,
    deriveHandState,
    legalActionsFor,
    applyAction,
    forceFold,
    nextDealerSeat,
} from '../../src/engine/handEngine.js';
import { enableDetailedTracking, legalDetailedActions } from '../../src/engine/detailedHandEngine.js';

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function makeSeats(n, sitOut = []) {
    return Array.from({ length: n }, (_, i) => {
        const s = createSeat(i, `P${i}`);
        if (sitOut.includes(i)) s.sittingOut = true;
        return s;
    });
}

function makeHand({ n = 6, dealerSeat = 0, straddleCount = 0, sitOut = [] } = {}) {
    const seats = makeSeats(n, sitOut);
    const positions = positionsForHand(seats, dealerSeat);
    return createHand({
        handNo: 1,
        dealerSeat,
        straddleCount,
        blinds: { sb: 1, bb: 2 },
        seats,
        positions,
        startedAt: 1000,
    });
}

/** [seat, type] 쌍을 순서대로 적용 */
function play(hand, moves) {
    let h = hand;
    for (const [seat, type] of moves) h = applyAction(h, seat, type);
    return h;
}

function posArray(seats, dealerSeat) {
    const map = positionsForHand(seats, dealerSeat);
    return seats.map(s => map.get(s.seat));
}

// ---------------------------------------------------------------------------
// 포지션 테이블
// ---------------------------------------------------------------------------

describe('positionsForHand — 포지션 테이블', () => {
    it('HU: 딜러=BTN(SB 겸), 상대=BB', () => {
        expect(posArray(makeSeats(2), 0)).toEqual(['BTN', 'BB']);
        expect(posArray(makeSeats(2), 1)).toEqual(['BB', 'BTN']);
    });

    it('3인: BTN, SB, BB', () => {
        expect(posArray(makeSeats(3), 0)).toEqual(['BTN', 'SB', 'BB']);
    });

    it('4인: dist3=CO', () => {
        expect(posArray(makeSeats(4), 0)).toEqual(['BTN', 'SB', 'BB', 'CO']);
    });

    it('5인: UTG, CO', () => {
        expect(posArray(makeSeats(5), 0)).toEqual(['BTN', 'SB', 'BB', 'UTG', 'CO']);
    });

    it('6인: UTG, HJ, CO', () => {
        expect(posArray(makeSeats(6), 0)).toEqual(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
    });

    it('9인: UTG, UTG+1, UTG+2, LJ, HJ, CO', () => {
        expect(posArray(makeSeats(9), 0)).toEqual(
            ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO']);
    });

    it('딜러 회전 반영 (6인, 딜러=3)', () => {
        expect(posArray(makeSeats(6), 3)).toEqual(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    });

    it('싯아웃 좌석은 null, 나머지는 액티브 인원 기준으로 재배치', () => {
        // 6좌석 중 1번 싯아웃 → 액티브 5인 테이블로 계산
        expect(posArray(makeSeats(6, [1]), 0)).toEqual(['BTN', null, 'SB', 'BB', 'UTG', 'CO']);
    });

    it('싯아웃 2명이면 액티브 2인은 HU 규칙', () => {
        expect(posArray(makeSeats(4, [1, 3]), 0)).toEqual(['BTN', null, 'BB', null]);
    });

    it('액티브 2인 미만이면 전원 null', () => {
        expect(posArray(makeSeats(3, [1, 2]), 0)).toEqual([null, null, null]);
    });
});

// ---------------------------------------------------------------------------
// lastOptionSeat / firstToActSeat
// ---------------------------------------------------------------------------

describe('lastOptionSeat / firstToActSeat', () => {
    it('스트래들 없음: lastOption=BB, firstToAct=UTG (6인)', () => {
        const seats = makeSeats(6);
        expect(lastOptionSeat(seats, 0, 0)).toBe(2);
        expect(firstToActSeat(seats, 0, 0)).toBe(3);
    });

    it('스트래들 1개: lastOption=스트래들 좌석, firstToAct는 그 다음', () => {
        const seats = makeSeats(6);
        expect(lastOptionSeat(seats, 0, 1)).toBe(3);
        expect(firstToActSeat(seats, 0, 1)).toBe(4);
    });

    it('스트래들 2개: lastOption이 두 칸 이동', () => {
        const seats = makeSeats(6);
        expect(lastOptionSeat(seats, 0, 2)).toBe(4);
        expect(firstToActSeat(seats, 0, 2)).toBe(5);
    });

    it('HU: lastOption=BB, 딜러(BTN)가 프리플랍 선액션', () => {
        const seats = makeSeats(2);
        expect(lastOptionSeat(seats, 0, 0)).toBe(1);
        expect(firstToActSeat(seats, 0, 0)).toBe(0);
    });

    it('싯아웃 좌석은 순서에서 제외', () => {
        // 6좌석, 3번(원래 UTG) 싯아웃 → 액티브 5인: BB=2, firstToAct=4
        const seats = makeSeats(6, [3]);
        expect(lastOptionSeat(seats, 0, 0)).toBe(2);
        expect(firstToActSeat(seats, 0, 0)).toBe(4);
    });

    it('액티브 2인 미만이면 null', () => {
        const seats = makeSeats(3, [1, 2]);
        expect(lastOptionSeat(seats, 0, 0)).toBeNull();
        expect(firstToActSeat(seats, 0, 0)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// deriveHandState
// ---------------------------------------------------------------------------

describe('deriveHandState', () => {
    it('초기 상태: firstToAct 차례, 카운터 0', () => {
        const d = deriveHandState(makeHand());
        expect(d.toActSeat).toBe(3);
        expect(d.raiseCount).toBe(0);
        expect(d.limperCount).toBe(0);
        expect(d.lastAggressorSeat).toBeNull();
        expect(d.foldedSeats.size).toBe(0);
        expect(d.actedSinceLastRaise.size).toBe(0);
        expect(d.isOver).toBe(false);
        expect(d.endedByFold).toBe(false);
    });

    it('폴드로 1명 남으면 종료 (endedByFold)', () => {
        // 6인: UTG~SB 전원 폴드 → BB 혼자 남음
        const h = play(makeHand(), [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold']]);
        const d = deriveHandState(h);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(true);
        expect(d.toActSeat).toBeNull();
        expect(d.foldedSeats).toEqual(new Set([3, 4, 5, 0, 1]));
    });

    it('림프 팟에서 BB 체크로 종료 (endedByFold 아님)', () => {
        const h = play(makeHand(), [
            [3, 'call'], [4, 'fold'], [5, 'call'], [0, 'fold'], [1, 'call'], [2, 'check'],
        ]);
        const d = deriveHandState(h);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(false);
        expect(d.raiseCount).toBe(0);
        expect(d.limperCount).toBe(3); // 언레이즈 팟의 call만 림프
    });

    it('레이즈 팟에서 마지막 콜로 마감 (콜 클로징)', () => {
        const h = play(makeHand(), [
            [3, 'raise'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'],
        ]);
        // BB 콜 직전: 아직 진행 중, BB 차례
        let d = deriveHandState(h);
        expect(d.isOver).toBe(false);
        expect(d.toActSeat).toBe(2);
        expect(d.lastAggressorSeat).toBe(3);
        // BB 콜 → 종료
        const h2 = applyAction(h, 2, 'call');
        d = deriveHandState(h2);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(false);
        expect(d.toActSeat).toBeNull();
    });

    it('레이즈 시 actedSinceLastRaise가 {레이저}로 리셋', () => {
        const h = play(makeHand(), [[3, 'call'], [4, 'raise']]);
        const d = deriveHandState(h);
        expect(d.actedSinceLastRaise).toEqual(new Set([4]));
        expect(d.raiseCount).toBe(1);
        expect(d.lastAggressorSeat).toBe(4);
        // 림퍼(3)에게 차례가 다시 돌아와야 하므로 아직 종료 아님
        expect(d.isOver).toBe(false);
    });

    it('HU: 딜러 림프 → BB 체크로 종료', () => {
        const hand = makeHand({ n: 2 });
        expect(deriveHandState(hand).toActSeat).toBe(0); // 딜러 선액션
        const h = play(hand, [[0, 'call'], [1, 'check']]);
        const d = deriveHandState(h);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(false);
        expect(d.limperCount).toBe(1);
    });

    it('스트래들은 레이즈가 아니다 — raiseCount에 불포함', () => {
        const h = makeHand({ straddleCount: 1 });
        const d = deriveHandState(h);
        expect(d.raiseCount).toBe(0);
        expect(d.toActSeat).toBe(4); // 스트래들(3) 다음 좌석부터
    });

    it('스트래들 팟: 전원 콜 후 스트래들 좌석이 체크로 마감', () => {
        const h = play(makeHand({ straddleCount: 1 }), [
            [4, 'call'], [5, 'call'], [0, 'call'], [1, 'call'], [2, 'call'], [3, 'check'],
        ]);
        const d = deriveHandState(h);
        expect(d.isOver).toBe(true);
        expect(d.raiseCount).toBe(0);
    });

    it('액션 순서 랩어라운드: 높은 좌석에서 0번으로 순환하며 폴드 좌석 건너뜀', () => {
        // 6인, 딜러=3 → SB=4, BB=5, UTG=0
        const hand = makeHand({ dealerSeat: 3 });
        expect(deriveHandState(hand).toActSeat).toBe(0);
        let h = applyAction(hand, 0, 'fold');
        expect(deriveHandState(h).toActSeat).toBe(1);
        h = applyAction(h, 1, 'call');
        expect(deriveHandState(h).toActSeat).toBe(2);
        h = applyAction(h, 2, 'fold');
        expect(deriveHandState(h).toActSeat).toBe(3);
        h = applyAction(h, 3, 'raise');
        expect(deriveHandState(h).toActSeat).toBe(4);
        h = applyAction(h, 4, 'fold');
        expect(deriveHandState(h).toActSeat).toBe(5);
        h = applyAction(h, 5, 'fold');
        // 다음 차례는 폴드한 0·2를 건너뛰고 림퍼 1
        expect(deriveHandState(h).toActSeat).toBe(1);
    });

    it('싯아웃 좌석은 toAct 순서에서 건너뜀', () => {
        // 6좌석, 4번 싯아웃: UTG(3) 액션 후 4를 건너뛰고 5
        const hand = makeHand({ sitOut: [4] });
        const h = applyAction(hand, 3, 'call');
        expect(deriveHandState(h).toActSeat).toBe(5);
    });

    it('액티브 2인 미만이면 액션 없이도 종료 상태', () => {
        const d = deriveHandState(makeHand({ n: 3, sitOut: [1, 2] }));
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(false);
        expect(d.toActSeat).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// legalActionsFor
// ---------------------------------------------------------------------------

describe('legalActionsFor', () => {
    it('언오픈 팟: lastOption(BB)만 체크 가능', () => {
        // UTG~BTN 폴드, SB 콜 → BB 차례
        const h = play(makeHand(), [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'call']]);
        expect(legalActionsFor(h, 2)).toEqual(['check', 'raise']);
    });

    it('언오픈 팟: lastOption 아닌 좌석은 체크 불가', () => {
        const h = makeHand();
        expect(legalActionsFor(h, 3)).toEqual(['fold', 'call', 'raise']);
    });

    it('레이즈 팟: fold/call/raise만', () => {
        const h = play(makeHand(), [[3, 'raise']]);
        expect(legalActionsFor(h, 4)).toEqual(['fold', 'call', 'raise']);
        // BB도 레이즈 팟에서는 체크 불가
        const h2 = play(h, [[4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold']]);
        expect(legalActionsFor(h2, 2)).toEqual(['fold', 'call', 'raise']);
    });

    it('차례 아닌 좌석은 []', () => {
        const h = makeHand();
        expect(legalActionsFor(h, 4)).toEqual([]);
        expect(legalActionsFor(h, 2)).toEqual([]);
    });

    it('폴드한 좌석은 []', () => {
        const h = play(makeHand(), [[3, 'fold']]);
        expect(legalActionsFor(h, 3)).toEqual([]);
    });

    it('싯아웃 좌석은 []', () => {
        const h = makeHand({ sitOut: [4] });
        expect(legalActionsFor(h, 4)).toEqual([]);
    });

    it('핸드 종료 후 전원 []', () => {
        const h = play(makeHand(), [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold']]);
        for (const s of [0, 1, 2, 3, 4, 5]) expect(legalActionsFor(h, s)).toEqual([]);
    });

    it('어그레서는 셀프 리레이즈 불가 — 차례가 돌아오지 않음', () => {
        // UTG 레이즈 후 전원 콜/폴드하면 어그레서 차례 전에 핸드 종료
        const h = play(makeHand(), [
            [3, 'raise'], [4, 'call'], [5, 'fold'], [0, 'fold'], [1, 'fold'],
        ]);
        expect(legalActionsFor(h, 3)).toEqual([]); // 진행 중에도 차례 아님
        const h2 = applyAction(h, 2, 'call');
        expect(deriveHandState(h2).isOver).toBe(true);
        expect(legalActionsFor(h2, 3)).toEqual([]);
    });

    it('리레이즈를 당하면 원래 어그레서에게 차례가 돌아온다', () => {
        const h = play(makeHand(), [
            [3, 'raise'], [4, 'raise'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold'],
        ]);
        const d = deriveHandState(h);
        expect(d.isOver).toBe(false);
        expect(d.toActSeat).toBe(3);
        expect(legalActionsFor(h, 3)).toEqual(['fold', 'call', 'raise']);
    });

    it('스트래들 팟: lastOption이 스트래들 좌석으로 이동', () => {
        const h = play(makeHand({ straddleCount: 1 }), [
            [4, 'call'], [5, 'call'], [0, 'call'], [1, 'call'], [2, 'call'],
        ]);
        expect(legalActionsFor(h, 3)).toEqual(['check', 'raise']);
        // BB(2)는 스트래들 팟에서 lastOption이 아니므로 체크 불가였음
        const h2 = play(makeHand({ straddleCount: 1 }), [[4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold']]);
        expect(legalActionsFor(h2, 2)).toEqual(['fold', 'call', 'raise']);
    });
});

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

describe('applyAction', () => {
    it('합법 액션: 새 레코드 반환, seq/name/position 기록', () => {
        const hand = makeHand();
        const h = applyAction(hand, 3, 'raise');
        expect(h).not.toBe(hand);
        expect(h.actions).toHaveLength(1);
        const a = h.actions[0];
        expect(a.seq).toBe(0);
        expect(a.seat).toBe(3);
        expect(a.name).toBe('P3');
        expect(a.position).toBe('UTG');
        expect(a.type).toBe('raise');
        expect(a.street).toBe('preflop');
    });

    it('불법 액션이면 원본 객체 그대로 반환 (no-op)', () => {
        const hand = makeHand();
        expect(applyAction(hand, 4, 'call')).toBe(hand);   // 차례 아님
        expect(applyAction(hand, 3, 'check')).toBe(hand);  // lastOption 아닌데 체크
        expect(applyAction(hand, 99, 'fold')).toBe(hand);  // 존재하지 않는 좌석
        expect(applyAction(hand, 3, 'bet')).toBe(hand);    // 없는 타입

        const folded = play(hand, [[3, 'fold']]);
        expect(applyAction(folded, 3, 'call')).toBe(folded); // 폴드 후 재액션

        const over = play(hand, [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold']]);
        expect(applyAction(over, 2, 'raise')).toBe(over);  // 핸드 종료 후

        const sitout = makeHand({ sitOut: [3] });
        expect(applyAction(sitout, 3, 'fold')).toBe(sitout); // 싯아웃 좌석
    });

    it('불변성: 원본 hand·actions를 변형하지 않음', () => {
        const hand = makeHand();
        Object.freeze(hand);
        Object.freeze(hand.actions);
        Object.freeze(hand.seats);
        const h = applyAction(hand, 3, 'call');
        expect(h).not.toBe(hand);
        expect(h.actions).not.toBe(hand.actions);
        expect(hand.actions).toHaveLength(0);
        expect(h.actions).toHaveLength(1);
        expect(h.seats).toBe(hand.seats); // 좌석 스냅샷은 공유해도 무방(읽기 전용)
    });

    it('raiseLevel 시퀀스: 오픈=1, 3벳=2, 4벳=3 / 비레이즈는 0', () => {
        const h = play(makeHand(), [
            [3, 'raise'],           // 오픈 → 1
            [4, 'raise'],           // 3벳 → 2
            [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold'],
            [3, 'raise'],           // 4벳 → 3
            [4, 'call'],
        ]);
        const levels = h.actions.filter(a => a.type === 'raise').map(a => a.raiseLevel);
        expect(levels).toEqual([1, 2, 3]);
        expect(h.actions.filter(a => a.type !== 'raise').every(a => a.raiseLevel === 0)).toBe(true);
        expect(deriveHandState(h).isOver).toBe(true);
    });

    it('스트래들 위 오픈도 raiseLevel 1', () => {
        const h = play(makeHand({ straddleCount: 1 }), [[4, 'raise']]);
        expect(h.actions[0].raiseLevel).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// forceFold — 아웃오브턴 강제 폴드 (플레이어 자리 비움)
// ---------------------------------------------------------------------------

describe('forceFold', () => {
    it('차례가 아닌 살아있는 좌석도 fold를 기록한다 — toActSeat는 그대로', () => {
        // UTG(3) 폴드 → 차례는 HJ(4). BTN(0)이 자리를 뜬다.
        const h = play(makeHand(), [[3, 'fold']]);
        expect(deriveHandState(h).toActSeat).toBe(4);

        const h2 = forceFold(h, 0);
        expect(h2).not.toBe(h);
        expect(h2.actions).toHaveLength(2);
        expect(h2.actions[1]).toMatchObject({ seat: 0, type: 'fold', position: 'BTN', raiseLevel: 0 });

        const d = deriveHandState(h2);
        expect(d.foldedSeats.has(0)).toBe(true);
        expect(d.toActSeat).toBe(4); // 아웃오브턴 폴드는 차례를 진행시키지 않는다
        expect(d.isOver).toBe(false);
    });

    it('강제 폴드된 좌석은 이후 차례 순환에서 건너뛴다 — 핸드는 정상 완주', () => {
        let h = play(makeHand(), [[3, 'fold']]);
        h = forceFold(h, 0); // BTN 자리 비움
        // 남은 순서: 4 → 5 → (0 건너뜀) → 1 → 2
        h = applyAction(h, 4, 'fold');
        expect(deriveHandState(h).toActSeat).toBe(5);
        h = applyAction(h, 5, 'fold');
        expect(deriveHandState(h).toActSeat).toBe(1); // 0은 폴드됐으므로 건너뜀
        h = applyAction(h, 1, 'call');
        expect(deriveHandState(h).toActSeat).toBe(2);
        h = applyAction(h, 2, 'check');
        const d = deriveHandState(h);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(false);
    });

    it('차례인 좌석을 강제 폴드하면 다음 적격 좌석으로 진행', () => {
        const h = play(makeHand(), [[3, 'fold']]); // 차례 = 4
        const h2 = forceFold(h, 4);
        const d = deriveHandState(h2);
        expect(d.foldedSeats.has(4)).toBe(true);
        expect(d.toActSeat).toBe(5);
    });

    it('마지막에서 두 번째 생존자를 강제 폴드하면 핸드 종료 (endedByFold)', () => {
        // 3,4,5,0 폴드 → 생존 {1,2}, 차례는 SB(1). 차례 아닌 BB(2)가 자리를 뜬다.
        const h = play(makeHand(), [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold']]);
        expect(deriveHandState(h).toActSeat).toBe(1);
        const h2 = forceFold(h, 2);
        const d = deriveHandState(h2);
        expect(d.isOver).toBe(true);
        expect(d.endedByFold).toBe(true);
        expect(d.toActSeat).toBeNull();
    });

    it('no-op 조건: 이미 폴드·핸드 종료·싯아웃·없는 좌석이면 원본 반환', () => {
        const folded = play(makeHand(), [[3, 'fold']]);
        expect(forceFold(folded, 3)).toBe(folded); // 이미 폴드

        const over = play(makeHand(), [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold']]);
        expect(forceFold(over, 2)).toBe(over); // 핸드 종료

        const sitout = makeHand({ sitOut: [4] });
        expect(forceFold(sitout, 4)).toBe(sitout); // 싯아웃 좌석

        const h = makeHand();
        expect(forceFold(h, 99)).toBe(h); // 없는 좌석
    });

    it('레이즈 팟에서도 아웃오브턴 폴드가 차례를 흔들지 않는다', () => {
        const h = play(makeHand(), [[3, 'raise']]); // 차례 = 4
        const h2 = forceFold(h, 1); // SB 자리 비움
        const d = deriveHandState(h2);
        expect(d.toActSeat).toBe(4);
        expect(d.raiseCount).toBe(1);
        expect(d.lastAggressorSeat).toBe(3);
        // 이후 4 콜 → 차례 5
        const h3 = applyAction(h2, 4, 'call');
        expect(deriveHandState(h3).toActSeat).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// 이퀄 블라인드(sb===bb) 체크 권리 — 상세 엔진과의 프리플랍 합의 (E1/E2 단일 규칙)
// ---------------------------------------------------------------------------

describe('이퀄 블라인드 SB 체크 권리 (칩 기준, 상세 엔진과 합의)', () => {
    function makeEqualBlindHand({ n = 3, dealerSeat = 0, straddleCount = 0 } = {}) {
        const seats = makeSeats(n);
        return createHand({
            handNo: 1,
            dealerSeat,
            straddleCount,
            blinds: { sb: 2, bb: 2 },
            seats,
            positions: positionsForHand(seats, dealerSeat),
            startedAt: 1000,
        });
    }

    it('2/2 게임 SB의 무추가칩 계속은 call이 아니라 check다 (VPIP 모드 간 일치)', () => {
        // 3인, 딜러 0: SB=1, BB=2, 첫 액션 0(BTN)
        const hand = play(makeEqualBlindHand(), [[0, 'fold']]);
        expect(legalActionsFor(hand, 1)).toEqual(['check', 'raise']);
        const checked = applyAction(hand, 1, 'check');
        expect(checked).not.toBe(hand);
        expect(checked.actions.at(-1)).toMatchObject({ seat: 1, type: 'check', position: 'SB' });

        // 같은 구성에서 상세 엔진도 동일 판정 (all-in 명령을 제외하면 같은 목록)
        const detailed = enableDetailedTracking(hand, { startingStacks: [100, 100, 100], chipUnit: 1 });
        expect(legalDetailedActions(detailed, 1)).toEqual(['check', 'raise', 'all-in']);
    });

    it('HU 2/2: 딜러(SB 겸 BTN)의 첫 액션도 check/raise', () => {
        const hand = makeEqualBlindHand({ n: 2 });
        expect(legalActionsFor(hand, 0)).toEqual(['check', 'raise']);
        const detailed = enableDetailedTracking(hand, { startingStacks: [100, 100], chipUnit: 1 });
        expect(legalDetailedActions(detailed, 0)).toEqual(['check', 'raise', 'all-in']);
    });

    it('레이즈가 나오면 SB도 평범한 fold/call/raise', () => {
        const hand = play(makeEqualBlindHand(), [[0, 'raise']]);
        expect(legalActionsFor(hand, 1)).toEqual(['fold', 'call', 'raise']);
    });

    it('스트래들이 있으면 SB 포스트(2)가 베팅 레벨(4)에 못 미쳐 체크 불가', () => {
        // 4인, 딜러 0: SB=1, BB=2, 스트래들=3, 첫 액션 0
        const hand = play(makeEqualBlindHand({ n: 4, straddleCount: 1 }), [[0, 'fold']]);
        expect(legalActionsFor(hand, 1)).toEqual(['fold', 'call', 'raise']);
    });

    it('1/2 게임 SB는 기존대로 fold/call/raise (비회귀)', () => {
        const hand = play(makeHand({ n: 3 }), [[0, 'fold']]);
        expect(legalActionsFor(hand, 1)).toEqual(['fold', 'call', 'raise']);
    });
});

// ---------------------------------------------------------------------------
// nextDealerSeat
// ---------------------------------------------------------------------------

describe('nextDealerSeat', () => {
    it('다음 액티브 좌석으로 회전', () => {
        expect(nextDealerSeat(makeSeats(6), 0)).toBe(1);
    });

    it('마지막 좌석에서 0번으로 랩어라운드', () => {
        expect(nextDealerSeat(makeSeats(6), 5)).toBe(0);
    });

    it('싯아웃 좌석은 건너뜀', () => {
        expect(nextDealerSeat(makeSeats(6, [1, 2]), 0)).toBe(3);
        expect(nextDealerSeat(makeSeats(6, [0]), 5)).toBe(1);
    });

    it('액티브 좌석이 없으면 현재 딜러 유지', () => {
        expect(nextDealerSeat(makeSeats(3, [0, 1, 2]), 1)).toBe(1);
    });
});
