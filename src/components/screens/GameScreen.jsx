import React, { useState } from 'react';
import { useGame } from '../../state/GameContext';
import Table from '../game/Table';
import PlayerList from '../game/PlayerList';
import StatsModal from '../common/StatsModal';
import SeatModal from '../common/SeatModal';

const GameScreen = () => {
    const {
        seats, navigateTo, endSession, addSeat, removeSeat,
        straddleCount, cycleStraddle, nextHand, undo, swapSeats, setDealer,
        autoNextPending, cancelAutoNext,
        blinds, currency, currentHand, sessionHands,
    } = useGame();

    // 진행 중 핸드(액션 1개 이상)면 테이블 구성 변경 불가 — 리듀서가 no-op하므로 UI도 비활성화
    const handInProgress = !!(currentHand && currentHand.actions.length > 0);

    const [isStatsOpen, setIsStatsOpen] = useState(false);
    const [isSeatModalOpen, setIsSeatModalOpen] = useState(false);
    const [selectedSeatIndex, setSelectedSeatIndex] = useState(-1);
    const [isSwapMode, setIsSwapMode] = useState(false);
    const [swapSourceIndex, setSwapSourceIndex] = useState(null);
    const [isDealerMoveMode, setIsDealerMoveMode] = useState(false);
    const [isExitConfirmOpen, setIsExitConfirmOpen] = useState(false);

    // seat: 0-based 고정 좌석 번호 (설계 계약 §2)
    const handlePlayerClick = (seat) => {
        if (!seats.some(s => s.seat === seat)) return;

        if (isDealerMoveMode) {
            setDealer(seat);
            setIsDealerMoveMode(false);
            return;
        }

        if (isSwapMode) {
            if (swapSourceIndex === null) {
                setSwapSourceIndex(seat);
            } else {
                if (seat !== swapSourceIndex) {
                    swapSeats(swapSourceIndex, seat);
                }
                setIsSwapMode(false);
                setSwapSourceIndex(null);
            }
        } else {
            setSelectedSeatIndex(seat);
            setIsSeatModalOpen(true);
        }
    };

    return (
        <div id="game-screen" className={`screen active ${isSwapMode ? 'swap-mode-active' : ''}`}>
            <div className="game-top-bar">
                <button className="btn-home-nav" onClick={() => navigateTo('home')}>
                    🏠 Home
                </button>
                <button className="btn-save-exit" onClick={() => setIsExitConfirmOpen(true)}>
                    💾 저장 & 종료
                </button>
            </div>

            <div className="info-panel">
                <div>
                    <button
                        onClick={() => removeSeat()}
                        disabled={handInProgress}
                        style={{ padding: '5px 10px', fontWeight: 'bold', opacity: handInProgress ? 0.4 : 1 }}
                    >-</button>
                    <span id="player-count-display" style={{ fontWeight: 'bold', margin: '0 10px', fontSize: '1.2em' }}>
                        {seats.length}
                    </span>
                    <button
                        onClick={() => addSeat()}
                        disabled={handInProgress}
                        style={{ padding: '5px 10px', fontWeight: 'bold', opacity: handInProgress ? 0.4 : 1 }}
                    >+</button>
                </div>

                {/* Blinds Display */}
                <div className="blinds-display" style={{
                    color: '#ffffff',
                    fontSize: '1.2rem',
                    fontWeight: 'bold',
                    textShadow: '0 1px 2px rgba(0,0,0,0.5)'
                }}>
                    {blinds ? `${blinds.sb}${currency} / ${blinds.bb}${currency}` : ''}
                </div>

                <button
                    id="straddle-btn"
                    className={`straddle-toggle ${straddleCount > 0 ? 'active' : ''}`}
                    onClick={cycleStraddle}
                    disabled={handInProgress}
                    style={{ opacity: handInProgress ? 0.4 : 1 }}
                >
                    {straddleCount > 0 ? `Straddle: ${straddleCount}` : 'Straddle Off'}
                </button>
            </div>

            <Table
                onPlayerClick={handlePlayerClick}
                isSwapMode={isSwapMode}
                swapSourceIndex={swapSourceIndex}
                isDealerMoveMode={isDealerMoveMode}
                dealerToggleDisabled={handInProgress}
                onDealerClick={() => {
                    if (handInProgress) return; // 진행 중 핸드에서는 딜러 이동 모드 진입 금지
                    setIsDealerMoveMode(!isDealerMoveMode);
                    setIsSwapMode(false); // Cancel swap if active
                    setSwapSourceIndex(null);
                }}
            />

            {/* Total Hands Display */}
            <div className="total-hands-display" style={{
                width: '100%',
                padding: '0 15px',
                marginBottom: '5px',
                color: '#ffffff',
                fontSize: '0.9rem',
                textAlign: 'left',
                boxSizing: 'border-box'
            }}>
                {sessionHands.length} hands (Total)
            </div>

            <PlayerList onPlayerClick={handlePlayerClick} />

            {isSwapMode && (
                <div id="swap-msg" className="swap-msg" style={{ display: 'block' }}>
                    {swapSourceIndex === null ? '이동할 플레이어를 선택하세요' : '교체할 대상을 선택하세요'}
                </div>
            )}

            {isDealerMoveMode && (
                <div className="swap-msg" style={{ display: 'block', background: '#f1c40f', color: 'black' }}>
                    딜러 버튼을 이동할 자리를 선택하세요
                </div>
            )}

            {autoNextPending && (
                <div className="auto-next-overlay" style={{ display: 'flex' }}>
                    <div className="auto-next-text">Next Hand...</div>
                    <button className="auto-next-cancel" onClick={cancelAutoNext}>
                        Cancel
                    </button>
                </div>
            )}

            <div className="bottom-controls">
                <button className="ctrl-btn btn-next" onClick={nextHand}>
                    다음 핸드 ▶
                </button>
                <button className="ctrl-btn btn-coach" onClick={() => navigateTo('coach')} style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: '1px solid #5b6bdc' }}>
                    🤖 AI 코치
                </button>
                <button className="ctrl-btn btn-roster" onClick={() => navigateTo('profile')}>
                    👥 선수
                </button>
                <button className="ctrl-btn btn-stats" onClick={() => setIsStatsOpen(true)}>
                    📊 통계
                </button>
                <button
                    id="btn-swap"
                    className={`ctrl-btn btn-swap ${isSwapMode ? 'active' : ''}`}
                    disabled={handInProgress}
                    style={{ opacity: handInProgress ? 0.4 : 1 }}
                    onClick={() => {
                        setIsSwapMode(!isSwapMode);
                        setSwapSourceIndex(null);
                        setIsDealerMoveMode(false); // Cancel dealer move if active
                    }}
                >
                    {isSwapMode ? '취소' : '💺 자리이동'}
                </button>
                <button className="ctrl-btn btn-undo" onClick={undo}>
                    ↩️
                </button>
            </div>

            <StatsModal isOpen={isStatsOpen} onClose={() => setIsStatsOpen(false)} />

            <SeatModal
                isOpen={isSeatModalOpen}
                onClose={() => setIsSeatModalOpen(false)}
                seatIndex={selectedSeatIndex}
            />

            {isExitConfirmOpen && (
                <div className="modal" style={{ display: 'block' }}>
                    <div className="modal-content" style={{ maxWidth: '400px', textAlign: 'center' }}>
                        <h3 className="modal-title">저장 & 종료</h3>
                        <p style={{ margin: '20px 0', fontSize: '1.1em' }}>현재 게임을 저장하고 종료하시겠습니까?</p>
                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                            <button
                                className="btn"
                                style={{ background: '#7f8c8d', flex: 1 }}
                                onClick={() => setIsExitConfirmOpen(false)}
                            >
                                취소
                            </button>
                            <button
                                className="btn"
                                style={{ background: '#c0392b', flex: 1 }}
                                onClick={() => {
                                    // END_SESSION이 세션을 아카이브하고 nav를 ['home']으로 되돌린다 (설계 §6)
                                    endSession();
                                    setIsExitConfirmOpen(false);
                                }}
                            >
                                종료
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default GameScreen;
