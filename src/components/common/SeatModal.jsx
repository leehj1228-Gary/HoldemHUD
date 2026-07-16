// 좌석 배정 모달 (docs/REBUILD_DESIGN.md §7)
// 로스터/빠른 추가/프리셋 세 경로 전부에서 "이미 다른 좌석에 앉은 이름"을 차단한다:
// 목록에서 필터링 + 선택 핸들러 내부 가드(alert) 이중 방어. 프리셋은 이모지 없는 순수 이름을 저장.
// onSelect prop이 있으면(AI 코치 화면 등) 좌석 반영은 부모가 담당한다.

import React, { useState } from 'react';
import { useGame } from '../../state/GameContext';
import { LIVE_PLAYER_PRESETS } from '../../engine/archetypes';

// 프리셋 라벨에서 앞머리 이모지를 제거한 순수 이름 (예: '🐠 Calling Station (콜머신)' → 'Calling Station (콜머신)')
const presetNameOf = (label) => String(label || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

const SeatModal = ({ isOpen, onClose, seatIndex, onSelect }) => {
    const { roster, seats, renameSeat, addToRoster } = useGame();
    const [quickName, setQuickName] = useState('');

    if (!isOpen) return null;

    // 게임 좌석에 직접 앉히는 경로에서만 중복 착석을 검사한다.
    // (현재 편집 중인 좌석의 기존 이름은 제외 — 같은 좌석 재선택은 허용)
    const seatingIntoGame = !onSelect;
    const seatedNames = new Set(
        seats
            .filter((s) => s.seat !== seatIndex && typeof s.name === 'string' && s.name.trim() !== '')
            .map((s) => s.name.trim())
    );
    const isSeatedElsewhere = (name) => seatingIntoGame && seatedNames.has(name);

    const handleSelect = (name, presetData = null) => {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) return;
        if (isSeatedElsewhere(trimmed)) {
            window.alert('이미 착석 중입니다');
            return;
        }
        if (onSelect) {
            // onSelect prop이 있으면(예: AI 코치 화면) 부모가 처리
            onSelect(trimmed, presetData);
        } else {
            // 기본 동작: 게임 좌석 이름 변경
            renameSeat(seatIndex, trimmed);
        }
        onClose();
    };

    const handleQuickAdd = () => {
        const name = quickName.trim();
        if (!name) return;
        if (isSeatedElsewhere(name)) {
            window.alert('이미 착석 중입니다');
            return;
        }
        addToRoster(name);
        setQuickName('');
        handleSelect(name);
    };

    // 목록 필터링: 이미 다른 좌석에 앉은 이름은 아예 노출하지 않는다
    const availableRoster = roster.filter((name) => !isSeatedElsewhere(name.trim()));
    const availablePresets = Object.values(LIVE_PLAYER_PRESETS)
        .filter((preset) => !isSeatedElsewhere(presetNameOf(preset.label)));

    return (
        <div className="modal" style={{ display: 'block' }} onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                <span className="close-btn" onClick={onClose}>&times;</span>
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
                        {availableRoster.length > 0 ? (
                            availableRoster.map((name) => (
                                <li key={name} className="roster-item" onClick={() => handleSelect(name)}>
                                    <span className="roster-name">{name}</span>
                                </li>
                            ))
                        ) : (
                            <li style={{ color: '#666', padding: '10px' }}>저장된 플레이어가 없습니다.</li>
                        )}
                    </ul>
                </div>

                <div style={{ marginTop: '20px' }}>
                    <h4 style={{ color: '#aaa', marginBottom: '10px', borderBottom: '1px solid #444' }}>유형별 빠른 추가</h4>
                    <div className="preset-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        {availablePresets.map((preset) => (
                            <div
                                key={preset.id}
                                className="preset-card"
                                onClick={() => handleSelect(presetNameOf(preset.label), preset)}
                                style={{
                                    background: '#333',
                                    padding: '10px',
                                    borderRadius: '5px',
                                    cursor: 'pointer',
                                    border: '1px solid #444'
                                }}
                            >
                                <div style={{ fontWeight: 'bold', fontSize: '0.9em', color: '#fff' }}>{preset.label}</div>
                                <div style={{ fontSize: '0.7em', color: '#aaa', marginTop: '3px' }}>{preset.description}</div>
                                <div style={{ fontSize: '0.7em', color: '#4caf50', marginTop: '3px' }}>
                                    VPIP: {preset.stats.vpip}% / PFR: {preset.stats.pfr}%
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SeatModal;
