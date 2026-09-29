# Gpt_Codex_HWP v0.2.6 릴리즈 후보 노트

- 상태: 릴리즈 후보, 미게시
- 작성일: 2026-09-29
- 검증 기준: Windows x64 로컬 검증, 호스팅 플랫폼 CI 진행 중, 실제 Mac 기기 미검증

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 개요

v0.2.6은 [의존성 감사 이슈 #18](https://github.com/Burntgogi/Gpt_Codex_HWP/issues/18)의 취약 패키지를 갱신하는 후보입니다. v0.2.5의 HWP 읽기 전용·HWPX 쓰기 정책, 내부 one-shot 도구 9개, 명시적 지속 런타임 설치 방식은 유지합니다. 이 후보는 아직 GitHub Release와 배포 자산이 없으므로 공개 설치 안내는 v0.2.5를 가리킵니다.

## 주요 변경 사항

- 직접 의존성 @xmldom/xmldom을 0.9.12, sharp를 0.35.5로 올렸습니다.
- 간접 의존성 fast-uri 3.1.7, hono 4.13.11, qs 6.16.0, ip-address 10.7.2를 소스와 생성 런타임 잠금 파일에 반영했습니다.
- HWPX 글꼴 무결성 검사의 XML 출력에 requireWellFormed: true를 사용합니다. 파서가 읽은 XML 선언은 직렬화 전에 제거하고 UTF-8 선언을 다시 붙여 유효한 문서 출력을 유지합니다.
- 새 0.2.6+codex.20260929182230 플러그인 버전으로 런타임을 분리합니다. v0.2.5 태그와 배포 자산은 변경하지 않습니다.

## 후보 검증

- Node.js 22.22.2/npm 10.9.7에서 소스와 배포용 잠금 파일의 production npm audit가 각각 알려진 취약점 0건을 반환했습니다.
- 저장소 Node 테스트 459개 중 457개가 통과하고 Windows 환경 제약 2개가 건너뛰어졌으며 실패는 0개였습니다. 정책 테스트 53개가 통과했습니다.
- XML·보호·이미지·런타임 관련 집중 테스트 106개 중 104개가 통과하고 환경 제약 2개가 건너뛰어졌습니다. 생성 런타임 검사와 설치 런타임 nine-tool 스모크도 통과했습니다.
- 불변 태그의 전체 릴리즈 게이트, attestation, 공개 설치 후 재시작 검증은 후보 승인 이후에 수행해야 합니다.

## 사용자 자원 사용 안내

미사용 시 상주 Gpt_Codex_HWP Node 프로세스는 0개입니다. 이번 의존성 갱신으로 고정 RSS 또는 설치 크기가 감소했다고 주장하지 않습니다.

## 설치와 업그레이드

공개 후 v0.2.6을 설치할 때는 설치 결과의 installedPath를 경로·플러그인 identity 규칙으로 먼저 검증한 뒤 그 경로에서 실행합니다.

    node dist/install-runtime.js --json
    node dist/doctor.js --json

첫 명령은 JSON code RUNTIME_INSTALL_OK를 반환해야 합니다. 실행 중인 모든 Codex CLI와 Desktop 호스트를 완전히 닫았다가 다시 여십시오. 문서 작업 하나를 실행해 성공했는지 확인하고 생성 결과를 검증한 뒤 one-shot 프로세스와 그 하위 프로세스가 종료되는지 확인하십시오. 문서 작업은 설치를 자동 수행하지 않으므로 RUNTIME_NOT_INSTALLED면 검증한 installedPath에서 설치기를 명시적으로 다시 실행합니다. 검증이 끝나기 전에는 기존 작동 버전을 제거하지 마십시오.

운영 의존성은 $CODEX_HOME/plugin-runtime-data/gpt-codex-hwp/<전체-플러그인-버전>/<platform>-<arch>-node<Node-주버전>에 남습니다. 이전 런타임은 더 이상 사용하지 않는 정확한 버전 디렉터리를 확인한 뒤 수동으로 정리하십시오.

## 호환성과 알려진 제한

- Windows x64에서 개발하고 관련 기능을 검증했습니다. macOS Apple Silicon은 호환 대상이지만 실제 Mac 기기의 Codex Desktop·한컴오피스 한글에서 검증하지 않았습니다.
- HWP 5.x는 읽기 전용이며 생성·편집 결과는 HWPX입니다. HWP 3.x는 실제 fixture가 없어 보장하지 않습니다.
- 100 MiB까지 CI 검증 범위이며 100 MiB 초과 512 MiB 이하는 비보장 best-effort입니다. 512 MiB 초과는 거부합니다.
- 보호·암호화·서명·DRM 문서는 우회하지 않습니다. 글꼴 파일은 포함·설치·내장하지 않습니다.

## 라이선스와 감사

프로젝트 코드는 Apache-2.0으로 배포합니다. Kordoc, rhwp, hwpx-editing-skill과 기타 제3자 구성 요소는 각 원저작자의 저작권과 라이선스를 따릅니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하십시오.
