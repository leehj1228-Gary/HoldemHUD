// 현 세션 통계 모달 (docs/REBUILD_DESIGN.md §7)
// 데이터 소스는 useGame().playerStats (statsEngine.computeAllStats 결과 Map) 단일 —
// 인라인 통계 계산 금지. 3Bet%는 기회 기반(threeBet.den), pct가 null(den 0)이면 '-' 표시.
// isHistoryMode + historyStats(Map)로 다른 핸드 집합의 통계도 같은 표로 재사용 가능.

import React from 'react';
import { useGame } from '../../state/GameContext';
import { POSITION_CATEGORIES } from '../../engine/schema';

// {num,den,pct} → 표시용 퍼센트 (den 0이면 null)
const pctOf = (stat) => (stat && stat.pct !== null && stat.pct !== undefined ? stat.pct : null);
const show = (v) => (v === null ? '-' : v);

const StatsModal = ({ isOpen, onClose, isHistoryMode = false, historyStats = null }) => {
    const { playerStats, resetAllData, navigateTo } = useGame();

    if (!isOpen) return null;

    const statsMap = isHistoryMode && historyStats ? historyStats : playerStats;
    const rows = [...statsMap.entries()];

    return (
        <div className="modal" style={{ display: 'block' }} onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <span className="close-btn" onClick={onClose}>&times;</span>
                <h3 className="modal-title">{isHistoryMode ? "Session History" : "Current Stats"}</h3>

                <div className="stats-section">
                    <div className="section-header">General (Preflop)</div>
                    <div className="stats-container">
                        <table className="stats-table">
                            <thead>
                                <tr>
                                    <th className="st-name">Player</th>
                                    <th>VPIP</th>
                                    <th>PFR</th>
                                    <th>ATS</th>
                                    <th>3Bet</th>
                                    <th>Fv3B</th>
                                    <th>4Bet</th>
                                    <th>FvS</th>
                                    <th>Limp</th>
                                    <th>CC</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(([name, st]) => {
                                    const vpip = pctOf(st.vpip);
                                    const pfr = pctOf(st.pfr);
                                    const ats = pctOf(st.ats);
                                    const b3 = pctOf(st.threeBet);   // 기회 기반 (den = 3벳 기회 수)
                                    const f3 = pctOf(st.ft3b);
                                    const b4 = pctOf(st.fourBet);
                                    const fts = pctOf(st.fts);
                                    const limp = pctOf(st.openLimp);
                                    const cc = pctOf(st.coldCall);

                                    return (
                                        <tr key={name}>
                                            <td className="st-name">{name}</td>
                                            <td style={{ color: vpip === null ? '#fff' : (vpip > 40 ? '#2ecc71' : '#e74c3c') }}>{show(vpip)}</td>
                                            <td style={{ color: pfr === null ? '#fff' : (pfr > 20 ? '#2ecc71' : '#e74c3c') }}>{show(pfr)}</td>
                                            <td style={{ color: ats !== null && ats > 35 ? '#e67e22' : '#fff' }}>{show(ats)}</td>
                                            <td>{show(b3)}</td>
                                            <td style={{ color: f3 !== null && f3 > 60 ? '#e74c3c' : '#fff' }}>{show(f3)}</td>
                                            <td>{show(b4)}</td>
                                            <td style={{ color: fts !== null && fts > 70 ? '#e74c3c' : '#fff' }}>{show(fts)}</td>
                                            <td>{show(limp)}</td>
                                            <td>{show(cc)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="stats-section">
                    <div className="section-header">Open Raise by Position</div>
                    <div className="stats-container">
                        <table className="stats-table">
                            <thead>
                                <tr>
                                    <th className="st-name">Player</th>
                                    {POSITION_CATEGORIES.map(pos => <th key={pos}>{pos}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(([name, st]) => (
                                    <tr key={name}>
                                        <td className="st-name">{name}</td>
                                        {POSITION_CATEGORIES.map(pos => {
                                            const entry = st.pos && st.pos[pos];
                                            const ph = entry ? entry.dealt : 0;
                                            const pp = entry ? pctOf(entry.pfr) : null;

                                            if (ph > 0 && pp !== null) {
                                                let c = '#fff';
                                                if (ph > 5) {
                                                    if (['EP', 'MP'].includes(pos) && pp > 25) c = '#e74c3c';
                                                    else if (['BTN', 'SB'].includes(pos) && pp > 40) c = '#2ecc71';
                                                }
                                                return (
                                                    <td key={pos} style={{ color: c }}>
                                                        {pp}<span style={{ fontSize: '0.6em', color: '#777' }}>({ph})</span>
                                                    </td>
                                                );
                                            }
                                            return <td key={pos}>-</td>;
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {!isHistoryMode && (
                    <button
                        className="reset-btn"
                        onClick={() => {
                            if (window.confirm('모든 데이터가 삭제됩니다 (세션 히스토리 포함). 계속하시겠습니까?')) {
                                resetAllData();
                                onClose();
                                navigateTo('home');
                            }
                        }}
                    >
                        ⚠️ 데이터 초기화
                    </button>
                )}
            </div>
        </div>
    );
};

export default StatsModal;
