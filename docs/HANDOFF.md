# HoldemHUD 핸드오프 문서

> 갱신일: 2026-07-18 · 테스트 421/421 · 빌드/린트 클린
> 다음 작업자는 이 문서 → [REBUILD_DESIGN.md](REBUILD_DESIGN.md) → [ANALYSIS_DESIGN.md](ANALYSIS_DESIGN.md) → [DIFFERENTIAL_REPLAY.md](DIFFERENTIAL_REPLAY.md) 순으로 읽으면 된다.

## 1. 프로젝트 한 줄 요약

라이브 캐시 게임용 포커 트래커/HUD (React 19 + Vite, 웹/Android(Capacitor)/Windows(Electron)) + 완료 핸드 사후 AI 코칭. **개인용 제품** (상업화 안 함). GitHub: https://github.com/leehj1228-Gary/HoldemHUD

## 2. 지금까지의 히스토리 (커밋 순)

| 커밋 | 내용 |
|---|---|
| `e025045` | **v2 전면 리빌딩** — 구버전(92건 버그 감사)을 폐기하고 코어 재작성. 유출 API 키 때문에 orphan 히스토리로 재시작 (구 히스토리는 로컬 `legacy` 브랜치 — **절대 푸시 금지**) |
| `1ab6662`~`cd86d02` | AI 코치 멀티 프로바이더 (Gemini / OpenAI `gpt-5.6-sol` / Anthropic `claude-opus-4-8`) — 키는 앱 내 ⚙️ 설정, localStorage에만 저장 |
| `77558db` | 상세 핸드 트래킹 + AI 리뷰 (풀스트리트, 사이드팟, 숏올인/TDA 누적 재개방, exact/estimated/unknown 정밀도, HandRecord v2) |
| `bc5381d` | 설계 리뷰 확정 이슈 7건 수정 (입력 유실 피드백, 완료핸드 보호, quarantine 로더, minRaiseTo 규칙, 문법 단일화, 화면 가드 일원화, 4MB 텔레메트리+내보내기) |
| `f5af515` | low 이슈 15건 수정 (아카이브 null 방어, seq 수리, 리뷰 익명화 게이트, 두 엔진 프리플랍 규칙 일치, 라이브 통계 currentHand 반영 등) |
| `51e76c6` | **분석 계약 Phase 1** — DecisionSnapshot/AnalysisResult 계약, 게이트웨이, 캐시, computeStatsAsOf, 세션리크 가명화 |
| Phase 3 (2026-07-18) | **PokerKit 차등 리플레이** — golden fixture 14종을 우리 엔진과 pokerkit 0.7.4로 재생해 결정 단위 팟/스택/합법액션/사이드팟 parity를 CI 강제. TDA 누적 재개방이 PokerKit과 완전 일치함을 교차 확증, 문서화된 해석 차이 2건(F08 체커 vs 서브민 올인벳, F09 스트래들 최소 리레이즈), 광고/적용 불일치 엔진 버그 1건 수정(콜 올인 전용 스택에 raise 광고). WSL 불필요 — 네이티브 Windows Python으로 동작 |
| 상세 기록 간소화 (2026-07-18) | **쇼다운 자동 승자 판정 + 배치 스텝** — engine/handEvaluator.js(7장 NLHE 평가기, 순수)로 보드 5장+생존자 카드가 알려지면 팟별 승자를 자동 판정(수동 선택은 폴백/오버라이드, 동률=스플릿). 차등 하네스가 평가기를 PokerKit 자체 쇼다운 평가와 교차 검증. 배치 스텝 3종(나머지 폴드/체크 다운/런아웃 일괄 — all-or-nothing 순수 루프 + 리듀서 액션)으로 기록 탭 수 대폭 축소. 브라우저 E2E로 전 플로우 검증 |
| 팟 병합 버그픽스 + 히스토리 상세 확인/수정 (2026-07-18) | **deriveSidePots가 자격 동일 인접 레이어를 병합** — 사이드팟은 생존자 올인 경계에서만 갈라진다(폴드 커밋 경계로 HU 팟이 메인+사이드로 표시되던 버그; 차등 하네스의 병합 규약을 엔진 본체로 승격). 주의: 병합으로 팟 인덱스가 재정렬돼 이전 커밋으로 기록된 winners.potIndex와 표시가 어긋날 수 있음(마이그레이션 없음 — 개인용 수용). **히스토리 상세 핸드 확인/수정** — 핸드 뷰에 공개 카드·평가 라벨·팟별 승자·언콜드 반환 표시, DetailedHandEditor(카드·승자만 수정, 원장 불변)로 아카이브 사후 수정. applyArchivedHandPatch(리듀서·컨텍스트·화면 공유 단일 구현) + UPDATE_ARCHIVED_HAND |

## 3. 아키텍처 지도

```
src/
  engine/          # 순수 모듈 (React·storage import 금지)
    schema.js          # 데이터 문법의 유일한 선언처 (상세 문법 포함 — 재선언 금지)
    handEngine.js      # 간편(프리플랍) 핸드 상태 머신
    detailedHandEngine.js  # 풀스트리트 리플레이 엔진 (팟/사이드팟/합법액션/minRaiseTo)
    statsEngine.js     # 유일한 통계 구현 + computeStatsAsOf (시간축 안전)
    archetypes.js      # 플레이어 유형 분류
  storage/         # 버전드 영속화 (hh:v1:* envelope, v33 마이그레이션, analysisCache LRU)
  state/           # 단일 useReducer 원자 (gameReducer 순수) + 얇은 GameContext
  services/        # aiService (3사 raw fetch) + detailedReview (컷오프/화이트리스트/검증)
  analysis/        # ★ 신규 — 분석 계약 계층 (연구 기준서 §14-16 구현)
    contracts/         # decision-snapshot.v1, poker-analysis-result.v1, capabilities, error
    snapshot/          # buildDecisionSnapshot (컷오프 단일 소스 = detailedReview)
    gateway/           # analysisGateway (검증→어댑터→주장검증→캐시), capabilityRegistry
    adapters/          # heuristicLlmAdapter (현행 리뷰 래핑; solver 어댑터 자리)
    validation/        # validateModeClaims (모드별 금지 주장 테이블)
    pseudonyms.js, hash.js
  components/      # 화면 — useGame()만 사용, 규칙 인라인 계산 금지
tests/             # vitest 381개 (engine/state/storage/services/analysis/components)
```

**불변 원칙** (모든 리뷰·수정에서 강제해온 것):
1. 통계는 증분 카운터 금지 — 항상 핸드 레코드 리플레이로 파생
2. 리듀서는 순수, 불법 액션은 **동일 참조 반환**(no-op) — UI는 이걸로 거부 감지
3. 문법(카드/스트리트/정밀도/액션)은 schema.js에서만 선언
4. 로드 시 검증 실패 데이터는 **삭제 대신 격리**(quarantinedHands)
5. AI에는 결정 시점 이전 정보만 (prefixHandForDecision이 유일한 컷오프 구현)
6. 외부 전송 전 실명 → 가명 (`player:xxxxxxxx`), 화면에서 로컬 re-join
7. LLM은 설명만 — 수치·합법액션·전략빈도는 만들 수 없음 (모드별 claim validator가 차단, heuristic_no_solver는 신뢰도 45% 캡)

## 4. 확정된 제품 결정 (2026-07-16 사용자)

- **개인용 유지** — 상업화 안 함 (PokerSkill CC BY-NC·AGPL solver의 로컬 연구 사용 가능, 단 번들 배포 금지)
- **클라우드 전송 허용** — 단 가명화 필수 (구현 완료)
- **LLM 비용 상한 없음** / **solver API(GTO Wizard) 없음** — solver-free 경로로 진행
- **실시간 RTA 금지** — 완료 핸드 사후 리뷰와 샌드박스만 (포커룸 정책; 연구 기준서 §13)

## 5. 발전 방향의 기준 문서

`C:\Users\Administrator\Desktop\pokerskill\reports\holdemhud_ai_analyzer_research.md` (3,767줄)가 장기 설계의 authoritative 문서다. 같은 폴더에 PokerBench 감사, PokerSkill 저장소/논문 4편. 핵심 결론: **결정론적 계산 → baseline → 상한 있는 exploit 조정 → LLM은 설명만**의 하이브리드. PokerSkill 성능표는 프리플랍 LLM 우회 교란 때문에 그대로 믿지 말 것(§4.6), PokerBench는 런타임 GTO DB로 쓰지 말 것(§7).

## 6. 다음 단계 (우선순위 제안)

1. ~~**Phase 3 — PokerKit 차등 리플레이**~~ ✅ 완료 (2026-07-18, [DIFFERENTIAL_REPLAY.md](DIFFERENTIAL_REPLAY.md)). 남은 조각: 런타임 핸드별 sidecar 검증(`REPLAY_DISAGREEMENT` 연결)은 후속 — CI 게이트는 가동 중.
2. **Phase 5 — HU river 토이 solver**: fold/call → 단일 벳 사이즈 순. 첫 `solver_calibrated` 어댑터. 계약·모드 테이블은 이미 준비됨(capabilities에 등록만).
3. **Phase 2 잔여 — stable player ID**: 현재 식별자는 trim된 이름. 개명/동명이인 대응.
4. **Phase 6 — 상대 모델**: Beta-Binomial shrinkage + exploit cap (연구 §18 공식 그대로).

## 7. 알려진 한계 / 주의 사항

- **electron/preload.js의 eslint no-undef 1건**: 의도된 CJS 파일 — `npx eslint src tests`로 검사 범위를 잡으면 무관 (전 저장소 lint 시에만 보임)
- **dev 서버 콘솔의 "useGame은 GameProvider 안에서만" 에러**: GameContext.jsx 핫리로드(HMR) 잔재 — 새로고침하면 사라짐, 프로덕션 무관 (두 차례 검증됨)
- **아카이브 JSON 내보내기**: Android WebView에서는 앵커 다운로드 미지원 가능 — 필요 시 @capacitor/filesystem 연동
- **API 키가 localStorage에 저장됨**: 개인용이라 수용, 연구 기준서 §12.4에 개선 경로(OS credential store) 있음
- **analysisCache 키**: (inputHash, adapterId, promptVersion) — adapterVersion 단독 범프 시 promptVersion도 같이 올릴 것 (검증 노트)
- **archetypes TAG fallback**: 루즈-패시브가 TAG로 분류되는 minor — 설계 계약 §4 체인 그대로 (의도된 동작으로 문서화됨)
- **미구현 모드**(range_estimated/solver_calibrated/exploit_adjusted)는 capabilities에 열거만 되어 있고 게이트웨이에서 선택 불가 — 구현 시 validateModeClaims의 해당 행 강화 필요(sensitivityRangeIds, configHash)

## 8. 개발 명령어

```bash
npm run dev          # http://localhost:5173
npm test             # vitest 397개 — 모든 변경 후 필수 (PokerKit 골든 대조 포함, Python 불필요)
npm run build        # vite 프로덕션 빌드
npx eslint src tests --max-warnings 0
npm run diff:pokerkit # 차등 리플레이 골든 재생성+대조 (pip install pokerkit==0.7.4)
npm run electron:dev # Windows (ELECTRON_START_URL 자동)
npx cap sync android # Android
```

작업 규칙: 변경마다 **테스트/빌드/린트 3종 게이트 유지 + 행동 수정엔 회귀 테스트 추가**. 설계 계약(REBUILD_DESIGN.md·ANALYSIS_DESIGN.md)과 다르게 구현하지 말고, 모호하면 계약을 먼저 고친다.
