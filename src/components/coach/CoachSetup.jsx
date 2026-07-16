// AI 코치 테이블 설정 (설계 §7 — S5)
// 게임에서 진입 시 세션의 실제 seats/포지션/blinds/스탯을 초기값으로 가져오고, 수동 설정도 지원한다.
// 구 CoachTable/CoachPlayerList의 시각 디자인을 이식 (seat-dot / dealer-btn-icon / player-card 클래스 유지).

import React, { useMemo, useState } from 'react';
import { useGame } from '../../state/GameContext.jsx';
import { positionsForHand, firstToActSeat } from '../../engine/handEngine.js';
import { LIVE_PLAYER_PRESETS, getStatColor, styleFor } from '../../engine/archetypes.js';

const MAX_SEATS = 9;

const BLINDS_OPTIONS = {
    '1/2': { sb: 1, bb: 2 },
    '2/5': { sb: 2, bb: 5 },
    '5/10': { sb: 5, bb: 10 },
};

function emptySlot(i) {
    return { seat: i, name: 'Empty', stack: 100, style: 'Unknown', isHero: false, action: null, stats: null, sittingOut: false };
}

// 프리셋 라벨에서 이모지(첫 토큰)를 뗀 이름 (설계 §7: 이모지 라벨이 아닌 이름 저장)
function presetName(label) {
    return label.replace(/^\S+\s+/, '').trim() || label;
}

// 구 CoachTable.jsx의 좌석 배치 로직 이식
function getSeatPosition(t, i) {
    if (t === 2) {
        const m = [{ x: 50, y: 85 }, { x: 50, y: 15 }];
        return m[i];
    } else if (t === 9) {
        const m = [
            { x: 50, y: 90 }, { x: 25, y: 82 }, { x: 8, y: 60 },
            { x: 8, y: 30 }, { x: 30, y: 12 }, { x: 70, y: 12 },
            { x: 92, y: 30 }, { x: 92, y: 60 }, { x: 75, y: 82 },
        ];
        return m[i];
    } else if (t === 6) {
        const m = [
            { x: 50, y: 88 }, { x: 15, y: 70 }, { x: 15, y: 30 },
            { x: 50, y: 12 }, { x: 85, y: 30 }, { x: 85, y: 70 },
        ];
        return m[i];
    }
    const a = (i / t) * 2 * Math.PI + (Math.PI / 2);
    const rx = 42, ry = 38;
    return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

const CoachSetup = ({ onAnalyze, isAnalyzing }) => {
    const { session, seats, dealerSeat, blinds, currency, straddleCount, roster, playerStats, addToRoster } = useGame();

    // 게임에서 진입한 경우 세션 스냅샷으로 초기화 (마운트 시 1회 — 이후엔 로컬 편집)
    // 세션 seat 번호는 REMOVE_SEAT로 구멍이 날 수 있으므로(비연속) raw seat이 아니라
    // session.seats의 "순서"대로 슬롯에 배치한다 (슬롯 index = 순서 index).
    const [slots, setSlots] = useState(() => {
        const base = Array.from({ length: MAX_SEATS }, (_, i) => emptySlot(i));
        if (session) {
            seats.forEach((s, idx) => {
                if (idx >= MAX_SEATS) return;
                const st = playerStats.get(s.name);
                base[idx] = {
                    ...base[idx],
                    name: s.name,
                    sittingOut: !!s.sittingOut,
                    style: styleFor(st).label,
                    stats: st ? { vpip: st.vpip.pct ?? 0, pfr: st.pfr.pct ?? 0 } : null,
                };
            });
        }
        return base;
    });
    const [playerCount, setPlayerCount] = useState(() =>
        session ? Math.min(MAX_SEATS, Math.max(2, seats.length)) : 6);
    // 딜러도 순서 기반 슬롯으로 매핑 — 딜러 좌석을 못 찾으면 첫 슬롯으로 폴백
    const [dealerIndex, setDealerIndex] = useState(() => {
        if (!session) return 0;
        const idx = seats.findIndex(s => s.seat === dealerSeat);
        return (idx >= 0 && idx < MAX_SEATS) ? idx : 0;
    });
    const [blindsKey, setBlindsKey] = useState('1/2');
    const [editingSeatIndex, setEditingSeatIndex] = useState(null);
    const [showRosterModal, setShowRosterModal] = useState(false);
    const [quickName, setQuickName] = useState('');

    const fromSession = !!session;
    const effectiveBlinds = fromSession ? blinds : BLINDS_OPTIONS[blindsKey];
    const effectiveCurrency = fromSession ? currency : '$';
    const effectiveStraddle = fromSession ? straddleCount : 0;

    const activeSlots = useMemo(() => slots.slice(0, playerCount), [slots, playerCount]);

    // 포지션은 엔진 위임 (인라인 계산 금지) — 좌석/딜러가 바뀔 때만 재계산
    const positions = useMemo(() => {
        const coachSeats = activeSlots.map(p => ({ seat: p.seat, name: p.name, sittingOut: p.sittingOut }));
        return positionsForHand(coachSeats, dealerIndex);
    }, [activeSlots, dealerIndex]);

    // 리스트는 프리플랍 액션 순서(첫 액션 좌석부터)로 정렬
    const orderedSlots = useMemo(() => {
        const coachSeats = activeSlots.map(p => ({ seat: p.seat, name: p.name, sittingOut: p.sittingOut }));
        const first = firstToActSeat(coachSeats, dealerIndex, 0);
        const start = typeof first === 'number' ? first : dealerIndex;
        const dist = (seat) => ((seat - start) % playerCount + playerCount) % playerCount;
        return activeSlots.slice().sort((a, b) => dist(a.seat) - dist(b.seat));
    }, [activeSlots, dealerIndex, playerCount]);

    const updateSlot = (seatIndex, updates) => {
        setSlots(prev => prev.map(p => {
            if (p.seat === seatIndex) return { ...p, ...updates };
            // Hero는 1명만 — 다른 좌석의 Hero 해제
            if (updates.isHero) return { ...p, isHero: false };
            return p;
        }));
    };

    const handleActionChange = (seatIndex, action) => {
        updateSlot(seatIndex, { action });
    };

    const handlePlayerSelect = (name, presetData = null) => {
        if (editingSeatIndex === null) return;
        updateSlot(editingSeatIndex, {
            name,
            sittingOut: false,
            stats: presetData ? { vpip: presetData.stats.vpip, pfr: presetData.stats.pfr } : null,
            style: presetData ? presetData.tags.join(', ') : 'Unknown',
        });
        setShowRosterModal(false);
    };

    const handleQuickAdd = () => {
        const name = quickName.trim();
        if (!name) return;
        addToRoster(name);
        handlePlayerSelect(name);
        setQuickName('');
    };

    const handleAnalyze = () => {
        const hero = activeSlots.find(p => p.isHero);
        if (!hero) {
            alert('Please select a Hero seat.');
            return;
        }
        const players = activeSlots
            .filter(p => p.isHero || (p.name !== 'Empty' && !p.sittingOut))
            .map(p => {
                // 스택 입력은 문자열로 저장되므로 페이로드 직전에 숫자로 강제 변환.
                // 유효하지 않은 값(NaN/음수/0/Infinity)은 100BB 기본값으로 대체한다.
                const stackNum = Number(p.stack);
                return {
                    seat: p.seat,
                    position: positions.get(p.seat) ?? null,
                    name: (p.isHero && p.name === 'Empty') ? 'Hero' : p.name,
                    stackBB: (Number.isFinite(stackNum) && stackNum > 0) ? stackNum : 100,
                    isHero: !!p.isHero,
                    stats: p.stats || null,
                    style: p.style,
                    action: p.action || null,
                };
            });
        onAnalyze({
            blinds: effectiveBlinds || null,
            currency: effectiveCurrency,
            straddleCount: effectiveStraddle,
            players,
            heroPosition: positions.get(hero.seat) ?? null,
        });
    };

    const editingSlot = editingSeatIndex !== null ? slots[editingSeatIndex] : null;

    return (
        <div className="setup-phase" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {/* 설정 행: 세션 진입 시 실제 blinds/currency 표시, 수동이면 선택 */}
            <div className="config-row" style={{ display: 'flex', gap: '20px', marginBottom: '10px', justifyContent: 'center', flexShrink: 0, alignItems: 'center' }}>
                {fromSession ? (
                    <span style={{ color: '#f1c40f', fontWeight: 'bold' }}>
                        Blinds: {effectiveBlinds
                            ? `${effectiveCurrency}${effectiveBlinds.sb}/${effectiveCurrency}${effectiveBlinds.bb}`
                            : '-'}
                        {effectiveStraddle > 0 ? ` · 스트래들 ×${effectiveStraddle}` : ''}
                        {` · ${playerCount} Players`}
                    </span>
                ) : (
                    <>
                        <label>
                            Blinds:
                            <select value={blindsKey} onChange={e => setBlindsKey(e.target.value)} style={{ marginLeft: '10px', padding: '5px', borderRadius: '5px' }}>
                                <option value="1/2">$1/$2</option>
                                <option value="2/5">$2/$5</option>
                                <option value="5/10">$5/$10</option>
                            </select>
                        </label>
                        <label>
                            Players:
                            <select value={playerCount} onChange={e => {
                                const count = Number.parseInt(e.target.value, 10);
                                if (Number.isNaN(count)) return;
                                setPlayerCount(count);
                                if (dealerIndex >= count) setDealerIndex(0);
                            }} style={{ marginLeft: '10px', padding: '5px', borderRadius: '5px' }}>
                                <option value={6}>6-Max</option>
                                <option value={9}>9-Max</option>
                            </select>
                        </label>
                    </>
                )}
            </div>

            {/* 테이블 뷰 (구 CoachTable 이식) */}
            <div style={{ flexShrink: 0 }}>
                <div className="table-view" style={{ margin: '20px auto', position: 'relative', height: '200px', maxWidth: '500px' }}>
                    <div className="table-label">COACH</div>

                    {activeSlots.map((p, i) => {
                        const pos = getSeatPosition(playerCount, i);
                        if (!pos) return null;

                        const style = {
                            left: `${pos.x}%`,
                            top: `${pos.y}%`,
                            cursor: 'pointer',
                            width: '45px',
                            height: '45px',
                            border: p.isHero ? '3px solid #e67e22' : '2px solid #ecf0f1',
                            background: p.name === 'Empty' ? '#7f8c8d' : '#fff',
                            color: p.name === 'Empty' ? '#ccc' : '#333',
                            zIndex: 10,
                            transition: 'all 0.3s ease',
                        };
                        if (p.action === 'fold' || p.sittingOut) {
                            style.background = '#7f8c8d';
                            style.color = '#ccc';
                            style.opacity = '0.6';
                            style.borderColor = '#7f8c8d';
                            style.textDecoration = 'line-through';
                        } else if (p.action === 'call' || p.action === 'raise') {
                            style.borderColor = p.action === 'raise' ? '#e74c3c' : '#3498db';
                            style.boxShadow = p.action === 'raise' ? '0 0 10px rgba(231, 76, 60, 0.5)' : 'none';
                        }

                        return (
                            <div
                                key={i}
                                className={p.isHero ? 'seat-dot hero-seat' : 'seat-dot'}
                                style={style}
                                onClick={() => setEditingSeatIndex(i)}
                                title={`Seat ${i + 1}`}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1' }}>
                                    <span style={{ fontSize: '0.7em', marginBottom: '2px' }}>{i + 1}</span>
                                    <span style={{ fontSize: '0.8em', fontWeight: 'bold', maxWidth: '40px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {p.name}
                                    </span>
                                    {p.name !== 'Empty' && (
                                        <span style={{ fontSize: '0.6em', color: '#555' }}>{p.stack}bb</span>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {/* 딜러 버튼 — 클릭 시 다음 좌석으로 이동 */}
                    {(() => {
                        const pos = getSeatPosition(playerCount, dealerIndex % playerCount);
                        if (!pos) return null;
                        const dx = 50 - pos.x;
                        const dy = 50 - pos.y;
                        const moveFactor = 0.25;
                        return (
                            <div
                                className="dealer-btn-icon"
                                style={{
                                    left: `${pos.x + dx * moveFactor}%`,
                                    top: `${pos.y + dy * moveFactor}%`,
                                    transform: 'translate(-50%, -50%)',
                                    cursor: 'pointer',
                                    width: '20px',
                                    height: '20px',
                                    fontSize: '12px',
                                    zIndex: 20,
                                }}
                                onClick={() => setDealerIndex(prev => (prev + 1) % playerCount)}
                                title="Click to move Dealer Button"
                            >
                                D
                            </div>
                        );
                    })()}

                    <div style={{ position: 'absolute', bottom: '-30px', width: '100%', textAlign: 'center', color: '#aaa', fontSize: '0.8em' }}>
                        Click seat to edit • Click 'D' to move Dealer
                    </div>
                </div>
            </div>

            {/* 플레이어 리스트 (구 CoachPlayerList 이식 — 액션 순서 정렬) */}
            <div id="players-container" style={{ marginTop: '10px', padding: '0 10px 10px 10px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
                {orderedSlots.map((p) => {
                    if (p.name === 'Empty' && !p.isHero) return null;

                    const pn = positions.get(p.seat) ?? '-';
                    const vpip = p.stats?.vpip ?? 0;
                    const pfr = p.stats?.pfr ?? 0;
                    const playerType = p.style || 'Unknown';

                    const typeColors = {
                        'Fish': '#2ECC71', 'Reg': '#E74C3c', 'Semi-Reg': '#F1C40F',
                        'Unknown': '#95A5A6', 'Nit': '#3498db', 'LAG': '#e67e22',
                    };
                    const typeColor = typeColors[playerType] || typeColors['Unknown'];

                    let cardClass = 'player-card';
                    if (pn === 'BTN') cardClass += ' pos-btn';
                    if (pn === 'SB') cardClass += ' pos-sb';
                    if (pn === 'BB') cardClass += ' pos-bb';
                    if (pn === 'UTG') cardClass += ' pos-utg';
                    if (p.action === 'fold' || p.sittingOut) cardClass += ' folded';

                    return (
                        <div
                            key={p.seat}
                            className={cardClass}
                            style={{ borderLeft: `5px solid ${typeColor}`, opacity: p.isHero ? 0.8 : 1, marginBottom: '8px' }}
                        >
                            <div className="player-header">
                                <div className="player-name-wrap">
                                    <span className={`pos-badge badge-${pn}`}>{pn}</span>
                                    <span className="player-name-text">{p.name}</span>
                                    <span style={{ fontSize: '0.7em', marginLeft: '5px', color: typeColor, border: `1px solid ${typeColor}`, borderRadius: '4px', padding: '0 4px' }}>
                                        {playerType}
                                    </span>
                                </div>
                                <span style={{ fontSize: '0.8em', color: '#777' }}>{p.stack} BB</span>
                            </div>

                            <div className="stats-row">
                                <div className="stat-item">
                                    <div>VPIP</div>
                                    <div className="stat-val" style={{ color: getStatColor('VPIP', vpip) }}>{vpip}%</div>
                                </div>
                                <div className="stat-item">
                                    <div>PFR</div>
                                    <div className="stat-val" style={{ color: getStatColor('PFR', pfr) }}>{pfr}%</div>
                                </div>
                            </div>

                            {!p.isHero && (
                                <div className="action-row">
                                    <button
                                        className={`btn btn-fold ${p.action === 'fold' ? 'active' : ''}`}
                                        onClick={() => handleActionChange(p.seat, p.action === 'fold' ? null : 'fold')}
                                    >
                                        Fold
                                    </button>
                                    <button
                                        className={`btn btn-check ${p.action === 'call' ? 'active' : ''}`}
                                        onClick={() => handleActionChange(p.seat, p.action === 'call' ? null : 'call')}
                                    >
                                        Call
                                    </button>
                                    <button
                                        className={`btn btn-raise ${p.action === 'raise' ? 'active' : ''}`}
                                        onClick={() => handleActionChange(p.seat, p.action === 'raise' ? null : 'raise')}
                                    >
                                        Raise
                                    </button>
                                </div>
                            )}
                            {p.isHero && (
                                <div className="action-row" style={{ justifyContent: 'center', color: '#f39c12', fontWeight: 'bold', padding: '10px 0' }}>
                                    HERO (To Act)
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div style={{ textAlign: 'center', marginTop: '10px', paddingBottom: '20px', flexShrink: 0 }}>
                <button
                    className="btn-analyze"
                    onClick={handleAnalyze}
                    disabled={isAnalyzing}
                    style={{
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        color: 'white',
                        padding: '15px 40px',
                        fontSize: '1.2rem',
                        border: 'none',
                        borderRadius: '30px',
                        cursor: isAnalyzing ? 'not-allowed' : 'pointer',
                        boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                    }}
                >
                    {isAnalyzing ? 'Analyzing...' : '🧠 Analyze Table'}
                </button>
            </div>

            {/* 좌석 편집 모달 (구 AICoachScreen 이식) */}
            {editingSlot && (
                <div className="modal" style={{ display: 'block' }} onClick={() => setEditingSeatIndex(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '350px' }}>
                        <h3 className="modal-title">Edit Seat {editingSeatIndex + 1}</h3>

                        <div className="setup-section">
                            <label>Player</label>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                <input
                                    type="text"
                                    value={editingSlot.name}
                                    readOnly
                                    className="setup-input"
                                    style={{ background: '#444', border: '1px solid #666' }}
                                />
                                <button
                                    className="add-btn"
                                    onClick={() => setShowRosterModal(true)}
                                    style={{ padding: '8px 15px' }}
                                >
                                    Select
                                </button>
                            </div>
                        </div>

                        <div className="setup-section">
                            <label>Stack (BB)</label>
                            <input
                                type="number"
                                value={editingSlot.stack}
                                onChange={(e) => updateSlot(editingSeatIndex, { stack: e.target.value })}
                                className="setup-input"
                            />
                        </div>

                        <div className="setup-section">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={editingSlot.isHero}
                                    onChange={(e) => updateSlot(editingSeatIndex, { isHero: e.target.checked })}
                                    style={{ width: '20px', height: '20px' }}
                                />
                                <span style={{ fontSize: '1.1em', fontWeight: 'bold', color: '#e67e22' }}>Is Hero?</span>
                            </label>
                        </div>

                        <div style={{ textAlign: 'center', marginTop: '20px' }}>
                            <button className="add-btn" onClick={() => setEditingSeatIndex(null)} style={{ width: '100%' }}>
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 로스터/프리셋 선택 모달 */}
            {showRosterModal && (
                <div className="modal" style={{ display: 'block' }} onClick={() => setShowRosterModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                        <span className="close-btn" onClick={() => setShowRosterModal(false)}>&times;</span>
                        <h3 className="modal-title">누구를 앉힐까요?</h3>

                        <div className="input-group">
                            <input
                                type="text"
                                className="input-field"
                                placeholder="새 이름 입력..."
                                value={quickName}
                                onChange={(e) => setQuickName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
                            />
                            <button className="add-btn" onClick={handleQuickAdd}>앉기</button>
                        </div>

                        <div style={{ marginTop: '20px' }}>
                            <h4 style={{ color: '#aaa', marginBottom: '10px', borderBottom: '1px solid #444' }}>기존 플레이어</h4>
                            <ul className="roster-list" style={{ maxHeight: '150px', overflowY: 'auto' }}>
                                {roster.length > 0 ? (
                                    roster.map((name, i) => (
                                        <li key={i} className="roster-item" onClick={() => handlePlayerSelect(name)}>
                                            <span className="roster-name">{name}</span>
                                        </li>
                                    ))
                                ) : (
                                    <li style={{ color: '#666', padding: '10px' }}>저장된 플레이어가 없습니다.</li>
                                )}
                            </ul>
                        </div>

                        <div style={{ marginTop: '20px' }}>
                            <h4 style={{ color: '#aaa', marginBottom: '10px', borderBottom: '1px solid #444' }}>프리셋 (가상 상대)</h4>
                            <ul className="roster-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                                {Object.values(LIVE_PLAYER_PRESETS).map((preset) => (
                                    <li
                                        key={preset.id}
                                        className="roster-item"
                                        onClick={() => handlePlayerSelect(presetName(preset.label), preset)}
                                        title={preset.description}
                                    >
                                        <span className="roster-name">{preset.label}</span>
                                        <span style={{ fontSize: '0.75em', color: '#888', marginLeft: '8px' }}>
                                            VPIP {preset.stats.vpip} / PFR {preset.stats.pfr}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default CoachSetup;
