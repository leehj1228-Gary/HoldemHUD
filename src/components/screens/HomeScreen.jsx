import React, { useState } from 'react';
import { useGame } from '../../state/GameContext.jsx';
import SettingsModal from '../common/SettingsModal.jsx';

const HomeScreen = () => {
    const { session, startSession, resumeSession, navigateTo } = useGame();
    const [showConfirm, setShowConfirm] = useState(false);
    const [showSetup, setShowSetup] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    // Setup State
    const [blindType, setBlindType] = useState('1000/2000');
    const [customSb, setCustomSb] = useState(1000);
    const [customBb, setCustomBb] = useState(2000);
    const [currency, setCurrency] = useState('$');
    const [playerCount, setPlayerCount] = useState(6);
    const [blindWarning, setBlindWarning] = useState('');

    // Initialize with current date/time in local ISO format (YYYY-MM-DDTHH:MM)
    const [sessionDate, setSessionDate] = useState(() => {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        return now.toISOString().slice(0, 16);
    });

    const handleNewSessionClick = () => {
        // 기록된 핸드가 있거나 첫 핸드가 진행 중(액션 존재)이면 경고 (설계 §7)
        const hasCompletedHands = session && session.hands.length > 0;
        const hasHandInProgress = !!(session && session.currentHand
            && Array.isArray(session.currentHand.actions)
            && session.currentHand.actions.length > 0);
        if (hasCompletedHands || hasHandInProgress) {
            setShowConfirm(true);
        } else {
            setShowSetup(true);
        }
    };

    const handleConfirmReset = () => {
        setShowConfirm(false);
        setShowSetup(true);
    };

    const handleStartSession = () => {
        let sb, bb;
        if (blindType === 'custom') {
            sb = Number.parseInt(customSb, 10);
            bb = Number.parseInt(customBb, 10);
        } else {
            const parts = blindType.split('/');
            sb = Number.parseInt(parts[0], 10);
            bb = Number.parseInt(parts[1], 10);
        }

        // NaN 가드: 잘못된 커스텀 블라인드는 시작 차단 + 인라인 경고 (조용한 기본값 대체 금지)
        if (Number.isNaN(sb) || Number.isNaN(bb) || sb <= 0 || bb <= 0) {
            setBlindWarning('블라인드 값을 올바르게 입력하세요 (0보다 큰 숫자)');
            return;
        }
        setBlindWarning('');

        const parsed = new Date(sessionDate);
        const startedAt = Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();

        startSession({ playerCount, blinds: { sb, bb }, currency, startedAt });
        setShowSetup(false);
    };

    return (
        <div id="home-screen" className="screen active" style={{ display: 'flex' }}>
            <div className="app-title">PokerTracker</div>
            <div className="app-subtitle">Live Cash Game HUD</div>

            <button className="menu-btn btn-new" onClick={handleNewSessionClick}>
                <span>🔥</span> New Session
            </button>

            {session && (
                <button className="menu-btn btn-resume" onClick={resumeSession}>
                    <span>▶</span> Resume Active
                </button>
            )}

            <button className="menu-btn btn-history" onClick={() => navigateTo('history')}>
                <span>📜</span> Session History
            </button>

            <button className="menu-btn btn-profile" onClick={() => navigateTo('profile')}>
                <span>👥</span> Player Profile
            </button>

            <button className="menu-btn" onClick={() => navigateTo('coach')} style={{ background: 'linear-gradient(45deg, #6a11cb 0%, #2575fc 100%)', border: 'none' }}>
                🤖 Preflop AI Coach
            </button>

            <button className="menu-btn" onClick={() => setShowSettings(true)} style={{ background: 'linear-gradient(to right, #7f8c8d, #576574)', border: 'none' }}>
                <span>⚙️</span> 설정
            </button>

            {showConfirm && (
                <div className="modal" style={{ display: 'block' }} onClick={() => setShowConfirm(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <h3 className="modal-title">⚠️ 경고</h3>
                        <p style={{ color: '#fff', marginBottom: '20px' }}>
                            새 세션을 시작하면 현재 진행 중인 게임 데이터가 초기화됩니다.<br />
                            계속하시겠습니까?
                        </p>
                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                            <button
                                className="add-btn"
                                style={{ backgroundColor: '#e74c3c' }}
                                onClick={handleConfirmReset}
                            >
                                초기화 및 설정
                            </button>
                            <button
                                className="add-btn"
                                style={{ backgroundColor: '#7f8c8d' }}
                                onClick={() => setShowConfirm(false)}
                            >
                                취소
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Session Setup Modal */}
            {showSetup && (
                <div className="modal" style={{ display: 'block' }} onClick={() => setShowSetup(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
                        <h3 className="modal-title">New Session Setup</h3>

                        <div className="setup-section">
                            <label>Blinds</label>
                            <div className="radio-group">
                                {['1000/2000', '2000/5000', '5000/10000'].map(opt => (
                                    <button
                                        key={opt}
                                        className={`radio-btn ${blindType === opt ? 'active' : ''}`}
                                        onClick={() => { setBlindType(opt); setBlindWarning(''); }}
                                    >
                                        {opt}
                                    </button>
                                ))}
                                <button
                                    className={`radio-btn ${blindType === 'custom' ? 'active' : ''}`}
                                    onClick={() => { setBlindType('custom'); setBlindWarning(''); }}
                                >
                                    Custom
                                </button>
                            </div>
                            {blindType === 'custom' && (
                                <div className="custom-inputs" style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                                    <input
                                        type="number"
                                        value={customSb}
                                        onChange={e => { setCustomSb(e.target.value); setBlindWarning(''); }}
                                        placeholder="SB"
                                        className="setup-input"
                                    />
                                    <span style={{ color: '#fff', alignSelf: 'center' }}>/</span>
                                    <input
                                        type="number"
                                        value={customBb}
                                        onChange={e => { setCustomBb(e.target.value); setBlindWarning(''); }}
                                        placeholder="BB"
                                        className="setup-input"
                                    />
                                </div>
                            )}
                            {blindWarning && (
                                <div style={{ color: '#e74c3c', fontSize: '0.85em', marginTop: '8px' }}>
                                    {blindWarning}
                                </div>
                            )}
                        </div>

                        <div className="setup-section">
                            <label>Currency</label>
                            <div className="radio-group">
                                {['$', '₩'].map(curr => (
                                    <button
                                        key={curr}
                                        className={`radio-btn ${currency === curr ? 'active' : ''}`}
                                        onClick={() => setCurrency(curr)}
                                    >
                                        {curr}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="setup-section">
                            <label>Players: {playerCount}</label>
                            <input
                                type="range"
                                min="2"
                                max="9"
                                value={playerCount}
                                onChange={e => setPlayerCount(Number.parseInt(e.target.value, 10))}
                                style={{ width: '100%' }}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#aaa', fontSize: '0.8em' }}>
                                <span>2</span><span>9</span>
                            </div>
                        </div>

                        <div className="setup-section">
                            <label>Date</label>
                            <input
                                type="datetime-local"
                                value={sessionDate}
                                onChange={(e) => setSessionDate(e.target.value)}
                                className="setup-input"
                                style={{ colorScheme: 'dark' }}
                            />
                        </div>

                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '20px' }}>
                            <button
                                className="add-btn"
                                style={{ backgroundColor: '#2ecc71', width: '100%' }}
                                onClick={handleStartSession}
                            >
                                Start Game
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

            <style>{`
                .setup-section {
                    margin-bottom: 20px;
                    text-align: left;
                }
                .setup-section label {
                    display: block;
                    color: #bdc3c7;
                    margin-bottom: 8px;
                    font-size: 0.9em;
                }
                .radio-group {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                }
                .radio-btn {
                    background: #34495e;
                    border: 1px solid #7f8c8d;
                    color: #fff;
                    padding: 8px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    flex: 1;
                    font-size: 0.9em;
                }
                .radio-btn.active {
                    background: #3498db;
                    border-color: #3498db;
                }
                .setup-input {
                    background: #2c3e50;
                    border: 1px solid #7f8c8d;
                    color: #fff;
                    padding: 8px;
                    border-radius: 4px;
                    width: 100%;
                }
            `}</style>
        </div>
    );
};

export default HomeScreen;
