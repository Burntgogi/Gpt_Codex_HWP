# Gpt_Codex_HWP v0.3.1 릴리즈 노트

- 게시 조건: 불변 태그의 전체 릴리즈 게이트와 attestation이 성공한 자산만 게시
- 준비일: 2026-10-21
- 플러그인 버전: `0.3.1+codex.20261021043114`
- Claude Code 캐시 디렉터리: `0.3.1-codex.20261021043114`

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 보안 패치

v0.3.1은 소스와 생성 런타임의 markdown-it을 14.3.1에서 14.3.3으로 갱신해 [GHSA-gfr2-rv44-r23c](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c), [GHSA-r7fv-28h4-cvq7](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-r7fv-28h4-cvq7), [GHSA-vfgh-jcmw-g37q](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-vfgh-jcmw-g37q)에 대응합니다. 기존 14.x API와 파서 옵션을 유지하며 새 기능, PDF 지원이나 MCP 도구를 추가하지 않습니다.

## 설치와 업그레이드

소유자가 릴리즈를 게시한 뒤에만 README의 `v0.3.1` 태그 고정 설치 명령을 사용하십시오. 직전 공개 릴리즈는 v0.3.0입니다. 플러그인을 다시 설치하고 `version`이 `0.3.1+codex.20261021043114`이며 `installedPath`가 새 캐시 디렉터리인지 확인하십시오(Claude Code에서는 `+`를 `-`로 표기). 새 identity는 이전 런타임을 재사용하지 않으며, 이전 런타임의 의존성만 제자리에서 갱신하는 것은 업그레이드가 아닙니다.

검증한 새 `installedPath`에서 명시적으로 실행하십시오.

    node dist/install-runtime.js --json
    node dist/doctor.js --json

`RUNTIME_INSTALL_OK`와 `DOCTOR_OK`를 확인하십시오. 실행 중인 모든 Codex CLI와 Desktop 호스트, 또는 Claude Code 세션을 완전히 닫았다가 다시 여십시오. 문서 작업 하나를 완료하고 결과를 검증한 뒤 one-shot 프로세스와 하위 프로세스 종료를 확인하십시오. 이 절차가 성공할 때까지 기존에 작동하는 플러그인과 지속 런타임을 유지하고, 성공 후에만 더 이상 쓰지 않는 정확한 버전 디렉터리를 제거하십시오.

## 검증과 게시 경계

아래 v0.3.0 기록은 과거 기록이며 v0.3.1 검증 근거가 아닙니다. v0.3.1의 실제 호스팅 검사·attestation·게시 결과는 GitHub 릴리즈와 연결된 워크플로에서 확인하십시오. 실제 Mac 검증도 미완료입니다. 소유자는 불변 태그의 전체 게이트와 attestation이 성공한 동일 실행의 ZIP·SPDX SBOM·provenance·체크섬만 게시해야 합니다. 로컬 재빌드 결과는 배포 자산으로 사용하지 않습니다.

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
