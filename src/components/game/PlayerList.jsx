import React, { useMemo } from 'react';
import { useGame } from '../../state/GameContext';
import { styleFor, getStatColor } from '../../engine/archetypes';

// 마지막 액션 → 표시 문자열 (구 currentActionText 의미 보존)
const actionText = (a) => {
    switch (a.type) {
        case 'fold': return 'Fold';
        case 'check': return 'Check';
        case 'call': return 'Call';
        case 'raise': return a.raiseLevel <= 1 ? 'Raise' : `${a.raiseLevel + 1}-Bet`;
        default: return '';
    }
};

// 액티브 좌석을 seat 번호 오름차순으로
const activeSeatNumbers = (seats) =>
    seats.filter(s => !s.sittingOut).map(s => s.seat).sort((a, b) => a - b);

// 스트래들 좌석 = BB 다음 액티브 좌석부터 straddleCount개 (액티브 거리 기준 — positions Map 사용)
const straddleSeatSet = (seats, positions, straddleCount) => {
    const set = new Set();
    if (!straddleCount) return set;
    const active = activeSeatNumbers(seats);
    const t = active.length;
    const bbIdx = active.findIndex(seat => positions.get(seat) === 'BB');
    if (t < 2 || bbIdx === -1) return set;
    for (let k = 1; k <= straddleCount; k++) set.add(active[(bbIdx + k) % t]);
    return set;
};

const PlayerList = ({ onPlayerClick }) => {
    const {
        seats, straddleCount, currentHand, derived, positions,
        legalActionsFor, playerStats, recordAction, toggleSitOut,
    } = useGame();

    // 좌석별 마지막 액션 텍스트 (싯아웃은 'Sit Out')
    const actionTextBySeat = useMemo(() => {
        const map = new Map();
        if (currentHand) {
            for (const a of currentHand.actions) map.set(a.seat, actionText(a));
        }
        return map;
    }, [currentHand]);

    const straddleSeats = useMemo(
        () => straddleSeatSet(seats, positions, straddleCount),
        [seats, positions, straddleCount]);

    // 리스트 정렬: 액션할 차례 좌석부터. 핸드 종료/시작 전이면 첫 액션 좌석부터
    // (lastOption 다음 = BB에서 스트래들 수 + 1만큼 뒤의 액티브 좌석 — HU 포함).
    const orderedSeats = useMemo(() => {
        const nums = seats.map(s => s.seat).sort((a, b) => a - b);
        if (nums.length === 0) return nums;

        let startSeat = derived.toActSeat;
        if (startSeat === null) {
            const active = activeSeatNumbers(seats);
            const bbIdx = active.findIndex(seat => positions.get(seat) === 'BB');
            startSeat = bbIdx !== -1
                ? active[(bbIdx + straddleCount + 1) % active.length]
                : nums[0];
        }

        let startIdx = nums.indexOf(startSeat);
        if (startIdx === -1) startIdx = 0;
        return nums.map((_, i) => nums[(startIdx + i) % nums.length]);
    }, [seats, derived, positions, straddleCount]);

    const seatBy = useMemo(() => new Map(seats.map(s => [s.seat, s])), [seats]);

    return (
        <div id="players-container">
            {orderedSeats.map((seatNo) => {
                const p = seatBy.get(seatNo);
                if (!p) return null;

                const pn = positions.get(seatNo) || '';
                const isFolded = derived.foldedSeats.has(seatNo);
                const isToAct = derived.toActSeat === seatNo;

                // 통계는 전부 statsEngine 파생값에서 (설계 §7 — 인라인 계산 금지)
                const stats = playerStats.get(p.name);
                const vpipPct = stats && stats.vpip.pct !== null ? stats.vpip.pct : null;
                const pfrPct = stats && stats.pfr.pct !== null ? stats.pfr.pct : null;
                const handsDealt = stats ? stats.dealt : 0;

                const style = styleFor(stats);
                const typeColor = style.color;

                // 합법 액션 (sittingOut·폴드·핸드종료·차례아님 → [] — 버튼 비활성 근거)
                const legal = legalActionsFor(seatNo);
                const canCheck = legal.includes('check');
                const middleType = canCheck ? 'check' : 'call';

                let cardClass = 'player-card';
                if (isToAct && !isFolded) cardClass += ' active-action-card';
                if (pn === 'BTN') cardClass += ' pos-btn';
                if (pn === 'SB') cardClass += ' pos-sb';
                if (pn === 'BB') cardClass += ' pos-bb';
                if (pn === 'UTG') cardClass += ' pos-utg';
                if (isFolded) cardClass += ' folded';

                let posBadge = <span className={`pos-badge badge-${pn}`}>{pn}</span>;
                if (straddleSeats.has(seatNo)) {
                    posBadge = (
                        <>
                            <span className="pos-badge straddle-badge">S</span>{' '}
                            <span className={`pos-badge badge-${pn}`}>{pn}</span>
                        </>
                    );
                }

                const currentActionText = p.sittingOut
                    ? 'Sit Out'
                    : (actionTextBySeat.get(seatNo) || '');

                return (
                    <div
                        key={seatNo}
                        className={cardClass}
                        style={{
                            borderLeft: `5px solid ${typeColor}`,
                            borderLeftColor: typeColor,
                            opacity: p.sittingOut ? 0.6 : 1,
                            filter: p.sittingOut ? 'grayscale(0.8)' : 'none'
                        }}
                    >
                        <div className="player-header">
                            <div className="player-name-wrap" onClick={() => onPlayerClick(seatNo)}>
                                {posBadge}
                                <span className="player-name-text">
                                    {p.name.startsWith('Seat ') ? `Seat ${seatNo + 1}` : p.name}
                                </span>
                                <span style={{ fontSize: '0.7em', marginLeft: '5px', color: typeColor, border: `1px solid ${typeColor}`, borderRadius: '4px', padding: '0 4px' }}>
                                    {style.label}
                                </span>
                                <span className="current-action-text">{currentActionText}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <button
                                    onClick={(e) => { e.stopPropagation(); toggleSitOut(seatNo); }}
                                    style={{
                                        background: p.sittingOut ? '#e74c3c' : 'transparent',
                                        border: '1px solid #777',
                                        borderRadius: '4px',
                                        color: p.sittingOut ? 'white' : '#777',
                                        fontSize: '0.7em',
                                        padding: '2px 5px',
                                        cursor: 'pointer',
                                        fontWeight: 'bold'
                                    }}
                                >
                                    {p.sittingOut ? "I'm Back" : 'Sit Out'}
                                </button>
                                <span style={{ fontSize: '0.8em', color: '#777' }}>{handsDealt} Hands</span>
                            </div>
                        </div>

                        <div className="stats-row">
                            <div className="stat-item">
                                <div>VPIP</div>
                                <div className="stat-val" style={{ color: getStatColor('VPIP', vpipPct ?? 0) }}>
                                    {vpipPct === null ? '-' : `${vpipPct}%`}
                                </div>
                            </div>
                            <div className="stat-item">
                                <div>PFR</div>
                                <div className="stat-val" style={{ color: getStatColor('PFR', pfrPct ?? 0) }}>
                                    {pfrPct === null ? '-' : `${pfrPct}%`}
                                </div>
                            </div>
                        </div>

                        <div className="action-row">
                            <button
                                className={`btn btn-fold ${isFolded ? 'active' : ''}`}
                                onClick={(e) => { e.stopPropagation(); recordAction(seatNo, 'fold'); }}
                                disabled={!legal.includes('fold')}
                            >
                                Fold
                            </button>
                            <button
                                className="btn btn-check"
                                style={canCheck ? { backgroundColor: '#2ecc71' } : undefined}
                                onClick={(e) => { e.stopPropagation(); recordAction(seatNo, middleType); }}
                                disabled={!legal.includes(middleType)}
                            >
                                {canCheck ? 'Check' : 'Call'}
                            </button>
                            <button
                                className="btn btn-raise"
                                onClick={(e) => { e.stopPropagation(); recordAction(seatNo, 'raise'); }}
                                disabled={!legal.includes('raise')}
                            >
                                Raise
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default PlayerList;
