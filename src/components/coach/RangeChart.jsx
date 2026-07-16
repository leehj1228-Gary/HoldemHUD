// AI가 준 recommendedRange(169콤보)를 실제로 렌더하는 13×13 레인지 차트 (설계 §7 — S5)
// 대각선=페어, 위 삼각형=수딧, 아래 삼각형=오프수트. Math.random 자리표시자 완전 제거.

import React, { useMemo } from 'react';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// 구 팔레트 계열: Raise=초록, Call=파랑, Fold=어두운 색
const ACTION_COLORS = {
    raise: '#2ecc71',
    call: '#3498db',
    fold: '#34495e',
};

// "aks" / "KAs" / " AKS " 같은 변형 키를 표준 라벨("AKs")로 정규화
function canonicalCombo(raw) {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.trim();
    const match = cleaned.match(/^([AKQJT98765432akqjt])\s*([AKQJT98765432akqjt])\s*([so])?$/i);
    if (!match) return null;
    let r1 = match[1].toUpperCase();
    let r2 = match[2].toUpperCase();
    const suffix = match[3] ? match[3].toLowerCase() : '';
    if (r1 === r2) return `${r1}${r2}`;
    // 높은 랭크가 앞에 오도록 정렬
    if (RANKS.indexOf(r1) > RANKS.indexOf(r2)) [r1, r2] = [r2, r1];
    return `${r1}${r2}${suffix === 's' ? 's' : 'o'}`;
}

function normalizeAction(raw) {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (v === 'raise' || v === 'call' || v === 'fold') return v;
    return null;
}

const RangeChart = ({ range, description }) => {
    // 설명(rangeSummary)은 선택 필드 — 없으면 아무것도 렌더하지 않는다 (자리표시자 문구 금지)
    const summaryText =
        (typeof description === 'string' && description.trim())
            ? description.trim()
            : (range && typeof range === 'object' && typeof range.description === 'string' && range.description.trim())
                ? range.description.trim()
                : null;

    // AI 응답 키/값을 표준화한 룩업 테이블 (없는 콤보는 기본 Fold)
    const lookup = useMemo(() => {
        const map = new Map();
        if (range && typeof range === 'object') {
            for (const [key, value] of Object.entries(range)) {
                const combo = canonicalCombo(key);
                const action = normalizeAction(value);
                if (combo && action) map.set(combo, action);
            }
        }
        return map;
    }, [range]);

    return (
        <div className="tab-content">
            <div style={{ textAlign: 'center', marginBottom: '10px', color: '#ccc', fontSize: '0.9em' }}>
                Hero Open Range
            </div>
            <div style={{ background: '#34495e', padding: '10px', borderRadius: '8px', textAlign: 'center' }}>
                {/* 범례 */}
                <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', marginBottom: '10px', fontSize: '0.8em' }}>
                    {[['Raise', ACTION_COLORS.raise], ['Call', ACTION_COLORS.call], ['Fold', ACTION_COLORS.fold]].map(([label, color]) => (
                        <span key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <span style={{ width: '12px', height: '12px', background: color, borderRadius: '2px', display: 'inline-block' }}></span>
                            {label}
                        </span>
                    ))}
                </div>

                <div className="hand-grid-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(13, 1fr)', gap: '2px', maxWidth: '500px', margin: '0 auto' }}>
                    {RANKS.map((rowRank, rowIndex) => (
                        RANKS.map((colRank, colIndex) => {
                            // 대각선=페어, 위(col>row)=수딧, 아래(col<row)=오프수트
                            let handLabel;
                            if (rowIndex === colIndex) {
                                handLabel = `${rowRank}${colRank}`;
                            } else if (colIndex > rowIndex) {
                                handLabel = `${rowRank}${colRank}s`;
                            } else {
                                handLabel = `${colRank}${rowRank}o`;
                            }

                            const action = lookup.get(handLabel) || 'fold';

                            return (
                                <div
                                    key={handLabel}
                                    className="hand-cell"
                                    title={`${handLabel}: ${action.charAt(0).toUpperCase()}${action.slice(1)}`}
                                    style={{
                                        backgroundColor: ACTION_COLORS[action],
                                        color: '#fff',
                                        fontSize: '0.55rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        aspectRatio: '1/1',
                                        cursor: 'help',
                                        borderRadius: '2px',
                                    }}
                                >
                                    {handLabel}
                                </div>
                            );
                        })
                    ))}
                </div>

                {summaryText && (
                    <p style={{ marginTop: '10px', fontSize: '0.9em', color: '#ecf0f1' }}>
                        {summaryText}
                    </p>
                )}
            </div>
        </div>
    );
};

export default RangeChart;
