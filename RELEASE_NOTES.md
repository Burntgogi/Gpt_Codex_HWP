# Gpt_Codex_HWP v0.2.1 릴리즈 노트

- 상태: 정식 릴리즈
- 작성일: 2026-07-22
- 검증 플랫폼: Windows x64·macOS arm64·Linux·보안 릴리즈 게이트; 실제 Mac 기기 미검증

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 개요

v0.2.1은 HWP를 안전한 읽기 전용 입력 형식으로 사용하고 모든 새 문서와 편집 결과를 HWPX로 작성합니다. 공개 런타임은 문서 처리에 필요한 Kordoc Core만 포함하며 PDF, OCR, ONNX 및 수식 엔진 선택 의존성은 제외합니다. 공개 도구 수는 기존 설계대로 9개를 유지합니다. 이 릴리즈는 공개 트리와 Git 이력 검사, 최소 권한 CI, 재현 가능한 ZIP·SBOM·provenance 검증과 증명 게이트를 추가합니다. `v0.2.0` 후보는 GitHub Release 게시 전에 새 보안 권고를 확인해 철회했으며, 수정판인 `v0.2.1`이 실제 공개 릴리즈입니다.

## 주요 변경 사항

- 바이너리 HWP는 형식 감지, 읽기, 미리보기만 허용하고 직접 생성·수정·저장은 `HWP_READ_ONLY`로 거부합니다.
- MCP SDK가 사용하는 `@hono/node-server`를 경로 순회 취약점이 수정된 2.0.11로 정확히 고정하고, 소스와 컴팩트 런타임 감사에서 알려진 운영 취약점 0건을 확인합니다.
- 릴리즈 증명 워크플로는 검증된 Windows x64에서 대용량 문서 증적과 배포물을 만들며, 불변 태그·정확한 커밋 SHA·버전을 명시 입력받아 서로 일치하지 않으면 중단합니다.
- Markdown 기반 HWPX 생성, 구조 보존 패치, 양식 채우기, 이미지 삽입, 검증과 SVG 미리보기를 지원합니다.
- 512 MiB 원본 파일 외곽 상한과 64,000자 인라인 Markdown 정책을 유지합니다. 큰 결과는 원본을 한 번만 파싱해 새 UTF-8 Markdown 파일로 저장한 뒤 분할해 읽습니다.
- Kordoc 3.18.1 공식 npm 아카이브를 고정 SHA-512로 인증하고, 런타임에 필요하지 않은 소스맵과 선택 의존성을 제거했습니다.
- 설치된 의존성 트리에서 PDF·OCR·ONNX·수식 엔진 패키지를 최상위와 중첩 경로 모두에서 차단합니다.
- 두 배포 빌더에 개인정보 경로, 개인키, 실제 자격증명 할당, `.env`, 소스맵, 테스트 문서와 사용자 문서 차단 검사를 적용했습니다.
- 자격증명 검사에서 `AWS_SECRET_ACCESS_KEY`를 포함한 cloud secret key 이름을 차단하며, 스킬 메타데이터가 참조하는 아이콘 2개도 공개 런타임에 명시적으로 포함합니다.
- 공개 런타임의 Kordoc provenance, `npm ls`, `npm audit`, 크기 예산, MCP stderr와 9개 도구 스모크를 자동 검증합니다.
- 과거 생성형 `release/**` 트리는 공개 소스에서 제거하고 로컬 백업에만 보존합니다.
- README 인트로를 기존 픽셀아트 배너, 상태 배지, 빠른 탐색 링크와 실제 생성 HWPX 미리보기 중심으로 개편했습니다.
- README 예시 HWPX는 개인정보 없는 합성 Markdown으로 생성했으며 1쪽, 표 1개, 구조 검증 문제 0개, 미리보기 경고 0개를 확인했습니다.
- 새 HWPX 결과 PNG는 공개 콘텐츠 정책에 크기와 SHA-256을 고정해 승인되지 않은 바이너리 교체를 차단합니다. 기존 타이틀 배너도 종전의 고정 정책을 그대로 적용합니다.

## README 디자인 참고

2026-07-22 GitHub 저장소 검색에는 스타 100만 개 이상인 저장소가 없었으므로, 실제 스타 상위 5개 저장소의 인트로 패턴을 검토했습니다. 원본 문구나 이미지는 복사하지 않았습니다.

- [codecrafters-io/build-your-own-x](https://github.com/codecrafters-io/build-your-own-x): 첫 화면을 지배하는 가로형 배너
- [sindresorhus/awesome](https://github.com/sindresorhus/awesome): 중앙 정렬 브랜드 정체성과 짧은 탐색 링크
- [freeCodeCamp/freeCodeCamp](https://github.com/freeCodeCamp/freeCodeCamp): 신뢰 상태를 빠르게 보여 주는 배지
- [public-apis/public-apis](https://github.com/public-apis/public-apis): 목적과 사용 경로를 앞부분에서 바로 제시하는 구성
- [EbookFoundation/free-programming-books](https://github.com/EbookFoundation/free-programming-books): 언어·라이선스·기여 경로를 명확히 나누는 정보 구조

## 공개 도구

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## 검증 결과

릴리즈 정책은 태그가 가리키는 정확한 커밋에서 Windows x64, macOS arm64, Linux와 보안 필수 검사를 모두 통과하도록 요구합니다. 다음 실행은 릴리즈 전 강화 기준선의 통과 기록이며, 최종 태그는 현재 릴리즈 커밋의 필수 검사가 통과한 뒤에만 게시합니다.

- [v0.2.1 CI 실행 29861590295](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/29861590295): Windows x64 전체 배포 게이트와 플랫폼 영수증, macOS arm64 전체 배포 게이트와 플랫폼 영수증, Linux lifecycle 검사 통과
- [v0.2.1 보안 실행 29861590517](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/29861590517): 공개 트리와 전체 도달 가능 Git 객체/신원 검사, source/runtime production audit, 런타임 투영, 배포물 빌드·검증 통과
- 공식 Kordoc 재생성, 대용량 문서 증적, 실제 HWP 읽기 전용 스모크, 9개 MCP 도구 스모크와 배포물 무결성 검사가 각 플랫폼의 전체 배포 게이트에 포함됨
- macOS arm64 호스티드 러너 검사는 통과했지만 실제 Mac 기기의 Codex Desktop·한컴오피스 한글 사용은 아직 검증하지 않음

## 설치와 업그레이드

설치할 때는 움직이는 `main` 대신 불변 `v0.2.1` 태그를 지정하십시오. 설치 결과의 `installedPath`와 플러그인 ID를 검증한 뒤 해당 경로에서 다음 명령을 실행합니다.

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

이 문서는 `v0.2.1` 정식 릴리즈 노트입니다. 설치에는 움직이는 `main`이 아니라 불변 `v0.2.1` 태그를 사용하십시오.
