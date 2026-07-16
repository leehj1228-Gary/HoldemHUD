import React, { useMemo } from 'react';
import { useGame } from '../../state/GameContext';

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

const Table = ({ onPlayerClick, isSwapMode, swapSourceIndex, isDealerMoveMode, onDealerClick, dealerToggleDisabled = false }) => {
    const { seats, dealerSeat, straddleCount, currentHand, derived, positions } = useGame();

    const getSeatPosition = (t, i) => {
        if (t === 2) {
            const m = [{ x: 50, y: 85 }, { x: 50, y: 15 }];
            return m[i];
        } else if (t === 9) {
            const m = [
                { x: 50, y: 90 }, { x: 25, y: 82 }, { x: 8, y: 60 },
                { x: 8, y: 30 }, { x: 30, y: 12 }, { x: 70, y: 12 },
                { x: 92, y: 30 }, { x: 92, y: 60 }, { x: 75, y: 82 }
            ];
            return m[i];
        } else if (t === 6) {
            const m = [
                { x: 50, y: 88 }, { x: 15, y: 70 }, { x: 15, y: 30 },
                { x: 50, y: 12 }, { x: 85, y: 30 }, { x: 85, y: 70 }
            ];
            return m[i];
        } else {
            const a = (i / t) * 2 * Math.PI + (Math.PI / 2);
            const rx = 42, ry = 38;
            return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
        }
    };

    // 딜러 표시는 액티브 기준: positions에서 'BTN'인 좌석 (딜러가 싯아웃이면 다음 액티브 좌석)
    const buttonSeat = useMemo(() => {
        for (const [seat, pos] of positions.entries()) {
            if (pos === 'BTN') return seat;
        }
        return dealerSeat;
    }, [positions, dealerSeat]);

    // 좌석별 액션 여부 (이번 핸드에서 액션했으면 흰 배경 — 구 currentActionText 의미 보존)
    const actedSeats = useMemo(() => {
        const set = new Set();
        if (currentHand) for (const a of currentHand.actions) set.add(a.seat);
        return set;
    }, [currentHand]);

    const straddleSeats = useMemo(
        () => straddleSeatSet(seats, positions, straddleCount),
        [seats, positions, straddleCount]);

    const dealerIdx = seats.findIndex(s => s.seat === buttonSeat);

    return (
        <div className="table-view" id="tableView">
            <div className="table-label">POKER</div>
            {seats.map((p, i) => {
                const pos = getSeatPosition(seats.length, i);
                const isFolded = derived.foldedSeats.has(p.seat);

                let className = 'seat-dot';
                if (p.seat === buttonSeat) className += ' active-dealer';
                if (p.seat === derived.toActSeat && !isFolded) className += ' active-action';

                // Swap mode highlighting
                if (isSwapMode) {
                    className += ' swap-target'; // Add a class to indicate clickable
                    if (swapSourceIndex !== null && p.seat === swapSourceIndex) {
                        className += ' selected-swap-source';
                    }
                }

                // Dealer move mode highlighting
                if (isDealerMoveMode) {
                    className += ' swap-target'; // Reuse clickable cursor style
                }

                let displayName = p.name.slice(0, 4);
                if (p.name.startsWith('Seat ')) displayName = p.seat + 1;

                const style = {
                    left: `${pos.x}%`,
                    top: `${pos.y}%`,
                };

                if (isFolded) {
                    style.background = '#7f8c8d';
                    style.color = '#ccc';
                    style.opacity = '0.5';
                    style.borderColor = '#7f8c8d';
                } else if (actedSeats.has(p.seat) || p.sittingOut) {
                    style.background = '#fff';
                    style.borderColor = '#bdc3c7';
                }

                return (
                    <div
                        key={p.seat}
                        className={className}
                        style={style}
                        onClick={() => onPlayerClick(p.seat)}
                    >
                        <span>{displayName}</span>
                        {straddleSeats.has(p.seat) && <div className="straddle-dot-badge">S</div>}
                    </div>
                );
            })}

            {/* Dealer Button Icon */}
            {seats.length > 0 && (() => {
                const pos = getSeatPosition(seats.length, dealerIdx === -1 ? 0 : dealerIdx);
                const dealerStyle = {
                    left: `${pos.x + 5}%`,
                    top: `${pos.y + 5}%`,
                    cursor: dealerToggleDisabled ? 'default' : 'pointer',
                    pointerEvents: 'auto' // Override pointer-events: none from css
                };

                // 진행 중 핸드 — 딜러 이동 토글 비활성화 (감소된 불투명도로 표시)
                if (dealerToggleDisabled) {
                    dealerStyle.opacity = 0.4;
                }

                if (isDealerMoveMode) {
                    dealerStyle.transform = 'translate(-140%, -140%) scale(1.2)';
                    dealerStyle.boxShadow = '0 0 15px #f1c40f';
                    dealerStyle.zIndex = 100;
                }

                return (
                    <div
                        className="dealer-btn-icon"
                        style={dealerStyle}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (dealerToggleDisabled) return;
                            onDealerClick();
                        }}
                    >
                        D
                    </div>
                );
            })()}
        </div>
    );
};

export default Table;
