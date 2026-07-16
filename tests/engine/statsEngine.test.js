// statsEngine 골든 케이스 테스트 (docs/REBUILD_DESIGN.md §4 표의 모든 행 커버)
import { describe, it, expect } from 'vitest';
import { computeAllStats, computeStats, computeStatsAsOf, formatPct } from '../../src/engine/statsEngine.js';

let handCounter = 0;

// actions: [seatNo, type] 배열. raiseLevel은 리플레이 순번으로 자동 계산 (오픈=1, 3벳=2, …)
function buildHand({ seats, actions = [], dealerSeat = 0, straddleCount = 0, handNo = 1 }) {
    let raises = 0;
    const acts = actions.map(([seatNo, type], i) => {
        const s = seats.find(x => x.seat === seatNo);
        return {
            seq: i,
            seat: seatNo,
            name: s ? s.name : `S${seatNo}`,
            position: s ? s.position : null,
            type,
            raiseLevel: type === 'raise' ? ++raises : 0,
            street: 'preflop',
        };
    });
    handCounter += 1;
    return {
        id: `hand_test_${handCounter}`,
        handNo,
        startedAt: null,
        endedAt: null,
        dealerSeat,
        straddleCount,
        blinds: null,
        seats,
        actions: acts,
    };
}

// 6인 테이블, 딜러 seat0: 0=BTN, 1=SB, 2=BB, 3=UTG, 4=HJ, 5=CO (액션은 3부터)
function seats6() {
    const POS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'];
    return POS.map((p, i) => ({ seat: i, name: `P${i}`, sittingOut: false, position: p }));
}

// 4인 테이블, 딜러 seat0: 0=BTN, 1=SB, 2=BB, 3=CO (설계서: 4인 dist3=CO)
function seats4() {
    const POS = ['BTN', 'SB', 'BB', 'CO'];
    return POS.map((p, i) => ({ seat: i, name: `P${i}`, sittingOut: false, position: p }));
}

function ratio(st) {
    return { num: st.num, den: st.den, pct: st.pct };
}

describe('dealt / VPIP / PFR', () => {
    it('BB 체크는 VPIP에 절대 포함되지 않는다 (림프 팟)', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'call'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'call'], [2, 'check']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P2').vpip)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P2').pfr)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(stats.get('P2').dealt).toBe(1);
        // 림프(call)는 VPIP
        expect(ratio(stats.get('P3').vpip)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P1').vpip)).toEqual({ num: 1, den: 1, pct: 100 });
        // 포지션 버킷에도 체크는 불포함
        expect(stats.get('P2').pos.BB.dealt).toBe(1);
        expect(stats.get('P2').pos.BB.vpip.num).toBe(0);
    });

    it('액션 없이 차례 전에 끝난(진행 중) 핸드도 dealt에 포함된다', () => {
        const hand = buildHand({ seats: seats6(), actions: [[3, 'raise']] });
        const stats = computeAllStats([hand]);
        expect(stats.get('P5').dealt).toBe(1);           // CO는 아직 액션 안 함
        expect(ratio(stats.get('P5').vpip)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P3').pfr)).toEqual({ num: 1, den: 1, pct: 100 });
    });

    it('액션이 0개인 핸드도 액티브 전원 dealt', () => {
        const hand = buildHand({ seats: seats6(), actions: [] });
        const stats = computeAllStats([hand]);
        for (let i = 0; i < 6; i++) expect(stats.get(`P${i}`).dealt).toBe(1);
    });

    it('VPIP/PFR num은 핸드당 최대 1회', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'call'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold'], [3, 'call']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').vpip)).toEqual({ num: 1, den: 1, pct: 100 }); // 콜 2회 = num 1
        expect(stats.get('P5').pfr.num).toBe(1);
    });
});

describe('3Bet', () => {
    it('기회는 남의 오픈(raiseCount===1)을 마주할 때만 — 오픈한 본인은 den 불포함', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold'], [3, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P4').threeBet)).toEqual({ num: 0, den: 1, pct: 0 });  // 오픈 마주하고 폴드
        expect(ratio(stats.get('P5').threeBet)).toEqual({ num: 1, den: 1, pct: 100 }); // 3벳
        expect(stats.get('P3').threeBet.den).toBe(0);   // 오프너 본인
        // raiseCount===2 이후 액션은 3벳 기회가 아니다
        expect(stats.get('P0').threeBet.den).toBe(0);
        expect(stats.get('P1').threeBet.den).toBe(0);
        expect(stats.get('P2').threeBet.den).toBe(0);
    });

    it('den은 핸드당 1회 (여러 번 액션해도)', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold'], [3, 'raise'], [5, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P5').threeBet)).toEqual({ num: 1, den: 1, pct: 100 }); // 4벳을 마주해도 den 그대로 1
    });
});

describe('Ft3B / 4Bet', () => {
    it('오픈 후 raiseCount===2 상태로 액션하면 den, 폴드가 num (핸드당 1회)', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold'], [3, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').ft3b)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P3').fourBet)).toEqual({ num: 0, den: 1, pct: 0 }); // 4Bet은 동일 den
    });

    it('4벳 국면(raiseCount>=3)에서 오프너가 액션하면 Ft3B den에 불포함', () => {
        // UTG 오픈 → CO 3벳 → BTN 콜드 4벳 → UTG는 raiseCount===3을 마주한다
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'fold'], [5, 'raise'], [0, 'raise'], [1, 'fold'], [2, 'fold'], [3, 'fold'], [5, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').ft3b)).toEqual({ num: 0, den: 0, pct: null });
        expect(ratio(stats.get('P3').fourBet)).toEqual({ num: 0, den: 0, pct: null });
        // 콜드 4벳터(오프너 아님)도 Ft3B/4Bet den 불포함
        expect(stats.get('P0').ft3b.den).toBe(0);
        expect(stats.get('P0').fourBet.den).toBe(0);
    });

    it('오프너가 3벳에 다시 레이즈하면 4Bet num', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold'], [3, 'raise'], [5, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').ft3b)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P3').fourBet)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(stats.get('P3').pfr.num).toBe(1); // 레이즈 2회여도 PFR num 1
    });
});

describe('ATS (Attempt To Steal)', () => {
    it('CO/BTN/SB의 퍼스트-인(raiseCount 0, limper 0)만 기회', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P5').ats)).toEqual({ num: 1, den: 1, pct: 100 }); // CO 스틸
        expect(stats.get('P3').ats.den).toBe(0);  // UTG는 포지션 게이트
        expect(stats.get('P4').ats.den).toBe(0);  // HJ도
        expect(stats.get('P0').ats.den).toBe(0);  // BTN은 raiseCount 1 상태라 기회 아님
    });

    it('림퍼가 있으면 기회 아님 (아이솔은 스틸이 아니다)', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'call'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold'], [3, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P5').ats)).toEqual({ num: 0, den: 0, pct: null });
    });

    it('BTN 퍼스트-인 폴드도 den, SB 퍼스트-인 레이즈는 num', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'raise'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P0').ats)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P1').ats)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P5').ats)).toEqual({ num: 0, den: 1, pct: 0 });
    });

    it('4인 테이블: CO(dist3) 퍼스트-인도 기회', () => {
        const hand = buildHand({
            seats: seats4(),
            actions: [[3, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').ats)).toEqual({ num: 1, den: 1, pct: 100 });
        // FtS: 오프너 CO는 스틸 포지션
        expect(ratio(stats.get('P1').fts)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P2').fts)).toEqual({ num: 1, den: 1, pct: 100 });
    });
});

describe('FtS (Fold to Steal)', () => {
    it('SB/BB가 CO/BTN/SB의 첫 오픈을 마주하면 den, 폴드가 num', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P1').fts)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P2').fts)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(stats.get('P0').fts.den).toBe(0); // BTN은 블라인드가 아님
    });

    it('오프너가 EP/MP면 기회 아님', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(stats.get('P1').fts.den).toBe(0);
        expect(stats.get('P2').fts.den).toBe(0);
    });

    it('오픈과 블라인드 사이에 콜러가 있으면 기회 아님', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'call'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(stats.get('P1').fts.den).toBe(0);
        expect(stats.get('P2').fts.den).toBe(0);
        expect(ratio(stats.get('P0').coldCall)).toEqual({ num: 1, den: 1, pct: 100 });
    });

    it('블라인드가 콜로 수비하면 den만 오르고 num은 그대로', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'call']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P2').fts)).toEqual({ num: 0, den: 1, pct: 0 });
    });
});

describe('OpenLimp', () => {
    it('언오픈·언림프 팟의 첫 진입 기회: 폴드/레이즈도 den, 콜만 num', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'call'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'call'], [2, 'check']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').openLimp)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(stats.get('P4').openLimp.den).toBe(0); // 이미 림퍼 존재 → 기회 아님
        expect(stats.get('P1').openLimp.den).toBe(0);
    });

    it('퍼스트-인 폴드와 레이즈도 den에 포함된다', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').openLimp)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P4').openLimp)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P5').openLimp)).toEqual({ num: 0, den: 1, pct: 0 }); // 레이즈 → num 0
        expect(stats.get('P0').openLimp.den).toBe(0); // raiseCount 1 → 기회 아님
    });

    it('lastOption(스트래들 없으면 BB) 좌석은 den에서 제외', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'check']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P2').openLimp)).toEqual({ num: 0, den: 0, pct: null });
    });

    it('스트래들이 있으면 lastOption은 마지막 스트래들 좌석 — BB의 콜은 오픈림프, 스트래들러는 제외', () => {
        const hand = buildHand({
            seats: seats6(),
            straddleCount: 1, // lastOption = BB 다음 액티브 좌석 = seat3(UTG)
            actions: [[4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'call'], [3, 'check']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P2').openLimp)).toEqual({ num: 1, den: 1, pct: 100 }); // BB는 lastOption 아님
        expect(ratio(stats.get('P3').openLimp)).toEqual({ num: 0, den: 0, pct: null }); // 스트래들러 = lastOption
        // 스트래들러의 체크는 VPIP 아님
        expect(ratio(stats.get('P3').vpip)).toEqual({ num: 0, den: 1, pct: 0 });
    });
});

describe('ColdCall', () => {
    it('이전 자발적 액션(림프)이 있으면 기회 아님', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'call'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'call'], [3, 'call']],
        });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P3').coldCall)).toEqual({ num: 0, den: 0, pct: null }); // 림프-콜 ≠ 콜드콜
        expect(ratio(stats.get('P2').coldCall)).toEqual({ num: 1, den: 1, pct: 100 });  // 블라인드는 액션 레코드가 아님
        expect(ratio(stats.get('P0').coldCall)).toEqual({ num: 0, den: 1, pct: 0 });    // 레이즈 마주하고 폴드 → den만
        // P3의 콜은 3벳 기회이기도 하다 (남의 오픈을 raiseCount===1로 마주함)
        expect(ratio(stats.get('P3').threeBet)).toEqual({ num: 0, den: 1, pct: 0 });
    });
});

describe('Straddle', () => {
    it('액티브 순서상 BB 다음 좌석이 den, 스트래들 핸드면 num', () => {
        const seats = seats6();
        const straddleHand = buildHand({
            seats,
            straddleCount: 1,
            actions: [[4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const normalHand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'raise'], [2, 'fold']],
        });
        const stats = computeAllStats([straddleHand, normalHand]);
        expect(ratio(stats.get('P3').straddle)).toEqual({ num: 1, den: 2, pct: 50 }); // UTG(BB 다음) 두 핸드 den, 스트래들 핸드만 num
        expect(stats.get('P4').straddle.den).toBe(0); // BB 다음 좌석이 아님
        expect(stats.get('P2').straddle.den).toBe(0);
    });
});

describe('포지션 버킷 (positionCategory)', () => {
    it('UTG→EP, HJ→MP, CO/BTN/SB/BB는 그대로', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'call'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(stats.get('P3').pos.EP).toMatchObject({ dealt: 1 });
        expect(ratio(stats.get('P3').pos.EP.vpip)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P3').pos.EP.pfr)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P4').pos.MP.vpip)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P4').pos.MP.pfr)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(stats.get('P5').pos.CO.dealt).toBe(1);
        expect(stats.get('P0').pos.BTN.dealt).toBe(1);
        expect(stats.get('P1').pos.SB.dealt).toBe(1);
        expect(stats.get('P2').pos.BB.dealt).toBe(1);
        // 다른 버킷은 비어 있어야 한다
        expect(stats.get('P3').pos.MP.dealt).toBe(0);
    });

    it('9인 포지션: UTG+1/UTG+2→EP, LJ/HJ→MP', () => {
        const POS = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO'];
        const seats = POS.map((p, i) => ({ seat: i, name: `N${i}`, sittingOut: false, position: p }));
        const hand = buildHand({ seats, actions: [] });
        const stats = computeAllStats([hand]);
        expect(stats.get('N4').pos.EP.dealt).toBe(1);  // UTG+1
        expect(stats.get('N5').pos.EP.dealt).toBe(1);  // UTG+2
        expect(stats.get('N6').pos.MP.dealt).toBe(1);  // LJ
        expect(stats.get('N7').pos.MP.dealt).toBe(1);  // HJ
    });
});

describe('sit-out / 부재 플레이어', () => {
    it('sittingOut 좌석은 그 핸드를 완전히 건너뛴다 (dealt 불포함)', () => {
        // 5인 액티브 (seat4 sit-out): BTN,SB,BB,UTG,CO
        const seats = [
            { seat: 0, name: 'P0', sittingOut: false, position: 'BTN' },
            { seat: 1, name: 'P1', sittingOut: false, position: 'SB' },
            { seat: 2, name: 'P2', sittingOut: false, position: 'BB' },
            { seat: 3, name: 'P3', sittingOut: false, position: 'UTG' },
            { seat: 4, name: 'Sitter', sittingOut: true, position: null },
            { seat: 5, name: 'P5', sittingOut: false, position: 'CO' },
        ];
        const hand = buildHand({
            seats,
            actions: [[3, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const stats = computeAllStats([hand]);
        expect(stats.has('Sitter')).toBe(false);
        expect(computeStats([hand], 'Sitter').dealt).toBe(0);
        expect(computeStats([hand], 'Sitter').vpip.pct).toBe(null);
        // 액티브 5인은 전원 dealt
        for (const n of ['P0', 'P1', 'P2', 'P3', 'P5']) expect(stats.get(n).dealt).toBe(1);
        expect(ratio(stats.get('P5').ats)).toEqual({ num: 1, den: 1, pct: 100 });
    });
});

describe('헤즈업', () => {
    const huSeats = () => ([
        { seat: 0, name: 'Hero', sittingOut: false, position: 'BTN' },  // HU: 딜러=BTN(SB 겸)
        { seat: 1, name: 'Villain', sittingOut: false, position: 'BB' },
    ]);

    it('HU BTN 오픈은 ATS 기회가 아니다 (3인 미만 제외), BB 폴드 = FtS', () => {
        const hand = buildHand({ seats: huSeats(), actions: [[0, 'raise'], [1, 'fold']] });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('Hero').ats)).toEqual({ num: 0, den: 0, pct: null }); // HU 제외
        expect(ratio(stats.get('Hero').openLimp)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('Villain').fts)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('Villain').coldCall)).toEqual({ num: 0, den: 1, pct: 0 });
    });

    it('3인 테이블부터는 ATS 기회가 있다 (BTN 퍼스트-인)', () => {
        const seats3 = [
            { seat: 0, name: 'P0', sittingOut: false, position: 'BTN' },
            { seat: 1, name: 'P1', sittingOut: false, position: 'SB' },
            { seat: 2, name: 'P2', sittingOut: false, position: 'BB' },
        ];
        const hand = buildHand({ seats: seats3, actions: [[0, 'raise'], [1, 'fold'], [2, 'fold']] });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P0').ats)).toEqual({ num: 1, den: 1, pct: 100 });
    });

    it('BTN 림프 후 BB 체크 — 체크는 VPIP 아님, BB는 lastOption이라 오픈림프 den 제외', () => {
        const hand = buildHand({ seats: huSeats(), actions: [[0, 'call'], [1, 'check']] });
        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('Hero').openLimp)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('Villain').vpip)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(stats.get('Villain').openLimp.den).toBe(0);
    });
});

describe('formatPct / pct 규칙', () => {
    it('den 0 → null, 그 외 반올림 정수', () => {
        expect(formatPct({ num: 0, den: 0 })).toBe(null);
        expect(formatPct({ num: 1, den: 3 })).toBe(33);
        expect(formatPct({ num: 2, den: 3 })).toBe(67);
        expect(formatPct({ num: 1, den: 2 })).toBe(50);
        expect(formatPct(null)).toBe(null);
    });

    it('빈 입력·모르는 플레이어 → 0으로 채워진 PlayerStats (pct null)', () => {
        const st = computeStats([], 'Nobody');
        expect(st.dealt).toBe(0);
        expect(st.vpip).toEqual({ num: 0, den: 0, pct: null });
        expect(st.pos.BTN.vpip.pct).toBe(null);
        expect(computeAllStats(null).size).toBe(0);
    });

    it('잘못된 핸드 레코드는 건너뛴다', () => {
        const good = buildHand({ seats: seats6(), actions: [[3, 'raise']] });
        const stats = computeAllStats([null, {}, { dealerSeat: 0, seats: 'x', actions: [] }, good]);
        expect(stats.get('P3').dealt).toBe(1);
        expect(stats.size).toBe(6);
    });
});

describe('집계와 computeStats 래퍼', () => {
    it('여러 핸드에 걸쳐 누적되고, computeStats는 computeAllStats 항목과 동일하다', () => {
        const handA = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
        });
        const handC = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'raise'], [2, 'fold']],
        });
        const hands = [handA, handC];
        const all = computeAllStats(hands);
        expect(all.get('P5').dealt).toBe(2);
        expect(ratio(all.get('P5').ats)).toEqual({ num: 1, den: 2, pct: 50 });
        expect(computeStats(hands, 'P5')).toEqual(all.get('P5'));
        // 이름은 trim해서 비교
        expect(computeStats(hands, '  P5  ').dealt).toBe(2);
    });
});

describe('HandRecord v2 postflop compatibility', () => {
    it('ignores postflop actions when calculating preflop stats', () => {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'call'], [2, 'check']],
        });
        hand.actions.push(
            { seq: 6, seat: 2, name: 'P2', position: 'BB', type: 'raise', street: 'flop', raiseLevel: 0 },
            { seq: 7, seat: 1, name: 'P1', position: 'SB', type: 'call', street: 'flop', raiseLevel: 0 },
        );

        const stats = computeAllStats([hand]);
        expect(ratio(stats.get('P2').vpip)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P2').pfr)).toEqual({ num: 0, den: 1, pct: 0 });
        expect(ratio(stats.get('P1').vpip)).toEqual({ num: 1, den: 1, pct: 100 });
    });

    it('excludes interrupted detailed drafts from every denominator', () => {
        const draft = buildHand({
            seats: seats6(),
            actions: [[3, 'fold']],
        });
        draft.status = 'incomplete';
        draft.detailed = { enabled: true, completed: false };

        expect(computeAllStats([draft]).size).toBe(0);
        expect(computeStats([draft], 'P3').dealt).toBe(0);

        draft.status = 'complete';
        draft.detailed.completed = true;
        expect(computeAllStats([draft]).get('P3').dealt).toBe(1);
    });
});

describe('computeStatsAsOf (시점 고정 통계 — 미래 핸드 누출 방지)', () => {
    // P5(CO)가 레이즈하는 핸드 / 전원 폴드 핸드 두 종류로 시간축을 구분한다
    const raiseHand = () => buildHand({
        seats: seats6(),
        actions: [[3, 'fold'], [4, 'fold'], [5, 'raise'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
    });
    const foldHand = () => buildHand({
        seats: seats6(),
        actions: [[3, 'fold'], [4, 'fold'], [5, 'fold'], [0, 'fold'], [1, 'fold'], [2, 'fold']],
    });

    it('beforeHandId 핸드 자신과 그 이후는 제외된다 (strictly before)', () => {
        const h1 = raiseHand();
        const h2 = raiseHand();
        const h3 = raiseHand();
        const { asOfHandId, truncated, windows } = computeStatsAsOf([h1, h2, h3], { beforeHandId: h2.id });
        expect(truncated).toBe(true);
        expect(asOfHandId).toBe(h2.id);
        // h1만 표본 — h2(기준 핸드)와 h3(미래)는 불포함
        expect(windows.lifetime.get('P5').dealt).toBe(1);
        expect(ratio(windows.lifetime.get('P5').pfr)).toEqual({ num: 1, den: 1, pct: 100 });
        // 단일 구현 재사용: computeAllStats(사전 슬라이스)와 동일해야 한다
        expect(windows.lifetime).toEqual(computeAllStats([h1]));
    });

    it('첫 핸드를 기준으로 하면 빈 표본', () => {
        const h1 = raiseHand();
        const h2 = raiseHand();
        const { truncated, windows } = computeStatsAsOf([h1, h2], { beforeHandId: h1.id });
        expect(truncated).toBe(true);
        expect(windows.lifetime.size).toBe(0);
    });

    it('recent_50: 기준 이전 핸드 중 마지막 50개만 사용한다', () => {
        // 앞 5핸드는 P5 레이즈, 뒤 50핸드는 전원 폴드 → recent_50에는 레이즈 핸드가 없어야 한다
        const early = Array.from({ length: 5 }, raiseHand);
        const late = Array.from({ length: 50 }, foldHand);
        const target = raiseHand();
        const { windows } = computeStatsAsOf([...early, ...late, target], {
            beforeHandId: target.id,
            windows: ['lifetime', 'recent_50'],
        });
        expect(windows.lifetime.get('P5').dealt).toBe(55);
        expect(ratio(windows.lifetime.get('P5').pfr)).toEqual({ num: 5, den: 55, pct: 9 });
        expect(windows.recent_50.get('P5').dealt).toBe(50);
        expect(ratio(windows.recent_50.get('P5').pfr)).toEqual({ num: 0, den: 50, pct: 0 });
    });

    it('모르는 beforeHandId는 방어적으로 전체 사용 + truncated:false', () => {
        const h1 = raiseHand();
        const h2 = raiseHand();
        const { asOfHandId, truncated, windows } = computeStatsAsOf([h1, h2], { beforeHandId: 'hand_없는_id' });
        expect(truncated).toBe(false);
        expect(asOfHandId).toBe(null);
        expect(windows.lifetime.get('P5').dealt).toBe(2);
    });

    it('beforeHandId 미지정 → 전체 사용, session 윈도우는 주어진 슬라이스 전체와 동일', () => {
        const h1 = raiseHand();
        const h2 = foldHand();
        const { truncated, windows } = computeStatsAsOf([h1, h2], { windows: ['session', 'lifetime'] });
        expect(truncated).toBe(false);
        expect(windows.session).toEqual(computeAllStats([h1, h2]));
        expect(windows.session).toEqual(windows.lifetime);
    });

    it('모르는 윈도우 이름은 결과에서 빠지고, 기본 윈도우는 lifetime', () => {
        const h1 = raiseHand();
        const def = computeStatsAsOf([h1]);
        expect(Object.keys(def.windows)).toEqual(['lifetime']);
        const { windows } = computeStatsAsOf([h1], { windows: ['lifetime', 'weird_window'] });
        expect(Object.keys(windows)).toEqual(['lifetime']);
    });
});

describe('진행 중 상세 핸드 라이브 포함 (includeInProgressDetailed)', () => {
    function inProgressDetailedHand() {
        const hand = buildHand({
            seats: seats6(),
            actions: [[3, 'raise'], [4, 'call']],
        });
        // 라이브 currentHand 형태: 상세 활성 + 미완료 + 포스트플랍 진행분 포함
        hand.actions.push(
            { seq: 2, seat: 3, name: 'P3', position: 'UTG', type: 'bet', street: 'flop', raiseLevel: 0 },
        );
        hand.detailed = { enabled: true, completed: false };
        return hand;
    }

    it('기본값(false): 미완료 상세 핸드(아카이브 드래프트)는 표본에서 제외', () => {
        expect(computeAllStats([inProgressDetailedHand()]).size).toBe(0);
    });

    it('true: 진행 중 상세 핸드의 프리플랍 액션이 v1 핸드처럼 dealt/VPIP/PFR에 반영', () => {
        const stats = computeAllStats([inProgressDetailedHand()], { includeInProgressDetailed: true });
        expect(stats.get('P3').dealt).toBe(1);
        expect(ratio(stats.get('P3').vpip)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P3').pfr)).toEqual({ num: 1, den: 1, pct: 100 });
        expect(ratio(stats.get('P4').vpip)).toEqual({ num: 1, den: 1, pct: 100 });
        // 아직 액션 전인 좌석도 dealt에 포함 — 포스트플랍 액션은 여전히 무시
        expect(stats.get('P5').dealt).toBe(1);
        expect(ratio(stats.get('P5').vpip)).toEqual({ num: 0, den: 1, pct: 0 });
    });

    it('완료된 상세 핸드는 플래그와 무관하게 포함 (기존 동작 유지)', () => {
        const done = inProgressDetailedHand();
        done.detailed = { enabled: true, completed: true };
        expect(computeAllStats([done]).get('P3').pfr.num).toBe(1);
        expect(computeAllStats([done], { includeInProgressDetailed: true }).get('P3').pfr.num).toBe(1);
    });
});
