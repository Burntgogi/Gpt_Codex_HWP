# Gpt_Codex_HWP v0.2.2 릴리즈 노트

- 상태: 배포 전 릴리즈 후보
- 작성일: 2026-07-27
- 검증 플랫폼: Windows x64·macOS arm64 hosted runner·Linux x64·보안 정책; 실제 Mac 기기 미검증

[English](RELEASE_NOTES.en.md) | [README](README.md)

## 개요

v0.2.2는 HWP 읽기 전용·HWPX 쓰기 원칙과 공개 MCP 도구 9개를 유지하면서, 플랫폼 CI와 대용량 문서 검증을 배포 가능한 수준으로 정리한 패치 릴리즈입니다. 형식과 구조가 유효한 문서는 100 MiB까지 CI 검증 지원 범위로 명시하며, 100 MiB 초과 512 MiB 이하는 비보장 best-effort, 512 MiB 초과는 거부합니다.

GitHub hosted Windows와 macOS에서 설치 런타임 스모크가 60초 후 중단되던 원인은 임시 폴더의 표시 경로와 정규 경로가 달랐기 때문입니다. 소유권 검증이 확인한 정규 경로를 MCP 허용 루트와 결과 경로에 그대로 재사용하도록 수정했습니다.

## 주요 변경 사항

- Windows x64, macOS arm64, Linux lifecycle, Security policy를 안정적인 필수 PR 체크로 분리했습니다.
- PR은 10 MiB 스모크를 사용하고, 병합 후 수동·주기 호환성 워크플로는 각 플랫폼에서 100 MiB 증적과 전체 검증을 담당합니다.
- 256·512 MiB 벤치마크는 설계 검사용 로컬 실험으로 유지하며 호환성을 보장하지 않습니다.
- Windows와 macOS의 설치 런타임 스모크가 runner 경로 별칭을 허용하되, 검증된 정규 임시 루트만 실제 허용 경계로 사용합니다.
- 초기화 실패 진단은 허용 목록의 마지막 생명주기 경계와 제한된 stderr 바이트 수만 기록합니다. 원시 오류, 사용자 경로, PID와 문서 내용은 출력하지 않습니다.
- 프로세스 시작 게이트, 감독자 준비, 종료 영수증과 잔존 자식 검증은 계속 fail-closed로 동작합니다.
- 중복된 전체 테스트를 PR에서 제거하고, 전체 플랫폼 영수증과 100 MiB 증적은 Compatibility 및 불변 릴리즈 검증 단계가 소유합니다.
- 릴리즈 100 MiB 사전 검증이 실패하면 제한된 진단만 실행하고 배포물 생성과 attestation은 중단합니다.
- HWP는 감지·읽기·미리보기 전용이며, 생성·편집 결과는 계속 HWPX로만 저장합니다.

## 공개 도구

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## 현재 검증 증거

- [PR #5 필수 CI 실행 30248171415](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/30248171415): Windows x64, macOS arm64, Linux lifecycle 통과. macOS의 기존 `bp16` hosted 스케줄링 변동은 동일 runner 격리 진단과 한 번의 실패 작업 재실행에서 통과했습니다.
- [PR #5 보안 실행 30248171437](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/30248171437): 공개 트리, 전체 도달 가능 Git 객체·작성자 신원, 운영 의존성, 런타임 투영과 정책 검사 통과.
- 최종 후보 로컬 검증: 저장소 Node 421개 중 420개 통과·capability skip 1개·실패 0개, 소스 전체 41파일 통과·deferred 0개, Python 20/20, 실제 설치 런타임 9도구·SVG/PNG 스모크 통과.
- 소스 및 공개 런타임 `npm audit --omit=dev`: 알려진 취약점 0개.
- 원격 저장소 정책: 보호된 main, 불변 태그와 작성자 전용 쓰기 정책에 대해 `compliant`.

새 `Compatibility` 워크플로는 이 PR에서 추가되므로 GitHub 규칙상 기본 브랜치 병합 전에는 수동 실행할 수 없습니다. 릴리즈 전 필수 잔여 관문은 병합된 정확한 커밋에서 Windows x64·macOS arm64·Linux x64의 전체 호환성과 100 MiB 증적을 통과하고, 이후 불변 `v0.2.2` 태그에 대해 릴리즈 후보 검증·배포물 검사·attestation을 통과하는 것입니다.

## 설치와 업그레이드

정식 게시 후 움직이는 `main` 대신 불변 `v0.2.2` 태그를 지정하십시오. 설치 결과의 `installedPath`와 플러그인 ID를 검증한 뒤 해당 경로에서 다음 명령을 실행합니다.

```powershell
npm ci --omit=dev --ignore-scripts
npm audit --omit=dev
```

Codex를 재시작하거나 새 작업을 열어 정확히 9개 도구를 확인하십시오. 새 설치 검증이 끝나기 전에는 기존에 작동하는 플러그인을 제거하지 마십시오.

## 호환성과 알려진 제한

- Windows x64에서 제작하고 실제 문서 기능을 검증했습니다.
- macOS Apple Silicon은 hosted runner 호환성 대상이지만 실제 Mac 기기의 Codex Desktop·한컴오피스 한글에서 검증하지 않았습니다.
- HWP 5.x는 읽기 전용이며 HWP 3.x는 실제 fixture가 없어 지원을 보장하지 않습니다.
- 글꼴 파일은 포함·설치·내장하지 않습니다. 표시와 줄바꿈은 문서를 여는 시스템 글꼴에 따라 달라질 수 있습니다.
- 보호, 암호화, 서명, DRM 문서는 우회하지 않고 거부합니다.
- 인라인 Markdown은 64,000자, 파생 Markdown은 256 MiB, 직렬화된 MCP 결과는 8 MiB로 제한합니다.
- Kordoc의 100 MiB 압축 해제량과 HWPX 500개 항목 제한 등 더 엄격한 엔진 정책이 먼저 적용될 수 있습니다.

## 라이선스와 감사

프로젝트 코드는 Apache-2.0으로 배포됩니다. Kordoc, rhwp, hwpx-editing-skill 및 기타 제3자 구성 요소는 각 원저작자의 저작권과 라이선스를 따릅니다. 정확한 버전, 사용 범위와 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하십시오.

이 문서는 `v0.2.2` 배포 전 후보 노트입니다. 호환성·불변 태그 검증과 실제 GitHub Release 게시 전에는 `v0.2.1`이 최신 공개 릴리즈입니다.
