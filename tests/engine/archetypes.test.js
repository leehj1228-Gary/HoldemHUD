// archetypes 분류 테스트 — 설계서 §4의 교정된 판정 순서 검증
// (감사 버그: 구 코드는 vpip<30인 타이트-패시브도 gap>=15면 STATION으로 오분류)
import { describe, it, expect } from 'vitest';
import {
    PLAYER_ARCHETYPES,
    LIVE_PLAYER_PRESETS,
    getStatColor,
    analyzePlayerStyle,
    styleFor,
} from '../../src/engine/archetypes.js';

describe('analyzePlayerStyle — 판정 순서', () => {
    it('20핸드 미만은 무조건 UNKNOWN', () => {
        expect(analyzePlayerStyle(50, 40, 19).id).toBe('unknown');
        expect(analyzePlayerStyle(50, 40, 0).id).toBe('unknown');
        expect(analyzePlayerStyle(50, 40, 20).id).toBe('maniac'); // 경계: 20핸드부터 분류
    });

    it('MANIAC: vpip>=45 && pfr>=30 (최우선)', () => {
        expect(analyzePlayerStyle(45, 30, 100).id).toBe('maniac');
        expect(analyzePlayerStyle(60, 50, 100).id).toBe('maniac');
        expect(analyzePlayerStyle(44, 35, 100).id).not.toBe('maniac'); // vpip 미달
        expect(analyzePlayerStyle(50, 29, 100).id).not.toBe('maniac'); // pfr 미달
    });

    it('STATION: vpip>=30 && gap>=15 — MANIAC 다음 순서', () => {
        expect(analyzePlayerStyle(30, 15, 100).id).toBe('station'); // 경계 gap 15
        expect(analyzePlayerStyle(60, 20, 100).id).toBe('station'); // vpip 45+지만 pfr<30
        expect(analyzePlayerStyle(45, 29, 100).id).toBe('station');
        expect(analyzePlayerStyle(30, 16, 100).id).not.toBe('station'); // gap 14
        expect(analyzePlayerStyle(29, 5, 100).id).not.toBe('station');  // vpip<30
    });

    it('감사 케이스: vpip 18 / pfr 2 (gap 16)는 vpip<30이므로 STATION이 아니라 TAG', () => {
        const style = analyzePlayerStyle(18, 2, 100);
        expect(style.id).not.toBe('station');
        expect(style.id).toBe('tag');
    });

    it('타이트-패시브 vpip<17이면 NIT (STATION 아님)', () => {
        expect(analyzePlayerStyle(16, 1, 100).id).toBe('nit');  // gap 15여도 NIT
        expect(analyzePlayerStyle(12, 9, 100).id).toBe('nit');
        expect(analyzePlayerStyle(17, 14, 100).id).not.toBe('nit'); // 경계: 17은 NIT 아님
    });

    it('LAG: vpip>=27 (NIT 다음 순서)', () => {
        expect(analyzePlayerStyle(27, 22, 100).id).toBe('lag'); // 경계
        expect(analyzePlayerStyle(29, 24, 100).id).toBe('lag');
        expect(analyzePlayerStyle(29, 5, 100).id).toBe('lag');  // 루즈-패시브도 vpip<30이면 여기로
    });

    it('GTO: vpip 20~27 && gap<=5', () => {
        expect(analyzePlayerStyle(25, 21, 100).id).toBe('gto');
        expect(analyzePlayerStyle(20, 16, 100).id).toBe('gto');   // 경계 vpip 20 (구 코드는 21이라 누락)
        expect(analyzePlayerStyle(25, 19, 100).id).not.toBe('gto'); // gap 6
        expect(analyzePlayerStyle(19, 15, 100).id).not.toBe('gto'); // vpip<20
    });

    it('그 외는 TAG', () => {
        expect(analyzePlayerStyle(19, 15, 100).id).toBe('tag'); // vpip<20이라 GTO 미달
        expect(analyzePlayerStyle(25, 15, 100).id).toBe('tag'); // gap 10이라 GTO 미달
        expect(analyzePlayerStyle(22, 14, 100).id).toBe('tag'); // gap 8
    });

    it('반환값은 PLAYER_ARCHETYPES 항목 그 자체 (label/color 포함)', () => {
        const style = analyzePlayerStyle(50, 40, 100);
        expect(style).toBe(PLAYER_ARCHETYPES.MANIAC);
        expect(typeof style.label).toBe('string');
        expect(typeof style.color).toBe('string');
    });
});

describe('styleFor — PlayerStats 헬퍼', () => {
    it('stats 없음/0핸드 → UNKNOWN', () => {
        expect(styleFor(null).id).toBe('unknown');
        expect(styleFor(undefined).id).toBe('unknown');
        expect(styleFor({ dealt: 0, vpip: { pct: null }, pfr: { pct: null } }).id).toBe('unknown');
    });

    it('20핸드 미만 → UNKNOWN', () => {
        expect(styleFor({ dealt: 15, vpip: { pct: 30 }, pfr: { pct: 20 } }).id).toBe('unknown');
    });

    it('pct 값으로 분류', () => {
        expect(styleFor({ dealt: 100, vpip: { pct: 50 }, pfr: { pct: 35 } }).id).toBe('maniac');
        expect(styleFor({ dealt: 100, vpip: { pct: 18 }, pfr: { pct: 2 } }).id).toBe('tag');
        expect(styleFor({ dealt: 100, vpip: { pct: 12 }, pfr: { pct: 9 } }).id).toBe('nit');
    });
});

describe('PLAYER_ARCHETYPES / LIVE_PLAYER_PRESETS 이식 검증', () => {
    it('아키타입 7종이 그대로 존재한다', () => {
        expect(Object.keys(PLAYER_ARCHETYPES).sort()).toEqual(
            ['GTO', 'LAG', 'MANIAC', 'NIT', 'STATION', 'TAG', 'UNKNOWN'].sort()
        );
        expect(PLAYER_ARCHETYPES.GTO.criteria.vpipMin).toBe(20);
        expect(PLAYER_ARCHETYPES.STATION.criteria).toEqual({ vpipMin: 30, gapMin: 15 });
        expect(PLAYER_ARCHETYPES.MANIAC.criteria).toEqual({ vpipMin: 45, pfrMin: 30 });
        expect(PLAYER_ARCHETYPES.UNKNOWN.color).toBe('#95a5a6');
    });

    it('라이브 프리셋 12종이 그대로 존재한다', () => {
        expect(Object.keys(LIVE_PLAYER_PRESETS)).toHaveLength(12);
        expect(LIVE_PLAYER_PRESETS.UNKNOWN.stats).toEqual({ vpip: 30, pfr: 15, bet3: 5 });
        expect(LIVE_PLAYER_PRESETS.WHALE.stats.vpip).toBe(80);
        expect(LIVE_PLAYER_PRESETS.OMC.tags).toContain('Zero-Bluff');
        expect(LIVE_PLAYER_PRESETS.SHORT_STACK.id).toBe('shorty');
    });
});

describe('getStatColor 이식 검증', () => {
    it('VPIP 색상 구간', () => {
        expect(getStatColor('VPIP', 55)).toBe('#FF4D4D');
        expect(getStatColor('VPIP', 50)).toBe('#FF4D4D');
        expect(getStatColor('VPIP', 35)).toBe('#FFA500');
        expect(getStatColor('VPIP', 20)).toBe('#2ECC71');
        expect(getStatColor('VPIP', 10)).toBe('#95A5A6');
    });

    it('PFR 색상 구간', () => {
        expect(getStatColor('PFR', 35)).toBe('#FF4D4D');
        expect(getStatColor('PFR', 15)).toBe('#2ECC71');
        expect(getStatColor('PFR', 5)).toBe('#95A5A6');
    });

    it('3-Bet 색상 구간과 기본값', () => {
        expect(getStatColor('3-Bet', 10)).toBe('#FF4D4D');
        expect(getStatColor('3-Bet', 5)).toBe('#2ECC71');
        expect(getStatColor('3-Bet', 2)).toBe('#95A5A6');
        expect(getStatColor('Unknown', 99)).toBe('#ffffff');
    });
});
