# AI 분석 계약 설계 (Phase 1 — 계약·스냅샷·검증 기반)

권위 있는 장문 기준서: `C:/Users/Administrator/Desktop/pokerskill/reports/holdemhud_ai_analyzer_research.md`
(특히 §11 현재 컷오프/whitelist, §14 목표 아키텍처·mode, §15 계약, §16.1 디렉터리, §21 Phase 1).
이 문서는 구현된 계약의 요약이며, 모호하면 연구 기준서를 따른다.

## 디렉터리

```
src/analysis/
  hash.js                      # canonicalStringify + computeInputHash (sha256:<hex>)
  pseudonyms.js                # 실명 → 안정적 가명 ID (기존 모듈, 재선언 금지)
  contracts/
    decisionSnapshot.js        # decision-snapshot.v1 + validateDecisionSnapshot ({ok,errors})
    analysisResult.js          # poker-analysis-result.v1 + validateAnalysisResult ({ok,errors})
    capabilities.js            # analysis-capabilities.v1 + ANALYSIS_MODES (5종)
    analysisError.js           # poker-analysis-error.v1 + ANALYSIS_ERROR_CODES (11종)
  validation/
    validateModeClaims.js      # mode별 금지 주장 표 (MODE_CLAIM_RULES)
  snapshot/
    buildDecisionSnapshot.js   # HandRecord + decisionSeq → DecisionSnapshot v1 (async)
```

## 스키마 버전 (문자열 상수)

`decision-snapshot.v1` / `poker-analysis-result.v1` / `analysis-capabilities.v1` / `poker-analysis-error.v1`
— 앱 저장 스키마 버전(1)·상세 핸드 schemaVersion(2)과 독립이다 (연구 §8.3).

## DecisionSnapshot v1 불변조건 (§15.1의 구조 검사 가능 항목)

1. 컷오프 이후 정보 부재: priorActions는 `seq < decisionSeq`·현재 거리 이하만, visibleBoard는 거리별 허용 장수만.
   `reveals/winners/showdown/result/payout` 등은 **어느 깊이에서도 키 자체가 금지**되고, 알 수 없는 필드는 전면 거부.
2. hidden card는 hero.holeCards뿐 (players에는 카드 필드가 없다 — 키 whitelist).
3. `amountTo`(그 거리 누적 도달액) ≥ `amountAdded`(이번에 추가한 칩) — 의미 혼용 금지.
4. 모든 칩 수치는 chips 단위 하나 (BB 변환은 adapter 책임).
5. legalOptions의 size bound는 replay에서만 나온다: call.amountAdded=state.toCall,
   raise/bet의 minTo=state.minRaiseTo·maxTo=state.maxRaiseTo, minTo≤maxTo.
6. 실명·PII 금지: `name/displayName/email/apiKey/note(s)` 키 금지, playerId는 `player:<hex8>`(가명) 또는 `seat:<n>`.
7. opponentModelRef는 현재 핸드 이전 자료만 (`asOfHandId !== handId`).
8. 같은 canonical 입력 → 같은 `provenance.inputHash` (`verifySnapshotInputHash`로 재계산 검증).
9. null(unknown) ≠ 0. NaN/Infinity 금지.
10. `dataQuality.validationErrors`가 비어있지 않으면 analyzer 호출 금지 → `isAnalyzableSnapshot()`.

## 빌더 결정 사항 (연구 예시와 다르게 확정한 부분)

- 컷오프는 `detailedReview.prefixHandForDecision` **재사용** (export 추가, 알고리즘 단일 원천).
- `decisionId = "<handId>:seq:<decisionSeq>"`.
- `state.potBeforeAction` = 결정 직전 replay pot(현재 직면한 베팅 포함) — `potOddsRequiredPct =
  toCall/(pot+toCall)*100`과 일관 (§15.1 예시의 127.5는 자체 potOdds와 모순이라 채택하지 않음).
- priorAction.potFraction = `amountAdded / (그 액션 직전 pot)`, 칩 미추가 액션은 null. 반올림은 소수 4자리.
- `game.chipUnit`은 숫자(최소 칩 단위), `format`은 현재 'cash' 고정, `ante` 0 강제(비zero ante 거부), `rake` null.
- maxRaiseTo는 hero 스택이 exact일 때만 (`streetCommitted + stack`), estimated 스택은 상한이 아니다.
- minRaiseTo > maxRaiseTo면 그 raise/bet 옵션은 계약에서 제외 (all-in 옵션이 유일한 초과 경로).
- `requestId`는 gateway가 해시 이후 붙일 수 있으므로 inputHash 계산에서 제외.
- contestablePots는 결정 시점의 콜 완료된 팟(deriveSidePots.pots)만 — 미응답 초과분은 팟이 아니다.
- `opponentStatsAsOf` 미지정 시 opponentModelRef는 null (Phase 2에서 as-of 통계로 채움).

## AnalysisResult v1 불변조건 (§15.2)

- recommendation.primaryAction·alternatives·baselineStrategy[].action ∈ snapshot legalOptions.
- sizeTo는 해당 옵션의 minTo/maxTo 안 (bet/raise/all-in 외에는 sizeTo 금지).
- baselineStrategy frequency는 전부 있으면 합 ≈ 1 (허용 오차 0.02).
- 수치 fact(computedFacts.*.value가 숫자)는 method + 선언된 provenance 항목 필수.
- explanation.reasoning[].factRefs ⊆ `allowedFactRefsForSnapshot(snapshot)` ∪ provenance id ∪ computedFacts 키.
- result.inputHash === snapshot.provenance.inputHash, decisionId 일치.
- mode 금지 주장은 validateModeClaims 표가 추가 강제.

## 분석 mode 표 (§14.4 — MODE_CLAIM_RULES)

| mode | 구현 | 핵심 금지(구조 검사) |
|---|---|---|
| `heuristic_no_solver` | ✅ (유일) | equity/EV/frequency 수치, exploit 적용, GTO·에쿼티·기대값·최적 어휘, 정확 %, confidence>0.45 |
| `calculator_exact` | ⏳ | EV/frequency 수치, exploit, range 없는 최적성 단정 어휘 |
| `range_estimated` | ⏳ | EV/frequency 수치, exploit; equity에는 선언된 rangeId 필수 |
| `solver_calibrated` | ⏳ | exploit; frequency/EV에는 engine+version provenance 필수 |
| `exploit_adjusted` | ⏳ | 적용 시 evidenceRefs·maximumShift 필수 (무제한 exploit 금지) |

heuristic 행의 금지 어휘·confidence cap(0.45)은 `services/detailedReview.js`의
`FORBIDDEN_PROSE_PATTERN`/`CONFIDENCE_CAP`을 import해 재사용한다 (기존 리뷰 validator와 항상 동일).

## 오류 계약 (§15.3)

`poker-analysis-error.v1`: `{requestId, decisionId, code, stage, retryable, safeFallbackMode, userMessageKo(한국어 필수), diagnosticRefs}`.
code 11종: INVALID_LEDGER, REPLAY_DISAGREEMENT, FUTURE_INFORMATION_DETECTED, UNSUPPORTED_SCOPE,
INSUFFICIENT_RANGE_INFORMATION, SOLVER_TIMEOUT, SIDECAR_UNAVAILABLE, PROVIDER_TIMEOUT,
MALFORMED_MODEL_OUTPUT, CLAIM_VALIDATION_FAILED, COST_BUDGET_EXCEEDED.

## 유지 원칙

- 기존 `detailed-review-payload.v1` 경로(`buildDetailedReviewPayload` 등)는 동작 변경 없이 보존 — fallback.
- engine/storage 순수성 규칙(REBUILD_DESIGN §1)은 analysis에도 적용: React·DOM·storage import 금지.
- 새 mode·adapter는 계약 파일 수정 없이 MODE_CLAIM_RULES 행 추가 + capability 선언으로 확장한다.
