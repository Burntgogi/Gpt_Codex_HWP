# Gpt_Codex_HWP v0.3.5 릴리즈 노트

- 준비일: 2026-10-21 (UTC)
- 플러그인 버전: `0.3.5+codex.20261021184753`
- Claude Code 캐시: `0.3.5-codex.20261021184753`
- 게시 확인: 아래 설치 안내는 [불변 v0.3.5 릴리즈](https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.3.5)의 정확한 SHA·자체 전체 태그 게이트·동일 실행의 strict subject attestation 3개와 원본 ZIP·SPDX·provenance·SHA256SUMS 4개 공개 자산을 실제로 검증한 뒤에만 적용하십시오. 소스 준비나 다른 태그의 성공 기록은 게시·설치·업그레이드 증거가 아닙니다.

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 원본 실패 영수증 보존

고정 진단 선택기가 설정 코드 순서가 아니라 실제 TAP 오류의 시간순으로 첫 allowlist 오류를 보존합니다. 여러 Node case가 실패하는 실제 자식에서 수정 전 `LATER_FIXED_FAILURE`, 수정 후 `FIRST_FIXED_FAILURE`를 선택했고 양쪽 모두 자식·파일 실패를 유지했습니다. 영구 실제 자식 회귀는 수정 전 실패·수정 후 통과했습니다.

history scanner는 기존 strict public-process 실패 observer를 bounded batch에 전달합니다. 원본 `pc17` replacement-ref 비공개 tree 보안 테스트의 실제 보안 finding 단언 2개와 workload·정책·제한은 모두 유지하며, wrapper는 원본 예외를 cause로 보존하면서 고정 단계 또는 기존 안전한 process-code 진단을 보고합니다. 실제 Git `cat-file` 명령 실패 smoke는 수정 전 거친 `pc17`, 수정 후 bounded `pc17-replace-scan`이었고 양쪽 모두 exit 1입니다. native·RSS·정리 성공 증명을 합성하지 않습니다. native collector·C#·PowerShell, 권한·mode 1·identity·RSS·실행·캡처·정리 제한은 그대로입니다.

이미 삭제한 source-copy 테스트의 낡은 catalog 항목을 제거하고 oracle dispatch는 불안정한 `rv32` ordinal 대신 의미 flag를 사용합니다. 부수적인 source·default·전체 출력·mock echo 단언은 재고정하지 않고 폐기합니다. 이는 증거 손실 수정이지 원본 native·`pc17` 원인 해결이나 설명이 아닙니다.

## 준비 중 첫 플랫폼 실패와 worker fixture 순서

준비 head `0c03cbd`의 원본 [CI 39658607959](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39658607959)는 Windows 실제 runtime-install 정리 중 `windows-helper-sampling`, macOS `document-worker-client.test.ts` ordinal 7에서 실패했습니다. 후자는 ready 이전/이후 crash·OOM 서명·잘못된 event와 각 복구를 검사하며, 원본 로그는 정확한 하위 경우를 남기지 않았습니다.

별도로 worker fixture가 public port에 ready를 보낸 직후 다른 내부 error port로 uncaught error를 보내므로 caller의 ready 관측 순서를 보장하지 못하는 결함을 확인했습니다. direct-client·MCP factory 두 곳을 같은 test-owned 4-byte shared gate로 이관했습니다. 기존 유효 ready의 동기 listener가 끝난 뒤 microtask가 gate를 열고 fixture가 원래 uncaught error를 발생시킵니다. production 프로토콜·메모리·실행·정리 제한과 OOM 서명 분류는 그대로이며 실제 heap exhaustion을 주장하지 않습니다. 실제 worker의 ready 전달만 100ms 지연한 제어 실험에서 수정 전 error 시 ready 미관측, 수정 후 ready 관측을 확인했고 양쪽 worker는 실제 uncaught error로 exit 1이었습니다. 실제 client·MCP crash 검사는 통과했지만 원본 macOS 인스턴스의 원인 증명은 아닙니다.

별도 원래 한도의 실제 [Windows 설치 native 연산 관측 39660747064](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39660747064)은 9 tools·HWPX 14,421 bytes·stderr 0·잔여 자손 0으로 통과했고 실패 연산 기록은 없었습니다. 따라서 원본 실패 복구나 native 수정으로 취급하지 않습니다. 관측용 PowerShell 변경은 배포 코드가 아니며 원본 sampling 원인은 여전히 미확정입니다.

수정 fixture head `8f3faf8`의 원본 [CI 39661963812](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39661963812)는 macOS·Linux를 통과했지만 Windows 실제 one-shot 정리가 다시 `windows-helper-sampling`으로 실패해 병합·태그를 보류했습니다. sampling은 discovery/RSS 외에 command 완료도 포함합니다. 현재 경로는 기존 bounded ERROR reason에 snapshot/open/parent/state/working-set/command-read/command-value의 고정 연산 이름만 보존하고 strict public 진단으로 전달합니다. 추가 쿼리·경로·PID·raw 예외 문자열이나 권한·C# 바이너리·측정·정리 제한 변경은 없으며 원본 native 원인 해결을 주장하지 않습니다.


## 불변 미게시 v0.3.4 기록

`v0.3.4`는 neutral owner `58d48d0eb76914245ee2142a6f6681008c8a6f24`에 보존하며 정상 병합 main `931f82bfe2c0babc60caf2c0f7726f05bcbad936`과 tree가 정확히 같았습니다. 모든 [PR CI 39647945797](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39647945797)·[Security 39647945795](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39647945795)와 원본 [main CI 39649661879](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39649661879)·Security는 통과했고 보호 정책은 바꾸지 않았습니다. 원본 [전체 태그 게이트 39651543739](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39651543739)는 초기 10 MiB smoke 통과 뒤 node-tests에서 `WINDOWS_REPOSITORY_TEST_CASE case=pc17 status=failed`로 실패했습니다. 자산·attestation·Release는 없습니다.

후속 실제 계측 full-file [Windows 진단 39653661700](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39653661700)은 모든 replacement 단계를 통과했고 `historyFailures`가 없었습니다. 원본 실패 복구나 과거 원인 증명은 아니며 정확한 원인은 여전히 미확정입니다. 이전 태그·실행을 보존하고 v0.3.5 자체 게이트 증거로 재사용하지 않습니다.

원본 Windows sampling 실패의 정확한 원인은 미확정입니다. 별도 [실제 핸들 제어 실험](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39638006755)에서 기존본과 재사용 수정안이 모두 실제 RSS·native mode 1·정리 검사를 통과했고, 실험 workflow는 기대한 기존본 실패가 없어 실패했습니다. 따라서 회귀 재현으로 취급하지 않고 가설성 네이티브 수정과 테스트를 배포안에서 제외했습니다. 수집기의 권한·stable identity·RSS·실행·정리 제한은 그대로입니다.

릴리스 wrapper가 원래의 상세 `WINDOWS_NODE_TEST_FAILURE`를 뒤따르는 거친 파일 영수증으로 덮어쓰지 않도록 수정했습니다. 실제 자식 parser 수정 전·후 비교에서 양쪽 모두 실패 상태를 유지하고 수정본만 원본 상세 영수증을 보존했으며 준비된 동작 검사도 통과했습니다. 중복 MCP 도구 이름 literal과 단순 not-throw wrapper, 소스·명령 복사 검사는 제거하고 실제 초기화 서버의 전체 schema catalog·버전·stderr, 실패 우선순위·비공개 내용 비노출·자원 제한 검사는 유지합니다.

준비 PR #32의 원본 [Windows 실행 39643306576](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39643306576)은 당시 process-tree stress case `bp16`에서 `windows-channel`, root 정리 미검증으로 실패했습니다. 같은 job의 후속 전체 진단 통과는 원본 복구나 원인 증명이 아닙니다. 기존 관측 경로가 실제 supervisor 오류 단계를 받은 뒤 RSS 파싱·재시도의 일반 channel 오류로 덮을 수 있는 별도 결함을 확인했습니다. 첫 allowlist 오류 단계를 보존하도록 고쳤고, 실제 Node 자식의 오류 프레임 처리에서 수정 전 `windows-channel`, 수정 후 원본 `windows-sampling` 보존을 확인했습니다. 이 실험은 native Job·RSS·정리 성공을 생성하거나 주장하지 않습니다. 원본 native 정리 실패의 정확한 원인은 여전히 미확정이며 실행·측정·identity·정리 정책과 stress workload는 그대로입니다.


준비 중 Linux 실제 런타임의 도구 9개·HWPX 14,421 bytes·stderr 0 bytes·남은 감독 자손 0개와 child-client 동작 검사를 확인했습니다. 이 기록은 최종 태그·게시·업그레이드나 Windows native·실제 Mac/Claude/한컴 GUI 성공을 대신하지 않습니다.

## 제한을 유지한 릴리스 경로 개선

릴리스 생성기·검증기·플랫폼 영수증은 기존 Git `cat-file --batch` 규약을 공유하고 커밋의 blob OID를 유지합니다. 파일마다 크기·내용을 별도 subprocess로 조회하지 않습니다. 파일별·총 바이트 제한, OID/type/framing·스트림 끝 검사, 커밋과 staged bytes 비교, Git 환경 격리와 비공개 내용 검사는 유지합니다.

원본 테스트가 제한 초과로 중단될 때 이미 수집한 제한 내 TAP의 보고 완료 ordinal·요약과 spawn/exit/stdout-end/close/deadline/grace를 보존합니다. 보고된 ordinal은 실행 중인 case의 추정이 아니며, 종료 함수의 정착·반환값도 정리 완료 증명은 아닙니다. 전체 TAP이 통과해도 프로세스가 닫히지 않아 deadline에 걸리면 계속 실패입니다. 120초 일반 파일 제한, 5초 종료 grace, 512 KiB 캡처는 바꾸지 않았고 원문·경로·환경·비공개 canary는 출력하지 않습니다.

[Windows 순서 교차 실험](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39609784474)은 양쪽 순서에서 기존본과 수정본을 각각 한 번 실행했고 네 실행 모두 원래 제한 안에 통과했습니다. 파일 종료 시간 단축은 관측했지만 과거 개별 시간 초과의 원인을 증명한 것은 아닙니다. 별도 실제 Linux 자식 프로세스 실험에서는 중단 시 기존본이 버리던 실패 TAP을 수정본이 보존하면서 양쪽 모두 실패를 유지하고 소유 그룹 부재를 확인했습니다.

## 불변 미게시 v0.3.2·v0.3.3 후보

불변 `v0.3.2`의 owner는 `f02d7ff416f76ee34fbd3bc0f31ab501988148fc`입니다. [전체 게이트·attestation](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39599590179)은 통과했지만, [병합 후 main CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39599469450)의 원본 Windows `release-artifacts.test.ts`가 제한 초과로 실패해 게시를 보류했습니다. 정확한 원인은 복원하지 못했습니다.

불변 `v0.3.3`의 owner는 `5ac9f568f4ac0c3d5cec14f54f2a68acf996bc19`이며 정상 병합 main `8e1ce2ae90038907873880ad96bd365d18a2526c`과 tree가 같습니다. [PR CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39627644066)의 네 검사와 [Security](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39627643973)는 통과했으나, [원본 병합 후 실행](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39629542245)의 실제 Windows 런타임은 one-shot 정리 중 `windows-helper-sampling`에서 실패했습니다. [태그 전체 게이트](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39629550109)는 초기 10 MiB smoke를 통과한 뒤 full node의 `mcp-smoke`에서 실패했습니다. 자산·attestation·Release는 없습니다.

후속 [계측 native 실행](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39633262366)은 실제 도구 9개·HWPX 14,421 bytes·stderr 0 bytes·남은 자손 0개였고, [변경 없는 MCP 실행](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39633269000)도 통과했습니다. 그러나 원본 sampling·MCP 실패의 정확한 원인은 여전히 알 수 없으며 후속 성공이 원본 실패를 복구하거나 무효화하지 않습니다. 두 태그를 옮기지 않고 v0.3.5의 새 identity와 자체 검증 경로를 사용합니다.

## 정상 reparenting과 실제 RSS

부모 프로세스가 종료되어 재부모화되더라도 PID·프로세스 그룹·시작 시각이 같으면 같은 프로세스입니다. 이전 수집기는 부모 PID 변화만으로 실제 VmRSS를 거부했습니다. v0.3.5는 v0.3.3 후보의 기존 stable-identity 비교 재사용을 유지하고 그룹·시작 identity의 읽기 내/재시도 간 변경은 거부합니다. live/unknown/권한 실패의 RSS 누락은 계속 실패하며, 기존 최대 3회 측정과 간격·타임아웃·별도 정리 증명은 바꾸지 않았습니다.

실제 Linux 부모·자식 프로세스의 합법적인 재부모화를 제어해 수정 전 거부, 수정 후 실제 `/proc` VmRSS와 반환 RSS 일치, 별도 등록 authority의 그룹 부재 증명을 확인했습니다. 새 회귀 7건은 수정 전 실패·수정 후 성공했습니다. 후속 CI의 stage-only 로그만으로 그 개별 실패가 이 경합이었다고 단정하지 않습니다. 진단 문자열·기본 단계·문구·소스 정규식 검사는 재고정하지 않고 폐기했으며, 실제 실패 상태·RSS·비공개 내용 비노출·정리 조건은 보존했습니다.

## 설치와 검증 범위

v0.3.5 자체 게시 증거를 확인한 뒤 README의 v0.3.5 태그 변경 절을 따르고, 검증한 원본 공개 ZIP과 설치 캐시 바이트 비교를 포함한 실제 격리 profile 업그레이드를 요구하십시오. 소스 remove/add가 이전 캐시를 남겨도 Codex CLI 0.162.1의 `plugin add`는 이전 캐시를 정리할 수 있습니다. 이전 지속 런타임을 수동으로 삭제하지 말고 새 identity·`installedPath`·명시적 설치·doctor·호스트 재시작·문서 작업과 one-shot·자손 종료를 검증하십시오. v0.3.1의 markdown-it 14.3.3 패치는 유지하며 9개 도구·HWP 읽기 전용/HWPX 쓰기 정책은 바꾸지 않습니다.

v0.3.1 태그·자산·검증 기록과 불변 미게시 v0.3.2·v0.3.3·v0.3.4 태그는 그대로 보존합니다. 새 버전의 게시와 플랫폼 검증은 위 v0.3.5 릴리즈의 실제 기록으로만 판단하십시오. 호스팅 macOS는 실제 Mac/Desktop/Claude Code/한컴 GUI 검증을 대신하지 않으며 기본 사용자 설치를 주장하지 않습니다. 게시 자산은 정확한 불변 태그의 전체 게이트와 strict subject attestation 3개가 성공한 동일 실행의 ZIP·SPDX·provenance·SHA256SUMS여야 하며 로컬 재빌드를 대체하지 않습니다.

## 과거 v0.3.1 공개 기록

# Gpt_Codex_HWP v0.3.1 릴리즈 노트

- 상태: [v0.3.1 게시 완료](https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.3.1)
- 게시 시각: 2026-10-21T11:32:22Z
- 플러그인 버전: `0.3.1+codex.20261021043114`
- Claude Code 캐시 디렉터리: `0.3.1-codex.20261021043114`

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 보안 패치

v0.3.1은 소스와 생성 런타임의 markdown-it을 14.3.1에서 14.3.3으로 갱신해 [GHSA-gfr2-rv44-r23c](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c), [GHSA-r7fv-28h4-cvq7](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-r7fv-28h4-cvq7), [GHSA-vfgh-jcmw-g37q](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-vfgh-jcmw-g37q)에 대응합니다. 기존 14.x API와 파서 옵션을 유지하며 새 기능, PDF 지원이나 MCP 도구를 추가하지 않습니다.

## 설치와 업그레이드

README의 게시된 `v0.3.1` 태그 고정 설치 명령을 사용하십시오. 직전 공개 릴리즈는 v0.3.0입니다. 플러그인을 다시 설치하고 `version`이 `0.3.1+codex.20261021043114`이며 `installedPath`가 새 캐시 디렉터리인지 확인하십시오(Claude Code에서는 `+`를 `-`로 표기). 새 identity는 이전 런타임을 재사용하지 않으며, 이전 런타임의 의존성만 제자리에서 갱신하는 것은 업그레이드가 아닙니다.

이미 다른 태그를 등록한 Codex에서는 호스트를 닫고 `codex plugin marketplace remove gpt-codex-hwp-local --json`으로 소스 등록만 제거한 다음 `marketplace add ... --ref v0.3.1 --json`과 `plugin add ... --json`을 실행하십시오. 기존 등록에 `marketplace add`를 다시 호출하는 것만으로는 ref가 변경되지 않습니다. Codex CLI 0.162.1의 격리 Linux 업그레이드에서 `plugin add`가 이전 캐시를 정리했지만 이전 지속 런타임의 lock·영수증은 그대로였습니다. [README 태그 변경 절](README.md#기존-설치의-태그-변경)에 정확한 명령과 이전 태그 캐시를 복구해 doctor를 통과한 경로가 있습니다. 이전 지속 런타임을 직접 지우지 마십시오.

검증한 새 `installedPath`에서 명시적으로 실행하십시오.

    node dist/install-runtime.js --json
    node dist/doctor.js --json

`RUNTIME_INSTALL_OK`와 `DOCTOR_OK`를 확인하십시오. 실행 중인 모든 Codex CLI와 Desktop 호스트, 또는 Claude Code 세션을 완전히 닫았다가 다시 여십시오. 문서 작업 하나를 완료하고 결과를 검증한 뒤 one-shot 프로세스와 하위 프로세스 종료를 확인하십시오. 이 절차가 성공할 때까지 이전 지속 런타임을 수동으로 삭제하지 말고, 성공 후에만 더 이상 쓰지 않는 정확한 버전 디렉터리를 제거하십시오.

## 검증과 게시 경계

- 태그 commit `4180a8d35e01aa95205a39c60ae9686486f6f9cb`의 [Windows x64·macOS arm64·Linux CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39585790921)와 [Security policy](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39585790893)가 성공했습니다. 병합 당시 main `633421e39e0ecad35817bcfe8b061f7b80da7ea8`과 tree가 동일하며 [병합 후 CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39587356229)도 성공했습니다. 보호 변경이나 예외 병합은 없었습니다.
- [불변 태그 전체 게이트·attestation 실행 39589053351](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39589053351)이 성공했습니다. 같은 실행의 ZIP·SPDX SBOM·provenance·SHA256SUMS만 게시했고 GitHub 자산 digest가 원본과 일치합니다. 세 subject의 서명을 정확한 repo·source SHA/ref·workflow@tag·GitHub-hosted runner·같은 run invocation에 묶어 독립 검증했습니다. 기존 산출물 검사도 135 runtime files·152 production packages·9 tools와 source commit/tree·체크섬 일치를 확인했습니다.
- 실제 Codex CLI 0.162.1의 fresh 격리 Linux 프로필에서 v0.3.0 → v0.3.1 태그 업그레이드를 확인했습니다. 캐시 135개 파일이 검증 ZIP과 바이트 단위로 같고, 새 런타임의 `RUNTIME_INSTALL_OK`, `DOCTOR_OK`, markdown-it 14.3.3, HWPX 생성/검증(14,421 bytes), stderr 0 bytes, 남은 감독 자손 0개를 확인했습니다. 이전 지속 런타임의 lock·receipt hash는 불변입니다.

아래 v0.3.0 기록은 과거 기록이며 위 검증을 대신하지 않습니다. 호스팅 macOS 성공은 실제 Mac의 Codex Desktop·Claude Code·한컴오피스 GUI 검증이 아닙니다. 사용자 기본 프로필과 실행 중인 호스트는 변경하지 않았으며 실제 사용 환경의 재시작·문서 작업은 설치 후 확인해야 합니다. 로컬 재빌드는 배포 자산으로 사용하지 않았습니다.

## 과거 v0.3.0 릴리즈 기록 (2026-10-08)

# Gpt_Codex_HWP v0.3.0 릴리즈 노트

- 상태: 정식 릴리즈
- 작성일: 2026-10-08
- 검증 기준: Windows x64 로컬 검증, Windows x64·macOS arm64·Linux 호스팅 CI 통과, Claude Code는 Windows x64에서만 검증, 실제 Mac 기기 미검증

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 개요

v0.3.0은 같은 플러그인 폴더를 Codex와 Claude Code 양쪽에서 쓰도록 지원을 넓힌 릴리스입니다. CI가 검증하는 문서 크기 등급을 10 MiB로 낮추고, 공문서 초안을 점검하는 선택 플러그인 `korean-official-doc`을 추가했습니다. HWP 읽기 전용·HWPX 쓰기 정책, 내부 one-shot 도구 9개, 런타임을 명시적으로 설치하는 절차는 v0.2.7과 같습니다.

## 주요 변경 사항

- Claude Code 지원: 저장소 루트의 `.claude-plugin/marketplace.json`과 생성되는 `plugins/gpt-codex-hwp/.claude-plugin/plugin.json`을 추가했습니다. 런타임은 Claude Code 캐시 배치(버전의 `+`가 `-`로 바뀐 디렉터리)를 인식하고, 운영 의존성을 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/plugin-runtime-data`에 Codex와 따로 저장합니다.
- 크기 등급: CI 검증 범위를 100 MiB에서 10 MiB로 낮췄습니다. 대부분의 한글 문서는 1 MiB 안팎입니다. 10 MiB 초과 512 MiB 이하는 이론상 지원하지만 크기별로 검증하지 않으며, 512 MiB 초과는 계속 거부합니다.
- 선택 플러그인 `korean-official-doc`: 공문서 Markdown 초안의 날짜·시각·금액 표기, 항목 기호 순서, 붙임, 「끝」 표시를 「행정업무의 운영 및 혁신에 관한 규정」과 시행규칙 근거와 함께 오프라인으로 점검합니다. 의존성이 없고 Apache-2.0입니다.
- 동반 스킬 권장: 사용자가 요청한 설치를 마친 뒤 `ai-slop-thresher`, `kar-plain`, `korean-official-doc`을 한 번 권합니다. 자동으로 설치하지 않습니다.
- HWPX 생성 시 `Gpt_Codex_HWP`처럼 단어 안에 있는 밑줄이 기울임으로 바뀌어 사라지던 문제를 고쳤습니다.
- 경로 보안: Windows 네트워크(UNC) 경로를 허용 루트 없이 거부하고, 파일 시스템에 접근하기 전에 판정합니다. 8.3 짧은 이름과 macOS `/tmp`·`/var`·`/etc` 별칭은 거부하지 않고 실제 경로로 바꿉니다.
- 쓰기 실패 처리: 예약한 출력의 쓰기가 실패하면 쓰기 시작한 파일을 비우고, 출력 경로마다 비워짐·쓰이지 않음·완료·일부 기록 가능 상태를 보고합니다.
- Python: 이미지 helper와 doctor가 PATH를 쓰지 않는 같은 신뢰 경로 목록과 3.10 이상 기준을 씁니다. helper의 실패 코드는 그대로 전달합니다.
- 의존성: @modelcontextprotocol/sdk 1.32.1, proxy-addr 2.0.8 고정, fast-uri 3.1.8, markdown-it 14.3.1, 선택 의존성 @rhwp/core 0.8.7로 갱신했습니다.
- 플러그인 버전은 `0.3.0+codex.20261008150000`이며 v0.2.7 런타임 디렉터리를 재사용하지 않습니다.

## 0.2.x에서 바뀐 동작

- Windows 네트워크(UNC) 경로는 `GPT_CODEX_HWP_ALLOWED_ROOTS`에 그 UNC 루트를 지정해야 쓸 수 있습니다. 지정하지 않으면 매핑된 네트워크 드라이브의 문서는 읽을 수 있지만 그 공유로 결과물을 쓰지 않습니다.
- `after-paragraph` 이미지 삽입은 신뢰 경로의 Python 3.10 이상을 요구합니다. 조건에 맞는 인터프리터가 없으면 `PYTHON_NOT_FOUND`입니다.
- Hancom 레이아웃 캐시가 없는 HWPX(이 플러그인이 만든 문서 포함)를 `reflow` 없이 미리 보면 `ENGINE_CRASH` 대신 `PREVIEW_REFLOW_REQUIRED`를 반환합니다. `reflow: true`로 다시 요청하십시오.
- 쓰기를 시작한 뒤 실패하면 원인의 코드를, 원인에 코드가 없으면 `OUTPUT_WRITE_FAILED`를 반환합니다. 이미지 helper가 원본을 HWPX가 아니라고 보고하면 `SOURCE_HWPX_INVALID`, 그 밖의 helper 실패는 `IMAGE_INSERTION_FAILED`입니다.
- one-shot이 종료 코드 2로 끝날 때 표준 오류는 `ONESHOT_INVOCATION_ERROR reason=<단계>` 형식입니다. 문자열 전체를 정확히 비교하던 호출자는 접두어로 비교하십시오.
- CI 검증 범위는 10 MiB까지입니다. 그보다 큰 문서는 동작할 수 있지만 크기별 검증 근거가 없습니다.

## 릴리즈 검증

- Node.js 22에서 소스와 배포용 잠금 파일의 production npm audit 결과는 각각 알려진 취약점 0건이었습니다.
- 저장소 Node 테스트 474개 중 472개 통과, 환경 제약으로 2개 건너뜀, 실패 0개였습니다. 정책 테스트 54개와 공문서 린터 테스트 10개도 통과했습니다.
- CI에서 소스 테스트 45개 파일이 통과했고, 생성 런타임 검사와 설치 런타임 nine-tool 스모크도 통과했습니다. 로컬 Node 22.17에서는 릴리스 산출물 테스트 한 파일이 zlib 버전 문자열 형식 때문에 실패하며, CI가 고정한 Node 22.22.2에서는 통과합니다.
- PR #23의 Windows x64, macOS arm64, Linux CI와 보안 정책 검사가 통과했습니다. v0.3.0 ZIP, SPDX, provenance, 체크섬은 릴리즈 게이트에서 검증합니다.
- Claude Code 경로는 Windows x64에서 격리된 `CLAUDE_CONFIG_DIR`에 설치해 런타임 설치, doctor, HWPX 생성·검증·읽기·미리보기를 확인했습니다.
- 배포 자산은 불변 태그의 전체 릴리즈 게이트와 attestation이 성공한 동일 실행에서 가져옵니다. 설치 후에는 호스트 재시작과 문서 작업을 확인해야 합니다.

## 사용자 자원 사용 안내

미사용 시 상주 Gpt_Codex_HWP Node 프로세스는 0개입니다. 이번 릴리스로 고정 RSS 또는 설치 크기가 감소했다고 주장하지 않습니다.

## 설치와 업그레이드

v0.3.0 플러그인을 설치한 뒤 installedPath가 경로와 플러그인 identity 규칙에 맞는지 확인하십시오. 그 경로에서 다음 명령으로 운영 의존성을 설치하고 상태를 점검합니다.

    node dist/install-runtime.js --json
    node dist/doctor.js --json

첫 명령은 JSON code RUNTIME_INSTALL_OK를 반환해야 합니다. 실행 중인 모든 Codex CLI와 Desktop 호스트, 또는 Claude Code 세션을 완전히 닫았다가 다시 여십시오. 문서 작업 하나를 실행해 성공했는지 확인하고 생성 결과를 검증한 뒤 one-shot 프로세스와 그 하위 프로세스가 종료되는지 확인하십시오. 문서 작업은 의존성을 자동 설치하지 않습니다. RUNTIME_NOT_INSTALLED가 나오면 확인한 installedPath에서 설치기를 명시적으로 다시 실행하십시오. 검증이 끝날 때까지 기존 작동 버전은 유지하십시오.

운영 의존성은 Codex에서는 $CODEX_HOME/plugin-runtime-data, Claude Code에서는 <CLAUDE_CONFIG_DIR 또는 ~/.claude>/plugin-runtime-data 아래 gpt-codex-hwp/<전체-플러그인-버전>/<platform>-<arch>-node<Node-주버전>에 저장됩니다. 이전 런타임은 해당 버전 디렉터리를 더 이상 사용하지 않는다고 확인한 뒤 수동으로 정리하십시오.

## 호환성과 알려진 제한

- Windows x64에서 개발하고 관련 기능을 검증했습니다. macOS Apple Silicon은 호환 대상이지만 실제 Mac 기기의 Codex Desktop·Claude Code·한컴오피스 한글에서 검증하지 않았습니다.
- HWP 5.x는 읽기 전용이며 생성·편집 결과는 HWPX입니다. HWP 3.x는 실제 fixture가 없어 보장하지 않습니다.
- 10 MiB까지 CI 검증 범위이며 10 MiB 초과 512 MiB 이하는 이론상 지원하지만 검증하지 않습니다. 512 MiB 초과는 거부합니다.
- 단어 안 밑줄을 이스케이프한 문서는 미리보기 텍스트를 맞추려고 Kordoc 생성을 한 번 더 실행하므로 생성 시간이 약 두 배입니다.
- 보호·암호화·서명·DRM 문서는 우회하지 않습니다. 글꼴 파일은 포함·설치·내장하지 않습니다.

## 라이선스와 감사

프로젝트 코드는 Apache-2.0으로 배포합니다. Kordoc, rhwp, hwpx-editing-skill과 기타 제3자 구성 요소는 각 원저작자의 저작권과 라이선스를 따릅니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하십시오.
