// 플레이어 프로필 화면 (docs/REBUILD_DESIGN.md §7)
// 로스터 관리(이름 기준 추가/삭제) + 평생 통계(아카이브 전 세션 + 현 세션 핸드에서 파생).
// 통계는 statsEngine.computeAllStats 단일 구현만 사용 — 인라인 계산 금지.

import React, { useState, useMemo } from 'react';
import { useGame } from '../../state/GameContext';
import { computeAllStats } from '../../engine/statsEngine';
import { styleFor } from '../../engine/archetypes';

// {num,den,pct} 스탯 표시: den 0(pct null)이면 '-'
const fmtStat = (stat) =>
    stat && stat.pct !== null && stat.pct !== undefined ? `${stat.pct}%` : '-';

const ProfileScreen = () => {
    const { roster, addToRoster, removeFromRoster, goBack, archive, sessionHands, currentHand } = useGame();
    const [newName, setNewName] = useState('');
    const [selectedPlayer, setSelectedPlayer] = useState(null);

    // 평생 통계: 아카이브의 모든 세션 핸드 + 현 세션 핸드(진행 중 핸드 포함)를 한 번에 리플레이
    const lifetimeStats = useMemo(() => {
        const allHands = [
            ...archive.flatMap((s) => s.hands || []),
            ...sessionHands,
            ...(currentHand ? [currentHand] : []),
        ];
        return computeAllStats(allHands);
    }, [archive, sessionHands, currentHand]);

    const playerStats = selectedPlayer ? lifetimeStats.get(selectedPlayer.trim()) || null : null;
    const archetype = styleFor(playerStats);

    const handleAdd = () => {
        if (newName.trim()) {
            addToRoster(newName.trim());
            setNewName('');
        }
    };

    const handleRemove = (name) => {
        removeFromRoster(name);
        if (selectedPlayer === name) setSelectedPlayer(null);
    };

    return (
        <div id="profile-screen" className="screen active" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="screen-header" style={{ flexShrink: 0 }}>
                <button className="btn-home-nav" onClick={goBack}>
                    🏠 Home
                </button>
                <span className="screen-title">Player Profiles</span>
                <div style={{ width: '70px' }}></div>
            </div>

            <div className="profile-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Left Column: Player List */}
                <div className="player-list-col" style={{ width: '30%', borderRight: '1px solid #444', display: 'flex', flexDirection: 'column', background: '#2c3e50' }}>
                    <div className="input-group" style={{ padding: '10px', borderBottom: '1px solid #444' }}>
                        <input
                            type="text"
                            className="input-field"
                            placeholder="Add Player..."
                            style={{ background: 'white', color: 'black', border: '1px solid #ddd', width: '70%', marginRight: '5px' }}
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                        />
                        <button className="add-btn" onClick={handleAdd} style={{ width: '25%', padding: '5px' }}>Add</button>
                    </div>
                    <ul className="list-container" style={{ flex: 1, overflowY: 'auto', padding: '0', margin: '0' }}>
                        {roster.map((name) => (
                            <li
                                key={name}
                                className={`list-item ${selectedPlayer === name ? 'active' : ''}`}
                                onClick={() => setSelectedPlayer(name)}
                                style={{
                                    padding: '15px',
                                    borderBottom: '1px solid #444',
                                    cursor: 'pointer',
                                    background: selectedPlayer === name ? '#34495e' : 'transparent',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center'
                                }}
                            >
                                <span className="roster-name" style={{ color: 'white', fontWeight: selectedPlayer === name ? 'bold' : 'normal' }}>{name}</span>
                                <button
                                    className="roster-del"
                                    onClick={(e) => { e.stopPropagation(); handleRemove(name); }}
                                    style={{ background: '#c0392b', color: 'white', border: 'none', padding: '2px 6px', borderRadius: '3px', cursor: 'pointer', fontSize: '0.8em' }}
                                >
                                    X
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Right Column: Stats Detail */}
                <div className="stats-detail-col" style={{ flex: 1, padding: '20px', overflowY: 'auto', background: '#222' }}>
                    {selectedPlayer ? (
                        <div className="player-detail-card">
                            <div className="detail-header" style={{ borderBottom: '2px solid #3498db', paddingBottom: '10px', marginBottom: '20px' }}>
                                <h2 style={{ margin: 0, fontSize: '2em', color: '#ecf0f1' }}>{selectedPlayer}</h2>
                                <div className="player-badges" style={{ marginTop: '10px' }}>
                                    <span className="badge" style={{ background: archetype.color || '#f1c40f', color: '#fff', padding: '5px 15px', borderRadius: '20px', fontWeight: 'bold', fontSize: '1.2em', border: '1px solid rgba(255,255,255,0.2)' }}>
                                        {archetype.label}
                                    </span>
                                    <span style={{ marginLeft: '15px', color: '#bdc3c7' }}>
                                        Total Hands: {playerStats ? playerStats.dealt : 0}
                                    </span>
                                </div>
                                <p style={{ color: '#bdc3c7', marginTop: '10px', fontStyle: 'italic' }}>
                                    {archetype.description}
                                </p>
                            </div>

                            <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '15px' }}>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>VPIP</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#2ecc71' }}>{fmtStat(playerStats?.vpip)}</div>
                                </div>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>PFR</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#e74c3c' }}>{fmtStat(playerStats?.pfr)}</div>
                                </div>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>3-Bet</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#9b59b6' }}>{fmtStat(playerStats?.threeBet)}</div>
                                </div>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>Limp</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#f1c40f' }}>{fmtStat(playerStats?.openLimp)}</div>
                                </div>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>ATS</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#e67e22' }}>{fmtStat(playerStats?.ats)}</div>
                                </div>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>Fold to 3B</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#3498db' }}>{fmtStat(playerStats?.ft3b)}</div>
                                </div>
                                <div className="stat-box" style={{ background: '#34495e', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ color: '#bdc3c7', fontSize: '0.9em' }}>Cold Call</div>
                                    <div style={{ fontSize: '2em', fontWeight: 'bold', color: '#95a5a6' }}>{fmtStat(playerStats?.coldCall)}</div>
                                </div>
                            </div>

                            <div className="detailed-stats" style={{ marginTop: '30px', background: '#2c3e50', padding: '20px', borderRadius: '8px' }}>
                                <h4 style={{ borderBottom: '1px solid #7f8c8d', paddingBottom: '10px', marginTop: 0 }}>Detailed Analysis</h4>
                                <p style={{ color: '#bdc3c7', fontStyle: 'italic' }}>
                                    More detailed stats (WTSD, Aggression Factor, etc.) will appear here as more hand history is collected.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#7f8c8d', flexDirection: 'column' }}>
                            <span style={{ fontSize: '4em' }}>👈</span>
                            <h3>Select a player to view profile</h3>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ProfileScreen;
