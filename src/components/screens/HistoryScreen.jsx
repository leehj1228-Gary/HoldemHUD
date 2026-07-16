import React, { useState, useMemo } from 'react';
import { useGame } from '../../state/GameContext.jsx';
import { computeAllStats } from '../../engine/statsEngine.js';
import DetailedReviewPanel from '../history/DetailedReviewPanel.jsx';

const formatDate = (value) => {
    if (value === null || value === undefined || value === '') return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// 세션 카드/헤더의 블라인드·통화 표기 (legacy 세션은 blinds=null → '-')
const blindsLabel = (session) => {
    if (!session.blinds) return '-';
    const cur = session.currency || '$';
    return `${cur} ${session.blinds.sb}/${session.blinds.bb}`;
};

// 세션에 참가한(딜링된) 고유 플레이어 수
const playerCountOf = (session) => {
    const names = new Set();
    (session.hands || []).forEach(hand => {
        (hand.seats || []).forEach(s => {
            if (!s.sittingOut && s.name) names.add(s.name.trim());
        });
    });
    return names.size;
};

const incompleteCountOf = (session) => Number.isInteger(session?.incompleteHands)
    ? session.incompleteHands
    : (session?.hands || []).filter(hand => hand?.detailed?.enabled && !hand.detailed.completed).length;

// raiseLevel → '2-Bet'/'3-Bet'… 라벨 (1=오픈(2벳), 2=3벳, …)
const raiseLabel = (raiseLevel) => `${raiseLevel + 1}-Bet`;

const actionLabel = (type) => (type ? type.charAt(0).toUpperCase() + type.slice(1) : '-');

const formatCards = (cards) => (Array.isArray(cards) && cards.length > 0
    ? cards.map(card => String(card)
        .replace('s', '♠').replace('h', '♥').replace('d', '♦').replace('c', '♣')).join(' ')
    : '모름');

const amountLabel = (action) => {
    if (!['call', 'bet', 'raise'].includes(action?.type)) return '';
    if (action?.amountTo === null || action?.amountTo === undefined) {
        return action?.precision === 'unknown' ? '금액 모름' : '';
    }
    const prefix = action.precision === 'estimated' ? '≈' : '';
    return `${prefix}${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(action.amountTo)}`;
};

// 스탯별 색상 (구 화면 색 규칙 유지, den 0 → 회색)
const statColor = (label, pct) => {
    if (pct === null || pct === undefined) return '#95a5a6';
    if (label === 'VPIP') {
        if (pct > 40) return '#2ecc71';
        if (pct > 25) return '#f1c40f';
        return '#e74c3c';
    }
    if (label === 'PFR') {
        if (pct > 30) return '#2ecc71';
        if (pct > 15) return '#f1c40f';
        return '#e74c3c';
    }
    return '#3498db';
};

// stat: statsEngine의 { num, den, pct } — pct null이면 '-' 표시, count는 기회(den)
const StatBox = ({ label, stat }) => (
    <div className="stat-box">
        <div className="stat-label">{label}</div>
        <div className="stat-value" style={{ color: statColor(label, stat.pct) }}>
            {stat.pct === null ? '-' : stat.pct}
        </div>
        <div className="stat-count">({stat.den})</div>
    </div>
);

const HistoryScreen = () => {
    const { archive, deleteArchivedSession, goBack, settings } = useGame();
    const [selectedSessionId, setSelectedSessionId] = useState(null);
    const [viewMode, setViewMode] = useState('stats'); // 'stats' or 'hands'
    const [selectedHand, setSelectedHand] = useState(null);

    const selectedSession = useMemo(
        () => archive.find(s => s.id === selectedSessionId) || null,
        [archive, selectedSessionId]);

    // 세션 통계는 항상 핸드 레코드에서 파생 (설계 §7 — statsEngine이 유일한 통계 구현)
    const playerRows = useMemo(() => {
        if (!selectedSession) return [];
        const hands = selectedSession.hands || [];
        const stats = computeAllStats(hands);
        const firstSeat = new Map();
        hands.forEach(hand => {
            (hand.seats || []).forEach(s => {
                const name = (s.name || '').trim();
                if (name && !firstSeat.has(name)) firstSeat.set(name, s.seat);
            });
        });
        return [...stats.entries()].map(([name, playerStats]) => ({
            name,
            stats: playerStats,
            seat: firstSeat.has(name) ? firstSeat.get(name) : null,
        }));
    }, [selectedSession]);

    const handleSessionClick = (session) => {
        setSelectedSessionId(session.id);
        setViewMode('stats');
        setSelectedHand(null);
    };

    const handleBack = () => {
        if (selectedHand) {
            setSelectedHand(null);
        } else if (selectedSession) {
            setSelectedSessionId(null);
        } else {
            goBack();
        }
    };

    const handleDelete = (e, session) => {
        e.stopPropagation();
        if (window.confirm('이 세션 기록을 삭제하시겠습니까? 삭제하면 되돌릴 수 없습니다.')) {
            deleteArchivedSession(session.id);
        }
    };

    const renderHandDetail = () => {
        if (!selectedHand) return null;

        const detailed = selectedHand.detailed?.enabled ? selectedHand.detailed : null;
        const board = detailed?.board || {};
        const winners = Array.isArray(detailed?.winners) ? detailed.winners : [];
        const seatName = seat => selectedHand.seats?.find(player => player.seat === seat)?.name
            || `Seat ${Number(seat) + 1}`;

        return (
            <div className="hand-detail-view">
                <div className="detail-header">
                    <h3>Hand #{selectedHand.handNo}</h3>
                    <p>{formatDate(selectedHand.startedAt)}</p>
                    {detailed && <span className="detail-capture-badge">DETAILED · {detailed.completed ? 'COMPLETE' : 'INCOMPLETE'}</span>}
                </div>
                <div className="action-log">
                    {detailed && (
                        <div className="detailed-hand-summary">
                            <div><strong>Hero</strong> {detailed.heroSeat === null || detailed.heroSeat === undefined ? '미지정' : seatName(detailed.heroSeat)}</div>
                            <div><strong>Cards</strong> {formatCards(detailed.heroCards)}</div>
                            <div><strong>Flop</strong> {formatCards(board.flop)}</div>
                            <div><strong>Turn</strong> {formatCards(board.turn)}</div>
                            <div><strong>River</strong> {formatCards(board.river)}</div>
                            {winners.length > 0 && (
                                <div><strong>Winner</strong> {[...new Set(winners.map(winner => seatName(winner.seat)))].join(', ')}</div>
                            )}
                        </div>
                    )}
                    {selectedHand.actions && selectedHand.actions.length > 0 ? (
                        selectedHand.actions.map((action) => (
                            <div key={action.seq} className="action-row">
                                {detailed && <span className="action-street">{action.street || 'preflop'}</span>}
                                <span className="action-seat">Seat {action.seat + 1}</span>
                                <span className="action-pos">[{action.position || '-'}]</span>
                                <span className="action-name">({action.name})</span>
                                <span className="action-type">{actionLabel(action.type)}</span>
                                {action.type === 'raise' && action.raiseLevel > 0 && (
                                    <span className="action-detail"> [{raiseLabel(action.raiseLevel)}]</span>
                                )}
                                {detailed && amountLabel(action) && (
                                    <span className="action-amount"> → {amountLabel(action)}</span>
                                )}
                                {action.isAllIn && <span className="action-allin"> ALL-IN</span>}
                            </div>
                        ))
                    ) : (
                        <div className="no-data">No actions recorded for this hand.</div>
                    )}
                    {detailed && <DetailedReviewPanel hand={selectedHand} settings={settings} />}
                </div>
            </div>
        );
    };

    const renderHandList = () => {
        const hands = selectedSession.hands || [];

        if (selectedHand) return renderHandDetail();

        return (
            <div className="hand-list">
                {hands.length === 0 ? (
                    <div className="no-data">No hands recorded.</div>
                ) : (
                    hands.map((hand) => (
                        <div key={hand.id} className="hand-item" onClick={() => setSelectedHand(hand)}>
                            <div className="hand-info">
                                <span className="hand-id">Hand #{hand.handNo}</span>
                                <span className="hand-time">{formatDate(hand.startedAt)}</span>
                            </div>
                            <div className="hand-summary">
                                {(hand.seats || []).filter(s => !s.sittingOut).length} Players • {(hand.actions || []).length} Actions
                                {hand.detailed?.enabled ? ` • 상세${hand.detailed.completed ? '' : ' 초안'}` : ''}
                            </div>
                        </div>
                    ))
                )}
            </div>
        );
    };

    const renderStatsView = () => {
        return (
            <div className="stats-grid-container">
                {playerRows.length === 0 ? (
                    <div className="no-data" style={{ backgroundColor: '#2c3e50', padding: '15px' }}>
                        No stats available.
                    </div>
                ) : (
                    playerRows.map((row) => (
                        <div key={row.name} className="player-stat-row">
                            {/* Left Column: Info */}
                            <div className="player-info-col">
                                <div className="seat-label">
                                    {row.seat !== null ? `Seat ${row.seat + 1}` : '-'}
                                </div>
                                <div className="player-name">{row.name}</div>
                                <div className="hand-count">({row.stats.dealt})</div>
                            </div>

                            {/* Right Column: Stats Grid */}
                            <div className="player-stats-col">
                                <StatBox label="VPIP" stat={row.stats.vpip} />
                                <StatBox label="PFR" stat={row.stats.pfr} />
                                <StatBox label="3Bet" stat={row.stats.threeBet} />
                            </div>
                        </div>
                    ))
                )}
            </div>
        );
    };

    const renderDetailView = () => {
        if (!selectedSession) return null;

        return (
            <div className="history-detail-view">
                <div className="detail-header">
                    <h3>Session Details</h3>
                    <p>{formatDate(selectedSession.startedAt)}</p>
                    <p>
                        {selectedSession.totalHands} Hands Played
                        {incompleteCountOf(selectedSession) > 0 ? ` • ${incompleteCountOf(selectedSession)} Draft` : ''}
                        {' • '}Blinds: {blindsLabel(selectedSession)}
                    </p>

                    <div className="view-toggle">
                        <button
                            className={`toggle-btn ${viewMode === 'stats' ? 'active' : ''}`}
                            onClick={() => { setViewMode('stats'); setSelectedHand(null); }}
                        >
                            Stats
                        </button>
                        <button
                            className={`toggle-btn ${viewMode === 'hands' ? 'active' : ''}`}
                            onClick={() => setViewMode('hands')}
                        >
                            Hands
                        </button>
                    </div>
                </div>

                {viewMode === 'stats' ? renderStatsView() : renderHandList()}
            </div>
        );
    };

    return (
        <div id="history-screen" className="screen active">
            <div className="screen-header">
                <button className="back-btn" onClick={handleBack}>
                    ◀ Back
                </button>
                <h2>
                    {selectedHand ? `Hand #${selectedHand.handNo}` :
                        selectedSession ? 'Session Stats' : 'Session History'}
                </h2>
            </div>

            <div className="history-content">
                {!selectedSession ? (
                    <div className="session-list">
                        {archive.length === 0 ? (
                            <div className="no-data">No history found.</div>
                        ) : (
                            archive.map((session) => (
                                <div key={session.id} className="session-item" onClick={() => handleSessionClick(session)}>
                                    <div className="session-info">
                                        <div className="session-date">{formatDate(session.startedAt)}</div>
                                        <div className="session-details">
                                            {session.totalHands} Hands
                                            {incompleteCountOf(session) > 0 ? ` + ${incompleteCountOf(session)} Draft` : ''}
                                            {' • '}{playerCountOf(session)} Players • {blindsLabel(session)}
                                        </div>
                                    </div>
                                    <button
                                        className="delete-btn"
                                        onClick={(e) => handleDelete(e, session)}
                                    >
                                        🗑️
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                ) : (
                    renderDetailView()
                )}
            </div>

            <style>{`
                #history-screen {
                    display: flex;
                    flex-direction: column;
                    background-color: #2c3e50;
                    color: white;
                    overflow: hidden;
                }
                .screen-header {
                    display: flex;
                    align-items: center;
                    padding: 15px;
                    background-color: #34495e;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                    flex-shrink: 0;
                    z-index: 10;
                }
                .back-btn {
                    background: none;
                    border: none;
                    color: white;
                    font-size: 1.2em;
                    cursor: pointer;
                    margin-right: 15px;
                }
                .history-content {
                    flex: 1;
                    overflow: hidden;
                    padding: 15px;
                    display: flex;
                    flex-direction: column;
                    min-height: 0; /* Crucial for nested flex scrolling */
                }
                .session-list {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    flex: 1;
                    overflow-y: auto;
                    padding-right: 5px; /* Space for scrollbar */
                    min-height: 0;
                }
                .session-item {
                    background-color: #34495e;
                    padding: 15px;
                    border-radius: 8px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: pointer;
                    transition: background-color 0.2s;
                    flex-shrink: 0;
                }
                .session-item:active {
                    background-color: #2c3e50;
                }
                .session-date {
                    font-weight: bold;
                    font-size: 1.1em;
                    margin-bottom: 5px;
                }
                .session-details {
                    color: #bdc3c7;
                    font-size: 0.9em;
                }
                .delete-btn {
                    background: none;
                    border: none;
                    font-size: 1.2em;
                    cursor: pointer;
                    padding: 10px;
                }

                /* Detail View Styles */
                .history-detail-view {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    overflow: hidden;
                    min-height: 0;
                }
                .detail-header {
                    margin-bottom: 20px;
                    text-align: center;
                    border-bottom: 1px solid #7f8c8d;
                    padding-bottom: 10px;
                    flex-shrink: 0;
                }
                .view-toggle {
                    display: flex;
                    justify-content: center;
                    margin-top: 10px;
                    gap: 10px;
                }
                .toggle-btn {
                    background: #34495e;
                    border: 1px solid #7f8c8d;
                    color: #bdc3c7;
                    padding: 5px 15px;
                    border-radius: 20px;
                    cursor: pointer;
                }
                .toggle-btn.active {
                    background: #3498db;
                    color: white;
                    border-color: #3498db;
                }

                .stats-grid-container {
                    display: flex;
                    flex-direction: column;
                    gap: 2px; /* Small gap between rows */
                    background-color: #bdc3c7; /* Border color effect */
                    flex: 1;
                    overflow-y: auto;
                    padding-right: 5px;
                    min-height: 0;
                }
                .player-stat-row {
                    display: flex;
                    background-color: #ecf0f1; /* Light background for rows */
                    color: #2c3e50;
                    flex-shrink: 0;
                }
                .player-info-col {
                    width: 80px;
                    padding: 10px 5px;
                    background-color: #dfe6e9;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    border-right: 1px solid #bdc3c7;
                }
                .seat-label {
                    font-size: 0.8em;
                    color: #7f8c8d;
                }
                .player-name {
                    font-weight: bold;
                    font-size: 0.9em;
                    margin: 2px 0;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .hand-count {
                    font-size: 0.8em;
                    color: #7f8c8d;
                }
                .player-stats-col {
                    flex: 1;
                    display: flex;
                    overflow-x: auto; /* Allow horizontal scroll if many stats */
                }
                .stat-box {
                    flex: 1;
                    min-width: 50px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 5px;
                    border-right: 1px solid #bdc3c7;
                    background-color: #ecf0f1;
                }
                .stat-label {
                    font-size: 0.7em;
                    color: #7f8c8d;
                    font-weight: bold;
                    margin-bottom: 2px;
                }
                .stat-value {
                    font-size: 1.1em;
                    font-weight: bold;
                }
                .stat-count {
                    font-size: 0.7em;
                    color: #95a5a6;
                }

                /* Hand List Styles */
                .hand-list {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    flex: 1;
                    overflow-y: auto;
                    padding-right: 5px;
                    min-height: 0;
                }
                .hand-item {
                    background-color: #34495e;
                    padding: 15px;
                    border-radius: 8px;
                    cursor: pointer;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-shrink: 0;
                }
                .hand-info {
                    display: flex;
                    flex-direction: column;
                }
                .hand-id {
                    font-weight: bold;
                    color: #3498db;
                }
                .hand-time {
                    font-size: 0.8em;
                    color: #95a5a6;
                }
                .hand-summary {
                    color: #bdc3c7;
                    font-size: 0.9em;
                }

                /* Hand Detail Styles */
                .hand-detail-view {
                    background-color: #34495e;
                    padding: 15px;
                    border-radius: 8px;
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    overflow: hidden;
                    min-height: 0;
                }
                .detail-capture-badge {
                    display: inline-block;
                    padding: 4px 8px;
                    border: 1px solid #38bdf8;
                    border-radius: 999px;
                    color: #bae6fd;
                    background: #075985;
                    font-size: 0.68rem;
                    font-weight: 900;
                    letter-spacing: 0.05em;
                }
                .action-log {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin-top: 10px;
                    flex: 1;
                    overflow-y: auto;
                    padding-right: 5px;
                    min-height: 0;
                }
                .detailed-hand-summary {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 7px;
                    padding: 12px;
                    border: 1px solid #475569;
                    border-radius: 10px;
                    background: #0f172a;
                    color: #cbd5e1;
                    font-size: 0.78rem;
                }
                .detailed-hand-summary strong {
                    display: block;
                    margin-bottom: 2px;
                    color: #38bdf8;
                    font-size: 0.65rem;
                    text-transform: uppercase;
                }
                .action-row {
                    padding: 8px;
                    background-color: #2c3e50;
                    border-radius: 4px;
                    font-size: 0.9em;
                    flex-shrink: 0;
                }
                .action-seat {
                    color: #f1c40f;
                    font-weight: bold;
                    margin-right: 5px;
                }
                .action-pos {
                    color: #3498db;
                    font-weight: bold;
                    margin-right: 5px;
                    font-size: 0.9em;
                }
                .action-name {
                    color: #bdc3c7;
                    margin-right: 10px;
                }
                .action-type {
                    font-weight: bold;
                    color: white;
                }
                .action-detail {
                    color: #e74c3c;
                    margin-left: 5px;
                }
                .action-street {
                    display: inline-block;
                    min-width: 46px;
                    margin-right: 7px;
                    padding: 2px 5px;
                    border-radius: 5px;
                    background: #1e293b;
                    color: #93c5fd;
                    font-size: 0.65rem;
                    font-weight: bold;
                    text-transform: uppercase;
                }
                .action-amount {
                    color: #fbbf24;
                    font-weight: bold;
                }
                .action-allin {
                    color: #fb7185;
                    font-size: 0.72rem;
                    font-weight: 900;
                }
            `}</style>
        </div>
    );
};

export default HistoryScreen;
