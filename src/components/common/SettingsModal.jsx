import React, { useState } from 'react';
import { useGame } from '../../state/GameContext.jsx';

// 설정 모달 (docs/REBUILD_DESIGN.md §7 — HomeScreen ⚙️ 설정)
// Gemini API 키 + 모델명을 updateSettings로 저장. 키는 이 기기(localStorage)에만 저장된다.
const SettingsModal = ({ onClose }) => {
    const { settings, updateSettings } = useGame();
    const [apiKey, setApiKey] = useState(settings.geminiApiKey || '');
    const [aiModel, setAiModel] = useState(settings.aiModel || '');
    const [saved, setSaved] = useState(false);

    const handleSave = () => {
        updateSettings({
            geminiApiKey: apiKey.trim(),
            // 빈 값 저장 방지 — 비워두면 기존 모델명 유지
            aiModel: aiModel.trim() || settings.aiModel,
        });
        setSaved(true);
        setTimeout(onClose, 400);
    };

    return (
        <div className="modal" style={{ display: 'block' }} onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
                <span className="close-btn" onClick={onClose}>&times;</span>
                <h3 className="modal-title">⚙️ 설정</h3>

                <div className="settings-section" style={{ textAlign: 'left', marginBottom: '18px' }}>
                    <label
                        htmlFor="settings-gemini-key"
                        style={{ display: 'block', color: '#bdc3c7', marginBottom: '8px', fontSize: '0.9em' }}
                    >
                        Gemini API 키
                    </label>
                    <input
                        id="settings-gemini-key"
                        type="password"
                        className="input-field"
                        style={{ width: '100%', boxSizing: 'border-box' }}
                        value={apiKey}
                        onChange={e => { setApiKey(e.target.value); setSaved(false); }}
                        placeholder="AIza..."
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
                        value={aiModel}
                        onChange={e => { setAiModel(e.target.value); setSaved(false); }}
                        placeholder={settings.aiModel}
                        autoComplete="off"
                    />
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
