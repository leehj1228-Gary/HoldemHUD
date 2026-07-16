// 플레이어 유형 분류 + 프리셋 (docs/REBUILD_DESIGN.md §4)
// 순수 모듈: React·DOM·다른 계층 import 금지.
// PLAYER_ARCHETYPES는 구 StatsCalculator.js, LIVE_PLAYER_PRESETS/getStatColor는 구 gameLogic.js에서 이식.
// 구 getPlayerType은 폐지 — analyzePlayerStyle + styleFor로 통일.

export const PLAYER_ARCHETYPES = {
    GTO: {
        id: 'gto',
        label: '🤖 GTO (Solver)',
        description: '이론적으로 완벽에 가까운 밸런스. 약점이 거의 없음.',
        color: '#8e44ad',
        stats: { vpip: 23, pfr: 19, bet3: 9 },
        criteria: { vpipMin: 20, vpipMax: 27, pfrMin: 16, pfrMax: 23, gapMax: 5 }
    },
    NIT: {
        id: 'nit',
        label: '🪨 Rock (Nit)',
        description: '매우 타이트함. 프리미엄 핸드로만 플레이.',
        color: '#e74c3c',
        stats: { vpip: 12, pfr: 9, bet3: 3 },
        criteria: { vpipMax: 17 }
    },
    TAG: {
        id: 'tag',
        label: '🦈 TAG (정석)',
        description: '타이트하지만 공격적. 일반적인 고수 스타일.',
        color: '#2ecc71',
        stats: { vpip: 19, pfr: 16, bet3: 7 },
        criteria: { vpipMin: 17, vpipMax: 22, gapMax: 6 }
    },
    LAG: {
        id: 'lag',
        label: '🦁 LAG (공격적)',
        description: '루즈하고 공격적. 잦은 3벳과 블러핑.',
        color: '#f39c12',
        stats: { vpip: 29, pfr: 24, bet3: 12 },
        criteria: { vpipMin: 27, vpipMax: 38, pfrMin: 20, gapMax: 10 }
    },
    STATION: {
        id: 'station',
        label: '🐠 Fish (Station)',
        description: 'VPIP는 높은데 레이즈를 안 함. 콜만 따는 유형.',
        color: '#3498db',
        stats: { vpip: 45, pfr: 8, bet3: 2 },
        criteria: { vpipMin: 30, gapMin: 15 }
    },
    MANIAC: {
        id: 'maniac',
        label: '💣 Maniac',
        description: '통제 불능. 아무거나 레이즈하고 올인함.',
        color: '#c0392b',
        stats: { vpip: 60, pfr: 45, bet3: 25 },
        criteria: { vpipMin: 45, pfrMin: 30 }
    },
    UNKNOWN: {
        id: 'unknown',
        label: '❔ Unknown',
        description: '표본 부족 (20핸드 미만)',
        color: '#95a5a6',
        stats: { vpip: 0, pfr: 0, bet3: 0 }
    }
};

export const LIVE_PLAYER_PRESETS = {
    // --- 1. 기본/미상 ---
    UNKNOWN: {
        id: 'unknown',
        label: '❔ Unknown (미상)',
        description: '정보가 없음. 평균적인 라이브 플레이어로 가정.',
        stats: { vpip: 30, pfr: 15, bet3: 5 }, // 라이브는 온라인보다 기본적으로 루즈함
        tags: ['Average']
    },

    // --- 2. 패시브 (Fish 계열) ---
    CALLING_STATION: {
        id: 'station',
        label: '🐠 Calling Station (콜머신)',
        description: '절대 폴드하지 않음. 벳하면 콜만 함. 블러핑 금지.',
        stats: { vpip: 55, pfr: 5, bet3: 1 },
        tags: ['Loose', 'Passive', 'Sticky']
    },
    LIMPER: {
        id: 'limper',
        label: '🐢 Habitual Limper (림퍼)',
        description: '프리플랍에 레이즈 없이 림프(Call)로만 들어옴.',
        stats: { vpip: 40, pfr: 2, bet3: 0 },
        tags: ['Passive', 'Weak']
    },
    FIT_OR_FOLD: {
        id: 'fit_fold',
        label: '😶 Fit or Fold',
        description: '플랍을 많이 보지만, 안 맞으면 바로 죽음. C-Bet 효과적.',
        stats: { vpip: 35, pfr: 5, bet3: 2 },
        tags: ['Weak-Tight', 'Exploitable']
    },

    // --- 3. 타이트 (Nit 계열) ---
    NIT: {
        id: 'nit',
        label: '🪨 Nit (바위)',
        description: '프리미엄 핸드(QQ+, AK) 아니면 안 침. 재미없게 침.',
        stats: { vpip: 10, pfr: 8, bet3: 3 },
        tags: ['Tight', 'Passive']
    },
    OMC: {
        id: 'omc',
        label: '☕ OMC (Old Man Coffee)',
        description: '극도로 보수적인 노년층 스타일. 이 사람이 레이즈하면 무조건 AA/KK.',
        stats: { vpip: 5, pfr: 3, bet3: 1 }, // 극단적 타이트
        tags: ['Ultra-Tight', 'Zero-Bluff']
    },

    // --- 4. 어그레시브 (Reg/Shark 계열) ---
    TAG: {
        id: 'tag',
        label: '🦈 TAG (정석)',
        description: '타이트하지만 공격적임. 포지션과 상황을 이해하는 고수.',
        stats: { vpip: 22, pfr: 18, bet3: 8 },
        tags: ['Tight', 'Aggressive', 'Solid']
    },
    LAG: {
        id: 'lag',
        label: '🦁 LAG (공격적)',
        description: '넓은 레인지로 압박함. 루즈하지만 포스트플랍을 잘함.',
        stats: { vpip: 32, pfr: 26, bet3: 12 },
        tags: ['Loose', 'Aggressive', 'Tricky']
    },

    // --- 5. 고위험군 (Gambler 계열) ---
    MANIAC: {
        id: 'maniac',
        label: '💣 Maniac (미치광이)',
        description: '아무 핸드로나 레이즈/올인. 변동성의 주범.',
        stats: { vpip: 70, pfr: 50, bet3: 25 },
        tags: ['Over-Aggressive', 'Gambler']
    },
    WHALE: {
        id: 'whale',
        label: '🐳 Whale (고래)',
        description: '돈이 많고 잃는 것을 신경 안 씀. VPIP가 매우 높고 운영이 서툼.',
        stats: { vpip: 80, pfr: 10, bet3: 2 }, // 레이즈는 안하고 콜만 땀
        tags: ['Very-Loose', 'Passive', 'Target']
    },

    // --- 6. 특수 유형 ---
    SHORT_STACK: {
        id: 'shorty',
        label: '📉 Short Stack (숏스택)',
        description: '최소 바이인으로 들어와서 프리플랍 올인만 노림.',
        stats: { vpip: 15, pfr: 15, bet3: 5 }, // VPIP=PFR (Push or Fold)
        tags: ['Short-Stack', 'Push-Fold']
    },
    GTO_WANNABE: {
        id: 'gto_wan',
        label: '🤖 GTO Wannabe',
        description: '이론을 따라하려 하지만 종종 실수하거나 오버플레이 함.',
        stats: { vpip: 24, pfr: 20, bet3: 10 },
        tags: ['Balanced', 'Thinking']
    }
};

/**
 * 스탯 값에 따른 표시 색상 (구 gameLogic.js 이식).
 * @param {string} statName - 'VPIP' | 'PFR' | '3-Bet'
 * @param {number} value - 퍼센트 값
 * @returns {string} hex 색상 문자열
 */
export const getStatColor = (statName, value) => {
    // Value is expected to be a number (percentage)
    switch (statName) {
        case 'VPIP':
            if (value >= 50) return '#FF4D4D'; // Red (Fishy/Loose)
            if (value >= 35) return '#FFA500'; // Orange
            if (value >= 20) return '#2ECC71'; // Green (Good)
            return '#95A5A6'; // Gray (Tight/Nit)
        case 'PFR':
            if (value >= 35) return '#FF4D4D'; // Red (Maniac)
            if (value >= 15) return '#2ECC71'; // Green (Good)
            return '#95A5A6'; // Gray (Passive)
        case '3-Bet':
            if (value >= 10) return '#FF4D4D'; // Red
            if (value >= 5) return '#2ECC71'; // Green
            return '#95A5A6'; // Gray
        default:
            return '#ffffff';
    }
};

/**
 * VPIP/PFR 기반 플레이어 스타일 분류 — 설계서 §4의 교정된 판정 순서.
 * UNKNOWN(hands<20) → MANIAC(vpip>=45&&pfr>=30) → STATION(vpip>=30&&gap>=15)
 * → NIT(vpip<17) → LAG(vpip>=27) → GTO(vpip 20~27 && gap<=5) → TAG.
 * (구 코드 버그 수정: STATION은 vpip>=30일 때만 — 타이트-패시브가 STATION으로 오분류되던 문제 해결)
 * @param {number} vpip - VPIP 퍼센트
 * @param {number} pfr - PFR 퍼센트
 * @param {number} hands - 표본 핸드 수
 * @returns {object} PLAYER_ARCHETYPES의 항목 (label/color/description 포함)
 */
export function analyzePlayerStyle(vpip, pfr, hands) {
    if (!Number.isFinite(hands) || hands < 20) return PLAYER_ARCHETYPES.UNKNOWN;

    const v = Number.isFinite(vpip) ? vpip : 0;
    const p = Number.isFinite(pfr) ? pfr : 0;
    const gap = v - p;

    if (v >= 45 && p >= 30) return PLAYER_ARCHETYPES.MANIAC;
    if (v >= 30 && gap >= 15) return PLAYER_ARCHETYPES.STATION;
    if (v < 17) return PLAYER_ARCHETYPES.NIT;
    if (v >= 27) return PLAYER_ARCHETYPES.LAG;
    if (v >= 20 && v <= 27 && gap <= 5) return PLAYER_ARCHETYPES.GTO;

    return PLAYER_ARCHETYPES.TAG;
}

/**
 * statsEngine의 PlayerStats에서 바로 스타일을 구하는 헬퍼 (구 getPlayerType 대체).
 * 0핸드(또는 stats 없음)면 UNKNOWN 라벨.
 * @param {object|null|undefined} stats - statsEngine.computeStats/computeAllStats의 PlayerStats
 * @returns {object} PLAYER_ARCHETYPES의 항목
 */
export function styleFor(stats) {
    if (!stats || !stats.dealt) return PLAYER_ARCHETYPES.UNKNOWN;
    const vpip = stats.vpip && stats.vpip.pct !== null && stats.vpip.pct !== undefined ? stats.vpip.pct : 0;
    const pfr = stats.pfr && stats.pfr.pct !== null && stats.pfr.pct !== undefined ? stats.pfr.pct : 0;
    return analyzePlayerStyle(vpip, pfr, stats.dealt);
}
