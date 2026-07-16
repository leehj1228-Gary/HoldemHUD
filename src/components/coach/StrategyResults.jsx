// 전략 분석 결과 (3줄 요약 + 플레이어 팁 아코디언) — 구 AICoachScreen 결과 뷰 이식 (설계 §7 — S5)

import React, { useState } from 'react';

const StrategyResults = ({ result, onReset }) => {
    const [openAccordions, setOpenAccordions] = useState({});

    const toggleAccordion = (index) => {
        setOpenAccordions(prev => ({ ...prev, [index]: !prev[index] }));
    };

    if (!result) return null;

    return (
        <div className="results-phase" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#2c3e50', overflow: 'hidden' }}>
            <div className="content-area" style={{ flex: 1, overflowY: 'auto', padding: '15px' }}>
                <div className="tab-content">
                    {/* Summary Card */}
                    <div className="strategy-card" style={{ background: '#34495e', borderRadius: '10px', padding: '15px', marginBottom: '20px', boxShadow: '0 2px 5px rgba(0,0,0,0.2)' }}>
                        <div className="card-title" style={{ color: '#f1c40f', fontWeight: 'bold', marginBottom: '10px', fontSize: '1.1em', borderBottom: '1px solid #444', paddingBottom: '5px' }}>
                            ⚡ 3-Line Summary
                        </div>
                        {result.strategySummary?.map((item, idx) => (
                            <div key={idx} className="bullet-point" style={{ marginBottom: '10px', display: 'flex', alignItems: 'flex-start', fontSize: '0.95em', lineHeight: '1.4' }}>
                                <span style={{ marginRight: '10px', fontSize: '1.2em' }}>{item.icon}</span>
                                <span>{item.text}</span>
                            </div>
                        ))}
                    </div>

                    {/* Player Tips Accordion */}
                    <div className="card-title" style={{ color: '#fff', fontWeight: 'bold', marginBottom: '10px', paddingLeft: '5px' }}>Player Tips</div>
                    <div className="accordion">
                        {result.playerTips?.map((tip, idx) => (
                            <div key={idx} className="acc-item" style={{ marginBottom: '10px', borderRadius: '8px', overflow: 'hidden' }}>
                                <div
                                    className="acc-header"
                                    onClick={() => toggleAccordion(idx)}
                                    style={{
                                        background: '#ecf0f1', color: '#2c3e50', padding: '12px', fontWeight: 'bold',
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer',
                                    }}
                                >
                                    <span>
                                        {/* seat은 0-based 저장 — 표시만 1-based */}
                                        Seat {Number.isFinite(tip.seat) ? tip.seat + 1 : '?'}: {tip.name}
                                        <span style={{
                                            marginLeft: '8px', padding: '2px 6px', borderRadius: '4px', fontSize: '0.7em', color: 'white',
                                            verticalAlign: 'middle', background: tip.tagColor === 'red' ? '#e74c3c' : '#3498db',
                                        }}>
                                            {tip.tag}
                                        </span>
                                    </span>
                                    <span>{openAccordions[idx] ? '▲' : '▼'}</span>
                                </div>
                                {openAccordions[idx] && (
                                    <div className="acc-body" style={{ background: '#fff', color: '#333', padding: '15px', fontSize: '0.9em', lineHeight: '1.5' }}>
                                        {tip.tip}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div style={{ padding: '15px', background: '#34495e', textAlign: 'center', flexShrink: 0 }}>
                <button
                    onClick={onReset}
                    style={{ background: '#95a5a6', color: 'white', border: 'none', padding: '10px 30px', borderRadius: '20px', cursor: 'pointer' }}
                >
                    New Analysis
                </button>
            </div>
        </div>
    );
};

export default StrategyResults;
