// 세션 리크 파인더 (설계 §7 — S5)
// 분석 대상 = 아카이브 + 현재 세션 핸드. 히어로는 실제 핸드에 등장하는 이름 목록에서 선택(가공의 'Hero' 기본값 금지).
// evidenceHands는 handNo 정수 배열로 받아 실제 분석 핸드 목록에서 조회한다 (정규식 텍스트 파싱 폐지).

import React, { useMemo, useState } from 'react';
import { useGame } from '../../state/GameContext.jsx';
import { computeAllStats } from '../../engine/statsEngine.js';
import { analyzeSessionLeaks, selectHeroHands } from '../../services/aiService.js';

function activeNamesOf(hand) {
    const names = [];
    if (hand && Array.isArray(hand.seats)) {
        for (const s of hand.seats) {
            if (s && !s.sittingOut && typeof s.name === 'string' && s.name.trim()) names.push(s.name.trim());
        }
    }
    return names;
}

function sessionDateLabel(startedAt) {
    if (!startedAt) return '이전 세션';
    const d = new Date(startedAt);
    if (Number.isNaN(d.getTime())) return '이전 세션';
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// raise면 raiseLevel을 벳 레벨 라벨로 (1=2-Bet, 2=3-Bet, …)
function actionLabel(action) {
    const type = action.type ? action.type.charAt(0).toUpperCase() + action.type.slice(1) : '?';
    if (action.type === 'raise' && action.raiseLevel >= 1) return `${type} (${action.raiseLevel + 1}-Bet)`;
    return type;
}

const SessionLeaks = ({ ai }) => {
    const { archive, sessionHands, session } = useGame();

    const [selectedSessions, setSelectedSessions] = useState([]);
    const [selectedHero, setSelectedHero] = useState('');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [result, setResult] = useState(null);
    const [analyzedHands, setAnalyzedHands] = useState([]);
    const [analyzedHero, setAnalyzedHero] = useState('');
    const [selectedHandForReplay, setSelectedHandForReplay] = useState(null);

    // 분석 가능 세션 = 현재 세션 + 아카이브
    const sessionOptions = useMemo(() => {
        const options = [];
        if (session) {
            options.push({ id: 'current', label: 'Current Session', sub: `${sessionHands.length} Hands`, hands: sessionHands });
        }
        for (const s of archive) {
            const hands = Array.isArray(s.hands) ? s.hands : [];
            const playerCount = new Set(hands.flatMap(activeNamesOf)).size;
            options.push({
                id: s.id,
                label: sessionDateLabel(s.startedAt),
                sub: `${hands.length} Hands • ${playerCount} Players`,
                hands,
            });
        }
        return options;
    }, [session, sessionHands, archive]);

    // 선택된 세션들의 핸드 (아무것도 선택 안 하면 현재 세션으로 폴백 — 구 동작 유지)
    const handsToAnalyze = useMemo(() => {
        const picked = selectedSessions.length > 0
            ? sessionOptions.filter(o => selectedSessions.includes(o.id))
            : sessionOptions.filter(o => o.id === 'current');
        return picked.flatMap(o => o.hands);
    }, [selectedSessions, sessionOptions]);

    // 히어로 후보 = 분석 대상 핸드에 실제로 등장하는 이름들
    const availableHeroes = useMemo(() => {
        const names = new Set();
        for (const hand of handsToAnalyze) for (const name of activeNamesOf(hand)) names.add(name);
        return Array.from(names).sort((a, b) => a.localeCompare(b));
    }, [handsToAnalyze]);

    const effectiveHero = availableHeroes.includes(selectedHero) ? selectedHero : '';

    const toggleSessionSelection = (sessionId) => {
        setSelectedSessions(prev => (
            prev.includes(sessionId) ? prev.filter(id => id !== sessionId) : [...prev, sessionId]
        ));
    };

    const toggleAllSessions = () => {
        setSelectedSessions(prev => (
            prev.length === sessionOptions.length ? [] : sessionOptions.map(o => o.id)
        ));
    };

    const openHand = (handNo) => {
        const hand = analyzedHands.find(h => h.handNo === handNo);
        if (hand) setSelectedHandForReplay(hand);
        else alert(`Hand #${handNo} 정보를 찾을 수 없습니다.`);
    };

    const runSessionAnalysis = async () => {
        if (handsToAnalyze.length === 0) {
            alert('선택한 세션에 분석할 핸드가 없습니다.');
            return;
        }
        if (!effectiveHero) {
            alert('히어로를 선택하세요.');
            return;
        }
        // 히어로 핸드 0개면 실행 차단 (가공의 'Hero'로 빈 분석을 돌리지 않는다)
        const prepared = selectHeroHands(handsToAnalyze, effectiveHero);
        if (prepared.length === 0) {
            alert(`선택한 세션에 '${effectiveHero}'의 핸드가 없습니다.`);
            return;
        }

        // 상대 스탯은 statsEngine의 퍼센트 값으로 (hands = dealt 표본 크기)
        const stats = computeAllStats(prepared);
        const opponentStats = [];
        for (const [name, st] of stats) {
            if (name === effectiveHero) continue;
            opponentStats.push({
                name,
                hands: st.dealt,
                vpip: st.vpip.pct,
                pfr: st.pfr.pct,
                threeBet: st.threeBet.pct,
                ft3b: st.ft3b.pct,
                fts: st.fts.pct,
            });
        }

        setIsAnalyzing(true);
        try {
            const analysis = await analyzeSessionLeaks(
                { hands: prepared, heroName: effectiveHero, opponentStats }, ai);
            setResult(analysis);
            setAnalyzedHands(prepared);
            setAnalyzedHero(effectiveHero);
        } catch (error) {
            console.error('Session Analysis error:', error);
            alert(error?.message || 'Session Analysis failed. Please try again.');
        } finally {
            setIsAnalyzing(false);
        }
    };

    // evidenceHands 정수 → 클릭 가능한 핸드 링크 칩
    const renderHandChips = (handNos) => {
        const list = Array.isArray(handNos) ? handNos.filter(n => Number.isInteger(n)) : [];
        if (list.length === 0) return null;
        return (
            <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {list.map((no, idx) => (
                    <button
                        key={`${no}-${idx}`}
                        onClick={() => openHand(no)}
                        style={{
                            background: 'rgba(52, 152, 219, 0.15)', color: '#3498db', border: '1px solid #3498db',
                            borderRadius: '12px', padding: '2px 10px', fontSize: '0.85em', fontWeight: 'bold', cursor: 'pointer',
                        }}
                    >
                        Hand #{no}
                    </button>
                ))}
            </div>
        );
    };

    return (
        <div className="session-analysis-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '20px' }}>
            {!result ? (
                <div style={{ maxWidth: '600px', margin: '0 auto', width: '100%' }}>
                    <div style={{ textAlign: 'center', marginBottom: '30px' }}>
                        <div style={{ fontSize: '3em', marginBottom: '10px' }}>🕵️‍♂️</div>
                        <h3>Session Leak Finder</h3>
                        <p style={{ color: '#bdc3c7' }}>Select a Hero and sessions to analyze for strategic leaks.</p>
                    </div>

                    <div className="config-section" style={{ background: '#34495e', padding: '20px', borderRadius: '10px', marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '10px', color: '#f1c40f', fontWeight: 'bold' }}>Select Hero:</label>
                        <select
                            value={effectiveHero}
                            onChange={e => setSelectedHero(e.target.value)}
                            style={{ width: '100%', padding: '10px', borderRadius: '5px', background: '#2c3e50', color: 'white', border: '1px solid #444' }}
                        >
                            <option value="">-- 히어로 선택 --</option>
                            {availableHeroes.map((name) => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                        {availableHeroes.length === 0 && (
                            <p style={{ color: '#e67e22', fontSize: '0.85em', marginTop: '10px', marginBottom: 0 }}>
                                선택한 세션에 플레이어가 없습니다. 세션을 선택하거나 핸드를 기록하세요.
                            </p>
                        )}
                    </div>

                    <div className="config-section" style={{ background: '#34495e', padding: '20px', borderRadius: '10px', marginBottom: '20px', maxHeight: '300px', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                            <label style={{ color: '#f1c40f', fontWeight: 'bold' }}>Select Sessions:</label>
                            <button onClick={toggleAllSessions} style={{ background: 'none', border: 'none', color: '#3498db', cursor: 'pointer' }}>Select All</button>
                        </div>
                        <div className="session-list" style={{ overflowY: 'auto', flex: 1 }}>
                            {sessionOptions.length === 0 && (
                                <div style={{ color: '#7f8c8d', fontStyle: 'italic', padding: '10px', textAlign: 'center' }}>
                                    분석할 세션이 없습니다.
                                </div>
                            )}
                            {sessionOptions.map((option) => (
                                <div
                                    key={option.id}
                                    onClick={() => toggleSessionSelection(option.id)}
                                    style={{
                                        display: 'flex', alignItems: 'center', padding: '10px', marginBottom: '5px', borderRadius: '5px', cursor: 'pointer',
                                        background: selectedSessions.includes(option.id) ? '#2ecc71' : '#2c3e50',
                                        color: selectedSessions.includes(option.id) ? '#2c3e50' : '#bdc3c7',
                                    }}
                                >
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 'bold' }}>{option.label}</div>
                                        <div style={{ fontSize: '0.8em' }}>{option.sub}</div>
                                    </div>
                                    {selectedSessions.includes(option.id) && <span>✓</span>}
                                </div>
                            ))}
                        </div>
                    </div>

                    <button
                        onClick={runSessionAnalysis}
                        disabled={isAnalyzing}
                        style={{
                            width: '100%', padding: '15px', borderRadius: '30px', border: 'none',
                            background: '#c0392b', color: 'white', fontSize: '1.2em', fontWeight: 'bold', cursor: 'pointer',
                            opacity: isAnalyzing ? 0.7 : 1,
                        }}
                    >
                        {isAnalyzing ? 'Analyzing Leaks...' : `Analyze ${selectedSessions.length > 0 ? selectedSessions.length : 'Current'} Session(s)`}
                    </button>
                </div>
            ) : (
                <div className="results-view" style={{ flex: 1, overflowY: 'auto' }}>
                    <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                        <div style={{ fontSize: '4em', color: '#f1c40f', fontWeight: 'bold' }}>{result.overallScore}</div>
                        <div style={{ color: '#bdc3c7' }}>Overall Score</div>
                    </div>

                    <div className="summary-box" style={{ background: '#34495e', padding: '20px', borderRadius: '10px', marginBottom: '20px' }}>
                        <h4 style={{ marginTop: 0 }}>📝 Summary</h4>
                        <p style={{ lineHeight: '1.6' }}>{result.summary}</p>
                    </div>

                    <h4 style={{ color: '#e74c3c', borderBottom: '1px solid #e74c3c', paddingBottom: '5px' }}>🚨 Major Leaks</h4>
                    {result.majorLeaks?.map((leak, idx) => (
                        <div key={idx} className="leak-card" style={{ background: '#2c3e50', border: '1px solid #444', borderRadius: '8px', padding: '15px', marginBottom: '15px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                <span style={{ fontWeight: 'bold', fontSize: '1.1em', color: '#e74c3c' }}>{leak.title}</span>
                                <span style={{ background: leak.severity === 'High' ? '#c0392b' : '#e67e22', color: 'white', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8em' }}>{leak.severity}</span>
                            </div>
                            <p style={{ marginBottom: '10px', color: '#ecf0f1' }}>{leak.description}</p>
                            <div style={{ background: 'rgba(46, 204, 113, 0.1)', padding: '10px', borderRadius: '5px', borderLeft: '3px solid #2ecc71' }}>
                                <span style={{ color: '#2ecc71', fontWeight: 'bold' }}>✅ Fix:</span>
                                <p style={{ margin: '5px 0 0 0', fontSize: '0.95em' }}>{leak.fix}</p>
                            </div>
                            {renderHandChips(leak.evidenceHands)}
                        </div>
                    ))}

                    <h4 style={{ color: '#2ecc71', borderBottom: '1px solid #2ecc71', paddingBottom: '5px', marginTop: '30px' }}>👍 Good Plays</h4>
                    <ul style={{ paddingLeft: '20px' }}>
                        {result.goodPlays?.map((play, idx) => {
                            // 새 포맷 {handNo, text} — 방어적으로 문자열도 처리
                            const text = typeof play === 'string' ? play : play?.text;
                            const handNo = play && typeof play === 'object' && Number.isInteger(play.handNo) ? play.handNo : null;
                            return (
                                <li key={idx} style={{ marginBottom: '10px', lineHeight: '1.5' }}>
                                    {text}
                                    {handNo !== null && (
                                        <button
                                            onClick={() => openHand(handNo)}
                                            style={{
                                                marginLeft: '8px', background: 'rgba(52, 152, 219, 0.15)', color: '#3498db',
                                                border: '1px solid #3498db', borderRadius: '12px', padding: '1px 8px',
                                                fontSize: '0.8em', fontWeight: 'bold', cursor: 'pointer',
                                            }}
                                        >
                                            Hand #{handNo}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>

                    <div style={{ textAlign: 'center', marginTop: '30px', paddingBottom: '30px' }}>
                        <button
                            onClick={() => setResult(null)}
                            style={{ background: '#95a5a6', color: 'white', border: 'none', padding: '10px 30px', borderRadius: '20px', cursor: 'pointer' }}
                        >
                            Analyze Again
                        </button>
                    </div>
                </div>
            )}

            {/* 핸드 상세 모달 — 분석 핸드 목록에서 handNo로 조회 */}
            {selectedHandForReplay && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000,
                }} onClick={() => setSelectedHandForReplay(null)}>
                    <div style={{
                        background: '#2c3e50', width: '90%', maxWidth: '500px', maxHeight: '80vh', borderRadius: '10px',
                        display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '15px', background: '#34495e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0 }}>Hand #{selectedHandForReplay.handNo}</h3>
                            <button onClick={() => setSelectedHandForReplay(null)} style={{ background: 'none', border: 'none', color: 'white', fontSize: '1.5em', cursor: 'pointer' }}>×</button>
                        </div>
                        <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
                            <div style={{ marginBottom: '15px', color: '#bdc3c7', fontSize: '0.9em' }}>
                                {selectedHandForReplay.startedAt ? `${new Date(selectedHandForReplay.startedAt).toLocaleString()} • ` : ''}
                                {activeNamesOf(selectedHandForReplay).length} Players
                                {selectedHandForReplay.straddleCount > 0 ? ` • 스트래들 ×${selectedHandForReplay.straddleCount}` : ''}
                            </div>

                            <h4 style={{ borderBottom: '1px solid #444', paddingBottom: '5px' }}>Preflop Actions</h4>
                            <div className="action-list">
                                {selectedHandForReplay.actions && selectedHandForReplay.actions.map((action, idx) => (
                                    <div key={idx} style={{
                                        display: 'flex', justifyContent: 'space-between', padding: '8px',
                                        borderBottom: '1px solid #444',
                                        background: action.name === analyzedHero ? 'rgba(52, 152, 219, 0.1)' : 'transparent',
                                    }}>
                                        <div>
                                            <span style={{ fontWeight: 'bold', color: action.name === analyzedHero ? '#3498db' : '#ecf0f1' }}>{action.name}</span>
                                            <span style={{ fontSize: '0.8em', color: '#95a5a6', marginLeft: '5px' }}>({action.position ?? '-'})</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center' }}>
                                            <span style={{
                                                marginRight: '10px', fontWeight: 'bold',
                                                color: action.type === 'fold' ? '#7f8c8d' :
                                                    action.type === 'raise' ? '#e74c3c' :
                                                        action.type === 'call' ? '#f1c40f' : '#ecf0f1',
                                            }}>
                                                {actionLabel(action)}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                                {(!selectedHandForReplay.actions || selectedHandForReplay.actions.length === 0) && (
                                    <div style={{ fontStyle: 'italic', color: '#7f8c8d', textAlign: 'center', padding: '20px' }}>No actions recorded.</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SessionLeaks;
