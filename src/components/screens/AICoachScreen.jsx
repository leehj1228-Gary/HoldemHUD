// AI 코치 화면 — 얇은 컨테이너 (설계 §7 — S5)
// 탭(설정/전략/레인지/세션 리크)과 분석 상태만 관리하고, 실제 UI는 coach/* 컴포넌트에 위임한다.
// 키/모델은 useGame().settings에서 읽어 aiService에 인자로 주입 (모듈이 storage 직접 접근 금지).

import React, { useState } from 'react';
import { useGame } from '../../state/GameContext.jsx';
import { analyzeTable, resolveAiOptions } from '../../services/aiService.js';
import CoachSetup from '../coach/CoachSetup.jsx';
import StrategyResults from '../coach/StrategyResults.jsx';
import RangeChart from '../coach/RangeChart.jsx';
import SessionLeaks from '../coach/SessionLeaks.jsx';

const TABS = [
    { id: 'setup', label: '설정' },
    { id: 'strategy', label: '전략' },
    { id: 'range', label: '레인지' },
    { id: 'leaks', label: '세션 리크' },
];

const AICoachScreen = () => {
    const { goBack, settings } = useGame();
    const [activeTab, setActiveTab] = useState('setup');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysisResult, setAnalysisResult] = useState(null);

    const ai = resolveAiOptions(settings);
    const hasApiKey = !!(ai.apiKey && ai.apiKey.trim());

    const runAnalysis = async (tableData) => {
        setIsAnalyzing(true);
        try {
            const result = await analyzeTable(tableData, ai);
            if (result && typeof result === 'object') {
                if (!result.recommendedRange) {
                    result.recommendedRange = {};
                    console.warn('AI response missing recommendedRange');
                }
                setAnalysisResult(result);
                setActiveTab('strategy');
            } else {
                throw new Error('Invalid AI response format');
            }
        } catch (error) {
            console.error('Analysis error:', error);
            alert(error?.message || 'Analysis failed. Please try again.');
        } finally {
            setIsAnalyzing(false);
        }
    };

    const renderEmptyResult = () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#bdc3c7', padding: '30px', textAlign: 'center' }}>
            <div style={{ fontSize: '3em', marginBottom: '10px' }}>🧠</div>
            <p style={{ lineHeight: '1.6' }}>아직 분석 결과가 없습니다.<br />설정 탭에서 테이블을 구성하고 분석을 실행하세요.</p>
            <button
                onClick={() => setActiveTab('setup')}
                style={{ marginTop: '15px', background: '#f1c40f', color: '#2c3e50', border: 'none', padding: '10px 25px', borderRadius: '20px', fontWeight: 'bold', cursor: 'pointer' }}
            >
                설정으로 이동
            </button>
        </div>
    );

    return (
        <div id="ai-coach-screen" className="screen-container" style={{ display: 'flex', flexDirection: 'column', background: '#2c3e50', color: '#fff', overflow: 'hidden' }}>
            <div className="header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', background: '#34495e', flexShrink: 0 }}>
                <button className="btn-back" onClick={goBack} style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.2rem', cursor: 'pointer' }}>← Back</button>
                <h2>🤖 Preflop AI Coach</h2>
                <div style={{ width: '50px' }}></div>
            </div>

            {!hasApiKey && (
                <div style={{ background: '#e67e22', color: '#fff', padding: '8px 15px', textAlign: 'center', fontSize: '0.9em', flexShrink: 0 }}>
                    ⚠️ {ai.label} API 키가 없습니다. 홈 화면의 '⚙️ 설정'에서 API 키를 입력하세요.
                </div>
            )}

            {/* 탭: 설정 / 전략 / 레인지 / 세션 리크 */}
            <div className="main-tabs" style={{ display: 'flex', justifyContent: 'center', background: '#2c3e50', padding: '10px', borderBottom: '1px solid #444', flexShrink: 0 }}>
                {TABS.map((tab) => {
                    const isActive = activeTab === tab.id;
                    const isLeaks = tab.id === 'leaks';
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            style={{
                                padding: '10px 16px', margin: '0 4px', borderRadius: '20px', border: 'none', cursor: 'pointer',
                                background: isActive ? (isLeaks ? '#e74c3c' : '#f1c40f') : '#34495e',
                                color: isActive ? (isLeaks ? 'white' : '#2c3e50') : '#bdc3c7',
                                fontWeight: 'bold',
                            }}
                        >
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {activeTab === 'setup' && (
                <CoachSetup onAnalyze={runAnalysis} isAnalyzing={isAnalyzing} />
            )}

            {activeTab === 'strategy' && (
                analysisResult ? (
                    <StrategyResults
                        result={analysisResult}
                        onReset={() => { setAnalysisResult(null); setActiveTab('setup'); }}
                    />
                ) : renderEmptyResult()
            )}

            {activeTab === 'range' && (
                analysisResult ? (
                    <div className="content-area" style={{ flex: 1, overflowY: 'auto', padding: '15px' }}>
                        <RangeChart
                            range={analysisResult.recommendedRange}
                            description={analysisResult.recommendedRange?.description}
                        />
                    </div>
                ) : renderEmptyResult()
            )}

            {activeTab === 'leaks' && (
                <SessionLeaks ai={ai} />
            )}
        </div>
    );
};

export default AICoachScreen;
