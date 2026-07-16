# Gpt_Codex_HWP v0.2.0 릴리즈 후보 노트

- 상태: 릴리즈 후보(미배포)
- 작성일: 2026-07-16
- 검증 플랫폼: Windows x64 로컬 검증 진행 중; macOS 실제 기기 미검증

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 개요

v0.2.0은 HWP를 안전한 읽기 전용 입력 형식으로 사용하고 모든 새 문서와 편집 결과를 HWPX로 작성하는 미배포 릴리즈 후보입니다. 공개 런타임은 문서 처리에 필요한 Kordoc Core만 포함하며 PDF, OCR, ONNX 및 수식 엔진 선택 의존성은 제외합니다. 공개 도구 수는 기존 설계대로 9개를 유지합니다. 이 후보는 공개 트리와 Git 이력 검사, 최소 권한 CI, 재현 가능한 ZIP·SBOM·provenance 검증과 증명 게이트를 추가하며 자동으로 태그나 릴리즈를 만들지 않습니다.

## 주요 변경 사항

- 바이너리 HWP는 형식 감지, 읽기, 미리보기만 허용하고 직접 생성·수정·저장은 `HWP_READ_ONLY`로 거부합니다.
- Markdown 기반 HWPX 생성, 구조 보존 패치, 양식 채우기, 이미지 삽입, 검증과 SVG 미리보기를 지원합니다.
- 512 MiB 원본 파일 외곽 상한과 64,000자 인라인 Markdown 정책을 유지합니다. 큰 결과는 원본을 한 번만 파싱해 새 UTF-8 Markdown 파일로 저장한 뒤 분할해 읽습니다.
- Kordoc 3.18.1 공식 npm 아카이브를 고정 SHA-512로 인증하고, 런타임에 필요하지 않은 소스맵과 선택 의존성을 제거했습니다.
- 설치된 의존성 트리에서 PDF·OCR·ONNX·수식 엔진 패키지를 최상위와 중첩 경로 모두에서 차단합니다.
- 두 배포 빌더에 개인정보 경로, 개인키, 실제 자격증명 할당, `.env`, 소스맵, 테스트 문서와 사용자 문서 차단 검사를 적용했습니다.
- 자격증명 검사에서 `AWS_SECRET_ACCESS_KEY`를 포함한 cloud secret key 이름을 차단하며, 스킬 메타데이터가 참조하는 아이콘 2개도 공개 런타임에 명시적으로 포함합니다.
- 공개 런타임의 Kordoc provenance, `npm ls`, `npm audit`, 크기 예산, MCP stderr와 9개 도구 스모크를 자동 검증합니다.
- 과거 생성형 `release/**` 트리는 공개 소스에서 제거하고 로컬 백업에만 보존합니다.

## 공개 도구

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## 검증 결과

아래 수치는 직전 v0.1.4 기준선이며 v0.2.0 exact-head 최종 영수증이 아닙니다. v0.2.0은 `Windows x64`, `macOS arm64`, `Security policy` 원격 검사와 전체 로컬 배포 검증을 모두 마치기 전까지 후보 상태를 유지합니다.

- Node 테스트: 334개 중 330개 통과, 플랫폼·권한 관련 예상 스킵 4개, 실패 0개
- Python 안전 편집 테스트: 16/16 통과
- production `npm audit`: 알려진 취약점 0개
- 공식 Kordoc 재생성: provenance 포함 41개 파일 바이트 일치
- 실제 HWP 읽기 전용 스모크와 9개 MCP 도구 스모크 통과, stderr 0바이트
- legacy/public 배포물의 패킹, 개인정보 검사, `npm ci --omit=dev --ignore-scripts`, `npm ls` 통과
- 배너·아이콘 포함 패키지 압축 크기 약 3.1 MiB, Windows x64 production 설치 크기 약 50 MB

## 설치와 업그레이드

후보 검증이 끝나고 소유자가 GitHub 릴리즈를 게시한 뒤에만 움직이는 `main` 대신 불변 `v0.2.0` 태그를 지정하십시오. 설치 결과의 `installedPath`와 플러그인 ID를 검증한 뒤 해당 경로에서 다음 명령을 실행합니다.

```powershell
npm ci --omit=dev --ignore-scripts
npm audit --omit=dev
```

Codex를 재시작하거나 새 작업을 열어 정확히 9개 도구를 확인하십시오. 새 설치 검증이 끝나기 전에는 기존에 작동하는 플러그인을 제거하지 마십시오. 자세한 에이전트 설치 순서는 [README의 GitHub 설치 절](README.md#에이전트를-통한-github-설치)을 따릅니다.

## 호환성과 알려진 제한

- Windows x64에서 제작·검증했습니다.
- macOS Apple Silicon은 호환 대상이지만 실제 Mac 기기에서 검증하지 않았습니다.
- HWP 5.x는 읽기 전용이며, HWP 3.x는 실제 fixture 검증이 없어 지원을 보장하지 않습니다.
- 글꼴 파일은 포함·설치·내장하지 않습니다. 표시와 줄바꿈은 문서를 여는 시스템 글꼴에 따라 달라질 수 있습니다.
- 보호, 암호화, 서명, DRM 문서는 우회하지 않고 거부합니다.
- Kordoc의 100 MiB 압축 해제량과 HWPX 500개 항목 제한 등 엔진 한도가 512 MiB 외곽 상한보다 먼저 적용될 수 있습니다.

## 라이선스와 감사

프로젝트 코드는 Apache-2.0으로 배포됩니다. Kordoc, rhwp, hwpx-editing-skill 및 기타 제3자 구성 요소는 각 원저작자의 저작권과 라이선스를 따릅니다. 정확한 버전, 사용 범위와 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하십시오.

이 문서는 미배포 `v0.2.0` 릴리즈 후보 노트입니다. 후보 검증이 끝나고 소유자가 불변 `v0.2.0` 태그와 릴리즈를 게시하기 전에는 설치 대상으로 사용하지 마십시오. 현재 게시된 설치에는 움직이는 `main`이 아니라 기존 불변 태그를 사용하십시오.
