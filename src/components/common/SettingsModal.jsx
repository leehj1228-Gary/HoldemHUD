import React, { useState } from 'react';
import { useGame } from '../../state/GameContext.jsx';
import { AI_PROVIDERS } from '../../services/aiService.js';

// 설정 모달 (docs/REBUILD_DESIGN.md §7 — HomeScreen ⚙️ 설정)
// AI 프로바이더(Gemini/ChatGPT/Claude) 선택 + 프로바이더별 API 키/모델명.
// 키는 이 기기(localStorage)에만 저장된다. 프로바이더를 바꿔도 각 키/모델은 유지된다.
const PROVIDER_IDS = Object.keys(AI_PROVIDERS);

const SettingsModal = ({ onClose }) => {
    const { settings, updateSettings } = useGame();
    const [provider, setProvider] = useState(
        AI_PROVIDERS[settings.aiProvider] ? settings.aiProvider : 'gemini'
    );
    // 세 프로바이더의 키/모델을 전부 로컬 상태로 들고 있다가 저장 시 한 번에 반영
    const [fields, setFields] = useState(() => {
        const init = {};
        for (const id of PROVIDER_IDS) {
            const meta = AI_PROVIDERS[id];
            init[meta.keyField] = settings[meta.keyField] || '';
            // 레거시 호환: 구 설정(aiModel)은 gemini 모델명
            init[meta.modelField] = settings[meta.modelField]
                || (id === 'gemini' && settings.aiModel) || '';
        }
        return init;
    });
    const [saved, setSaved] = useState(false);

    const meta = AI_PROVIDERS[provider];
    const setField = (name, value) => {
        setFields(prev => ({ ...prev, [name]: value }));
        setSaved(false);
    };

    const handleSave = () => {
        const patch = { aiProvider: provider };
        for (const id of PROVIDER_IDS) {
            const m = AI_PROVIDERS[id];
            patch[m.keyField] = (fields[m.keyField] || '').trim();
            // 빈 모델명은 기본 모델 사용을 의미하므로 defaultModel로 저장
            patch[m.modelField] = (fields[m.modelField] || '').trim() || m.defaultModel;
        }
        updateSettings(patch);
        setSaved(true);
        setTimeout(onClose, 400);
    };

    return (
        <div className="modal" style={{ display: 'block' }} onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
                <span className="close-btn" onClick={onClose}>&times;</span>
                <h3 className="modal-title">⚙️ 설정</h3>

                <div className="settings-section" style={{ textAlign: 'left', marginBottom: '18px' }}>
                    <label style={{ display: 'block', color: '#bdc3c7', marginBottom: '8px', fontSize: '0.9em' }}>
                        AI 프로바이더
                    </label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        {PROVIDER_IDS.map(id => (
                            <button
                                key={id}
                                onClick={() => { setProvider(id); setSaved(false); }}
                                style={{
                                    flex: 1,
                                    padding: '8px 4px',
                                    borderRadius: '4px',
                                    border: `1px solid ${provider === id ? '#3498db' : '#7f8c8d'}`,
                                    background: provider === id ? '#3498db' : '#34495e',
                                    color: '#fff',
                                    fontSize: '0.8em',
                                    cursor: 'pointer',
                                }}
                            >
                                {AI_PROVIDERS[id].label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="settings-section" style={{ textAlign: 'left', marginBottom: '18px' }}>
                    <label
                        htmlFor="settings-api-key"
                        style={{ display: 'block', color: '#bdc3c7', marginBottom: '8px', fontSize: '0.9em' }}
                    >
                        {meta.label} API 키
                    </label>
                    <input
                        id="settings-api-key"
                        type="password"
                        className="input-field"
                        style={{ width: '100%', boxSizing: 'border-box' }}
                        value={fields[meta.keyField]}
                        onChange={e => setField(meta.keyField, e.target.value)}
                        placeholder={meta.keyPlaceholder}
                        autoComplete="off"
                    />
                    <div style={{ color: '#95a5a6', fontSize: '0.8em', marginTop: '6px' }}>
                        키는 이 기기(localStorage)에만 저장됩니다
                    </div>
                </div>

                <div className="settings-section" style={{ textAlign: 'left', marginBottom: '18px' }}>
                    <label
                        htmlFor="settings-ai-model"
                        style={{ display: 'block', color: '#bdc3c7', marginBottom: '8px', fontSize: '0.9em' }}
                    >
                        모델명
                    </label>
                    <input
                        id="settings-ai-model"
                        type="text"
                        className="input-field"
                        style={{ width: '100%', boxSizing: 'border-box' }}
                        value={fields[meta.modelField]}
                        onChange={e => setField(meta.modelField, e.target.value)}
                        placeholder={meta.defaultModel}
                        autoComplete="off"
                    />
                    <div style={{ color: '#95a5a6', fontSize: '0.8em', marginTop: '6px' }}>
                        비워두면 기본 모델({meta.defaultModel})을 사용합니다
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '20px' }}>
                    <button
                        className="add-btn"
                        style={{ backgroundColor: saved ? '#27ae60' : '#2ecc71', flex: 1 }}
                        onClick={handleSave}
                    >
                        {saved ? '저장됨 ✓' : '저장'}
                    </button>
                    <button
                        className="add-btn"
                        style={{ backgroundColor: '#7f8c8d', flex: 1 }}
                        onClick={onClose}
                    >
                        닫기
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
