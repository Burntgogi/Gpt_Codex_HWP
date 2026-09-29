# Gpt_Codex_HWP v0.2.6 릴리즈 노트

- 상태: 정식 릴리즈
- 작성일: 2026-09-29
- 검증 기준: Windows x64 로컬 검증, Windows x64·macOS arm64·Linux 호스팅 CI 통과, 실제 Mac 기기 미검증

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 개요

v0.2.6은 [의존성 감사 이슈 #18](https://github.com/Burntgogi/Gpt_Codex_HWP/issues/18)에 보고된 패키지를 갱신한 릴리스입니다. HWP 읽기 전용과 HWPX 쓰기 정책, 내부 one-shot 도구 9개, 런타임을 명시적으로 설치하는 절차는 v0.2.5와 같습니다.

## 주요 변경 사항

- 직접 의존성 @xmldom/xmldom을 0.9.12, sharp를 0.35.5로 올렸습니다.
- 간접 의존성 fast-uri 3.1.7, hono 4.13.11, qs 6.16.0, ip-address 10.7.2를 소스와 생성 런타임 잠금 파일에 반영했습니다.
- HWPX 글꼴 무결성 검사의 XML 직렬화에 `requireWellFormed: true`를 적용했습니다. 파싱한 XML 선언을 제거한 뒤 UTF-8 선언을 다시 붙여 유효한 문서를 출력합니다.
- 의존성 감사 보고가 패키지의 모든 advisory를 표시하도록 고쳤습니다. 소스와 배포용 잠금 파일에 같은 advisory가 있거나 수정 권고가 여러 형태로 제시돼도 중복 행을 만들지 않습니다.
- 플러그인 버전을 0.2.6+codex.20260929182230으로 올려 런타임을 분리했습니다. v0.2.5 태그와 배포 자산은 변경하지 않았습니다.

## 릴리즈 검증

- Node.js 22.22.2와 npm 10.9.7에서 소스와 배포용 잠금 파일의 production npm audit 결과는 각각 알려진 취약점 0건이었습니다.
- 저장소 Node 테스트는 459개 중 457개 통과, Windows 환경 제약으로 2개 건너뜀, 실패 0개였습니다. 정책 테스트 53개도 통과했습니다.
- XML·보호·이미지·런타임 집중 테스트는 106개 중 104개 통과, 환경 제약으로 2개 건너뜀입니다. 생성 런타임 검사와 설치 런타임 nine-tool 스모크도 통과했습니다.
- PR #19와 후속 PR #20의 Windows x64, macOS arm64, Linux CI 및 보안 정책 검사가 통과했습니다. v0.2.6 ZIP, SPDX, provenance, 체크섬도 로컬에서 독립 검증했습니다.
- 배포 자산은 불변 태그의 전체 릴리즈 게이트와 attestation이 성공한 동일 실행에서 가져옵니다. 설치 후에는 호스트 재시작과 문서 작업을 확인해야 합니다.

## 사용자 자원 사용 안내

미사용 시 상주 Gpt_Codex_HWP Node 프로세스는 0개입니다. 이번 의존성 갱신으로 고정 RSS 또는 설치 크기가 감소했다고 주장하지 않습니다.

## 설치와 업그레이드

v0.2.6 플러그인을 설치한 뒤 installedPath가 경로와 플러그인 identity 규칙에 맞는지 확인하십시오. 그 경로에서 다음 명령으로 운영 의존성을 설치하고 상태를 점검합니다.

    node dist/install-runtime.js --json
    node dist/doctor.js --json

첫 명령은 JSON code RUNTIME_INSTALL_OK를 반환해야 합니다. 실행 중인 모든 Codex CLI와 Desktop 호스트를 완전히 닫았다가 다시 여십시오. 문서 작업 하나를 실행해 성공했는지 확인하고 생성 결과를 검증한 뒤 one-shot 프로세스와 그 하위 프로세스가 종료되는지 확인하십시오. 문서 작업은 의존성을 자동 설치하지 않습니다. RUNTIME_NOT_INSTALLED가 나오면 확인한 installedPath에서 설치기를 명시적으로 다시 실행하십시오. 검증이 끝날 때까지 기존 작동 버전은 유지하십시오.

운영 의존성은 $CODEX_HOME/plugin-runtime-data/gpt-codex-hwp/<전체-플러그인-버전>/<platform>-<arch>-node<Node-주버전>에 저장됩니다. 이전 런타임은 해당 버전 디렉터리를 더 이상 사용하지 않는다고 확인한 뒤 수동으로 정리하십시오.

## 호환성과 알려진 제한

- Windows x64에서 개발하고 관련 기능을 검증했습니다. macOS Apple Silicon은 호환 대상이지만 실제 Mac 기기의 Codex Desktop·한컴오피스 한글에서 검증하지 않았습니다.
- HWP 5.x는 읽기 전용이며 생성·편집 결과는 HWPX입니다. HWP 3.x는 실제 fixture가 없어 보장하지 않습니다.
- 100 MiB까지 CI 검증 범위이며 100 MiB 초과 512 MiB 이하는 비보장 best-effort입니다. 512 MiB 초과는 거부합니다.
- 보호·암호화·서명·DRM 문서는 우회하지 않습니다. 글꼴 파일은 포함·설치·내장하지 않습니다.

## 라이선스와 감사

프로젝트 코드는 Apache-2.0으로 배포합니다. Kordoc, rhwp, hwpx-editing-skill과 기타 제3자 구성 요소는 각 원저작자의 저작권과 라이선스를 따릅니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하십시오.
