// 통계 엔진 (docs/REBUILD_DESIGN.md §4) — 유일한 통계 구현.
// 순수 모듈: schema.js 외 어떤 것도 import 금지 (React·DOM·handEngine 금지).
//
// 모든 통계는 항상 HandRecord 배열에서 파생된다 (증분 카운터 전면 폐지).
// 포지션은 레코드에 저장된 값(seats[].position, actions[].position)을 신뢰하며 절대 재계산하지 않는다.

import { positionCategory, POSITION_CATEGORIES, isValidHandRecord } from './schema.js';

const STEAL_POSITIONS = ['CO', 'BTN', 'SB'];
const BLIND_POSITIONS = ['SB', 'BB'];

/**
 * {num, den} 비율을 반올림 퍼센트 정수로 변환한다.
 * @param {{num: number, den: number}} ratio - 분자/분모 쌍
 * @returns {number|null} den === 0 이면 null (UI가 '-' 표시), 아니면 반올림 정수 퍼센트
 */
export function formatPct(ratio) {
    if (!ratio || !ratio.den) return null;
    return Math.round((ratio.num / ratio.den) * 100);
}

function newRatio() {
    return { num: 0, den: 0, pct: null };
}

function newPosEntry() {
    return { dealt: 0, vpip: newRatio(), pfr: newRatio() };
}

const RATIO_KEYS = ['vpip', 'pfr', 'threeBet', 'ft3b', 'fourBet', 'ats', 'fts', 'openLimp', 'coldCall', 'straddle'];

function newPlayerStats() {
    const pos = {};
    for (const cat of POSITION_CATEGORIES) pos[cat] = newPosEntry();
    return {
        dealt: 0,
        vpip: newRatio(),
        pfr: newRatio(),
        threeBet: newRatio(),
        ft3b: newRatio(),
        fourBet: newRatio(),
        ats: newRatio(),
        fts: newRatio(),
        openLimp: newRatio(),
        coldCall: newRatio(),
        straddle: newRatio(),
        pos,
    };
}

function finalizeStats(st) {
    for (const key of RATIO_KEYS) st[key].pct = formatPct(st[key]);
    for (const cat of POSITION_CATEGORIES) {
        st.pos[cat].vpip.pct = formatPct(st.pos[cat].vpip);
        st.pos[cat].pfr.pct = formatPct(st.pos[cat].pfr);
    }
    return st;
}

function ensureStats(map, name) {
    let st = map.get(name);
    if (!st) {
        st = newPlayerStats();
        map.set(name, st);
    }
    return st;
}

function ensureFlags(map, name) {
    let f = map.get(name);
    if (!f) {
        f = {
            vpip: false, pfr: false, threeBet: false, ft3b: false,
            ats: false, fts: false, openLimp: false, coldCall: false,
            voluntary: false, // 이 핸드에서 이미 자발적(call/raise) 액션을 했는가 — coldCall 판정용
        };
        map.set(name, f);
    }
    return f;
}

// ─── 액티브 좌석 순서 헬퍼 (handEngine과 독립 — 설계서 §3 의미론과 동일) ───

// 딜러부터 시계방향으로 정렬된 액티브(!sittingOut) 좌석 번호 배열
function orderedActiveSeats(hand) {
    const seats = hand.seats.filter(s => s && !s.sittingOut && typeof s.seat === 'number').map(s => s.seat);
    if (seats.length === 0) return [];
    const dealer = typeof hand.dealerSeat === 'number' ? hand.dealerSeat : 0;
    const mod = Math.max(...seats, dealer) + 1;
    const dist = (seat) => (((seat - dealer) % mod) + mod) % mod;
    return seats.slice().sort((a, b) => dist(a) - dist(b));
}

// BB 좌석: 저장된 position === 'BB' 를 신뢰. 없으면 순서로 폴백 (HU: 딜러 다음, 3인+: dist 2)
function bbSeatOf(hand, order) {
    if (order.length < 2) return null;
    const stored = hand.seats.find(s => s && !s.sittingOut && s.position === 'BB');
    if (stored) return stored.seat;
    return order.length === 2 ? order[1] : order[2];
}

// 언레이즈 팟에서 체크 권리를 가진 좌석: 스트래들 없으면 BB, 있으면 BB 다음 straddleCount번째 액티브 좌석
function lastOptionSeatOf(hand, order, bb) {
    if (bb === null) return null;
    const k = hand.straddleCount || 0;
    if (k === 0) return bb;
    const i = order.indexOf(bb);
    if (i === -1) return null;
    return order[(i + k) % order.length];
}

// 액티브 순서상 BB 바로 다음 좌석 (스트래들 스탯 den 대상)
function seatAfter(order, seat) {
    if (seat === null || order.length < 2) return null;
    const i = order.indexOf(seat);
    if (i === -1) return null;
    return order[(i + 1) % order.length];
}

// ─── 핸드 리플레이 (한 핸드에서 모든 플레이어의 스탯을 동시에 채운다) ───

function replayHand(hand, stats) {
    // 대상 플레이어가 sittingOut이거나 좌석에 없으면 그 핸드는 완전히 건너뛴다.
    const activeBySeat = new Map();
    for (const s of hand.seats) {
        if (!s || s.sittingOut) continue;
        const name = typeof s.name === 'string' ? s.name.trim() : '';
        if (!name) continue;
        activeBySeat.set(s.seat, { seat: s.seat, name, position: s.position ?? null });
    }
    if (activeBySeat.size === 0) return;

    const order = orderedActiveSeats(hand);
    const bb = bbSeatOf(hand, order);
    const lastOption = lastOptionSeatOf(hand, order, bb);
    const straddleSeat = seatAfter(order, bb);

    // dealt: 좌석에 있고 sittingOut 아니면 액션 여부와 무관하게 카운트 (핸드가 차례 전에 끝나도 포함)
    for (const s of activeBySeat.values()) {
        const st = ensureStats(stats, s.name);
        st.dealt += 1;
        st.vpip.den += 1;
        st.pfr.den += 1;
        const cat = positionCategory(s.position);
        if (cat) {
            const p = st.pos[cat];
            p.dealt += 1;
            p.vpip.den += 1;
            p.pfr.den += 1;
        }
        // Straddle: 본인이 액티브 순서상 BB 다음 좌석인 핸드가 den, 그 핸드에 스트래들이 있으면 num
        if (straddleSeat !== null && s.seat === straddleSeat) {
            st.straddle.den += 1;
            if ((hand.straddleCount || 0) > 0) st.straddle.num += 1;
        }
    }

    // 단일 리플레이 패스: 각 액션 시점의 raiseCount / limperCount / 어그레서를 추적
    let raiseCount = 0;
    let limperCount = 0;
    let aggressorSeat = null;      // 마지막 레이저
    let openerSeat = null;         // 최초 레이저 (raiseLevel 1)
    let openerPosition = null;
    let callsSinceLastRaise = 0;   // 마지막 레이즈 이후 콜 수 (FtS의 '사이 콜러 없음' 판정)
    const flags = new Map();       // name → 핸드당 1회 플래그

    for (const a of hand.actions) {
        if (!a || typeof a.seat !== 'number') continue;
        // HandRecord v2 may include postflop actions in the same event ledger.
        // Legacy records without a street are preflop records.
        if (a.street && String(a.street).toLowerCase() !== 'preflop') continue;
        const seatRec = activeBySeat.get(a.seat);

        if (seatRec) {
            const st = ensureStats(stats, seatRec.name);
            const f = ensureFlags(flags, seatRec.name);
            const pos = a.position ?? seatRec.position ?? null;
            const isVoluntary = a.type === 'call' || a.type === 'raise';

            // VPIP: call/raise 1회 이상. check는 절대 불포함 (BB/lastOption 체크 ≠ VPIP)
            if (isVoluntary && !f.vpip) {
                f.vpip = true;
                st.vpip.num += 1;
                const cat = positionCategory(seatRec.position);
                if (cat) st.pos[cat].vpip.num += 1;
            }
            // PFR: raise 1회 이상
            if (a.type === 'raise' && !f.pfr) {
                f.pfr = true;
                st.pfr.num += 1;
                const cat = positionCategory(seatRec.position);
                if (cat) st.pos[cat].pfr.num += 1;
            }
            // 3Bet: raiseCount===1 && 오픈이 본인 것 아님 상태로 액션 (핸드당 1회) / num: 그 시점 raise
            if (raiseCount === 1 && openerSeat !== a.seat && aggressorSeat !== a.seat && !f.threeBet) {
                f.threeBet = true;
                st.threeBet.den += 1;
                if (a.type === 'raise') st.threeBet.num += 1;
            }
            // Ft3B: 본인이 오픈한 뒤 정확히 raiseCount===2 상태로 액션 (핸드당 1회; 4벳 이상 국면 제외)
            // 4Bet: Ft3B와 동일 den / num: 그 시점 raise
            if (raiseCount === 2 && openerSeat === a.seat && aggressorSeat !== a.seat && !f.ft3b) {
                f.ft3b = true;
                st.ft3b.den += 1;
                st.fourBet.den += 1;
                if (a.type === 'fold') st.ft3b.num += 1;
                if (a.type === 'raise') st.fourBet.num += 1;
            }
            // ATS: 언오픈·언림프 팟에서 CO/BTN/SB 첫 진입 기회 / num: raise
            // 헤즈업 제외 — 블라인드 스틸은 3인 이상 테이블에서만 의미가 있다
            if (raiseCount === 0 && limperCount === 0 && order.length >= 3
                && STEAL_POSITIONS.includes(pos) && !f.ats) {
                f.ats = true;
                st.ats.den += 1;
                if (a.type === 'raise') st.ats.num += 1;
            }
            // FtS: SB/BB가 CO/BTN/SB의 첫 오픈(사이 콜러 없음)을 마주한 상황 / num: fold
            if (raiseCount === 1 && a.seat !== openerSeat && BLIND_POSITIONS.includes(pos)
                && STEAL_POSITIONS.includes(openerPosition) && callsSinceLastRaise === 0 && !f.fts) {
                f.fts = true;
                st.fts.den += 1;
                if (a.type === 'fold') st.fts.num += 1;
            }
            // OpenLimp: 언오픈·언림프 팟에서 lastOption 좌석이 아닌 첫 진입 기회 / num: call
            if (raiseCount === 0 && limperCount === 0 && lastOption !== null && a.seat !== lastOption && !f.openLimp) {
                f.openLimp = true;
                st.openLimp.den += 1;
                if (a.type === 'call') st.openLimp.num += 1;
            }
            // ColdCall: raiseCount>=1 && 본인의 이전 자발적 액션 없음 상태로 액션 (핸드당 1회) / num: call
            if (raiseCount >= 1 && !f.voluntary && !f.coldCall) {
                f.coldCall = true;
                st.coldCall.den += 1;
                if (a.type === 'call') st.coldCall.num += 1;
            }

            if (isVoluntary) f.voluntary = true;
        }

        // 팟 상태 갱신 (기회 판정 후) — 스트래들은 액션 레코드가 아니므로 raiseCount에 절대 불포함
        if (a.type === 'raise') {
            if (raiseCount === 0) {
                openerSeat = a.seat;
                openerPosition = a.position ?? (seatRec ? seatRec.position : null);
            }
            raiseCount += 1;
            aggressorSeat = a.seat;
            callsSinceLastRaise = 0;
        } else if (a.type === 'call') {
            if (raiseCount === 0) limperCount += 1;
            else callsSinceLastRaise += 1;
        }
    }
}

/**
 * 모든 플레이어의 통계를 핸드 레코드 배열에서 한 번의 리플레이 패스로 계산한다.
 * 각 스탯은 { num, den, pct } (pct는 반올림 정수, den 0이면 null).
 * @param {Array<object>} hands - HandRecord 배열 (진행 중 핸드 포함 가능; 잘못된 레코드는 건너뜀)
 * @param {{includeInProgressDetailed?: boolean}} [opts]
 *   includeInProgressDetailed: true면 진행 중(미완료) 상세 핸드도 일반 핸드처럼 리플레이
 *   한다 — 라이브 currentHand 포함 계약(설계 §6) 전용. 기본 false: 아카이브된 상세
 *   드래프트는 완료 표본이 아니므로 dealt/VPIP/PFR 분모에서 제외.
 * @returns {Map<string, object>} trim된 이름 → PlayerStats
 *   PlayerStats = { dealt, vpip, pfr, threeBet, ft3b, fourBet, ats, fts, openLimp,
 *                   coldCall, straddle, pos: {EP,MP,CO,BTN,SB,BB: {dealt, vpip, pfr}} }
 */
export function computeAllStats(hands, { includeInProgressDetailed = false } = {}) {
    const stats = new Map();
    if (!Array.isArray(hands)) return stats;
    for (const hand of hands) {
        if (!isValidHandRecord(hand)) continue;
        // Detailed hands can be archived as recoverable drafts when a session is
        // stopped mid-hand. They are evidence, but not a completed statistical
        // sample and must not inflate dealt/VPIP/PFR denominators.
        if (!includeInProgressDetailed
            && hand.detailed?.enabled && hand.detailed.completed !== true) continue;
        replayHand(hand, stats);
    }
    for (const st of stats.values()) finalizeStats(st);
    return stats;
}

/**
 * 단일 플레이어 편의 함수. 핸드에 등장하지 않는 이름이면 0으로 채워진 빈 PlayerStats를 반환한다.
 * @param {Array<object>} hands - HandRecord 배열
 * @param {string} playerName - 플레이어 이름 (trim 후 비교)
 * @returns {object} PlayerStats
 */
export function computeStats(hands, playerName) {
    const name = typeof playerName === 'string' ? playerName.trim() : '';
    const all = computeAllStats(hands);
    return all.get(name) || finalizeStats(newPlayerStats());
}
