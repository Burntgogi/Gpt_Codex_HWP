/** kordoc 공통 타입 정의 */
interface CellContext {
    text: string;
    colSpan: number;
    rowSpan: number;
    /** HWP5 셀 열 주소 (0-based) — 병합 테이블 배치용 */
    colAddr?: number;
    /** HWP5 셀 행 주소 (0-based) — 병합 테이블 배치용 */
    rowAddr?: number;
}
/** 블록 타입 — v2.0에서 heading, list, image, separator 추가 */
type IRBlockType = "paragraph" | "table" | "heading" | "list" | "image" | "separator";
interface IRBlock {
    type: IRBlockType;
    text?: string;
    table?: IRTable;
    /** 헤딩 레벨 (1-6), type="heading"일 때 사용 */
    level?: number;
    /** 원본 페이지 번호 (1-based) */
    pageNumber?: number;
    /** 바운딩 박스 — PDF에서만 제공 */
    bbox?: BoundingBox;
    /** 텍스트 스타일 정보 (선택) */
    style?: InlineStyle;
    /** 리스트 타입, type="list"일 때 사용 */
    listType?: "ordered" | "unordered";
    /** 중첩 리스트 아이템 */
    children?: IRBlock[];
    /** 하이퍼링크 URL */
    href?: string;
    /** 각주/미주 텍스트 (인라인 삽입용) */
    footnoteText?: string;
    /** 이미지 데이터 (type="image"일 때) */
    imageData?: ImageData;
}
/** 추출된 이미지 바이너리 데이터 */
interface ImageData {
    /** 이미지 바이너리 */
    data: Uint8Array;
    /** MIME 타입 (image/png, image/jpeg, image/gif, image/bmp, image/wmf, image/emf) */
    mimeType: string;
    /** 원본 파일명 (있는 경우) */
    filename?: string;
}
/** 바운딩 박스 — PDF 포인트 단위 (72pt = 1인치) */
interface BoundingBox {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}
/** 인라인 텍스트 스타일 */
interface InlineStyle {
    bold?: boolean;
    italic?: boolean;
    fontSize?: number;
    fontName?: string;
}
interface IRTable {
    rows: number;
    cols: number;
    cells: IRCell[][];
    /** 첫 행을 헤더로 렌더링할지 여부 (현재: rows > 1이면 true — 의미적 감지가 아닌 레이아웃 힌트) */
    hasHeader: boolean;
    /** 표 캡션 (예: "표 1. 부서별 예산") — v3.0 */
    caption?: string;
}
interface IRCell {
    text: string;
    colSpan: number;
    rowSpan: number;
    /**
     * 셀 내부 블록 콘텐츠 — v3.0.
     * 중첩 표·이미지·다중 문단을 구조 그대로 보존한다.
     * blocks가 있으면 text는 blocks의 평탄화 텍스트(하위 호환용)다.
     */
    blocks?: IRBlock[];
    /** 제목 셀 여부 (HWP5 width_ref bit2 / HWPX header 속성) — v3.0 */
    isHeader?: boolean;
}
/** 문서 메타데이터 — 각 포맷에서 추출 가능한 필드만 채워짐 */
interface DocumentMetadata {
    /** 문서 제목 */
    title?: string;
    /** 작성자 */
    author?: string;
    /** 작성 프로그램 (예: "한글 2020", "Adobe Acrobat") */
    creator?: string;
    /** 생성일시 (ISO 8601) */
    createdAt?: string;
    /** 수정일시 (ISO 8601) */
    modifiedAt?: string;
    /** 페이지/섹션 수 */
    pageCount?: number;
    /** 문서 포맷 버전 (예: HWP "5.1.0.1") */
    version?: string;
    /** 설명 */
    description?: string;
    /** 키워드 */
    keywords?: string[];
}
/** 파싱 옵션 — parse() 함수에 전달 */
interface ParseOptions {
    /**
     * 파싱할 페이지/섹션 범위 (1-based).
     * - 배열: [1, 2, 3]
     * - 문자열: "1-3", "1,3,5-7"
     *
     * PDF: 정확한 페이지 단위. HWP/HWPX: 섹션 단위 근사치.
     */
    pages?: number[] | string;
    /** 이미지 기반 PDF용 OCR 프로바이더 (선택) */
    ocr?: OcrProvider;
    /** 진행률 콜백 — current: 현재 페이지/섹션, total: 전체 수 */
    onProgress?: (current: number, total: number) => void;
    /** PDF 머리글/바닥글 자동 제거 */
    removeHeaderFooter?: boolean;
    /** 원본 파일 경로 (DRM COM fallback에 필요, 내부 전용) */
    filePath?: string;
    /**
     * PDF 수식 OCR 활성화 (기본 false).
     *
     * 활성화 시 각 PDF 페이지를 이미지로 렌더링 → YOLOv8 기반 수식 영역 검출 →
     * TrOCR 기반 LaTeX 인식. 감지된 수식은 `$...$` (inline) / `$$...$$` (display) 로
     * 블록 텍스트에 삽입된다.
     *
     * 필수 optional 의존성: `onnxruntime-node`, `@huggingface/transformers`,
     * `@hyzyla/pdfium`, `sharp`. 미설치 시 parse 에 실패하지 않고 **경고만** 남기고
     * 수식 인식은 skip 한다 (일반 텍스트 추출은 정상 동작).
     *
     * 모델(~155MB) 은 첫 사용 시 HuggingFace 에서 자동 다운로드 되어
     * `~/.cache/kordoc/models/pix2text/` 에 SHA-256 검증과 함께 저장된다.
     */
    formulaOcr?: boolean;
    /**
     * 레이아웃 표 페이지 반복 헤더(러닝 헤더) 정리 휴리스틱 활성화 (기본 false).
     *
     * 구형 HWP5 문서가 페이지마다 재삽입한 짧은 번호매김 러닝 헤더
     * ("2. 과제 구축 내용")를 최초 1회만 남기고 이후 중복을 제거한다.
     * 다만 페이지 위치 정보가 없는 HWP5 특성상 이 휴리스틱은 정당하게 반복되는
     * 번호매김 문단(예: 붙임/별지별 재번호 "1. 목적")도 삭제할 수 있어 opt-in 으로
     * 둔다. 활성 시 제거가 발생하면 HIDDEN_TEXT_FILTERED 경고를 남긴다.
     */
    dedupeRunningHeaders?: boolean;
    /**
     * 추출된 이미지를 마크다운에 base64 data URI 로 인라인 (기본 false).
     *
     * 활성화 시 `![image](image_001.bmp)` 참조를 `![image](data:image/png;base64,...)` 로
     * 치환한다. 임베드된 BMP 는 PNG 로 무손실 압축 후 인라인하여 용량을 크게 줄인다.
     * 별도 이미지 파일 없이 자체 완결형 마크다운이 되어 MCP/AI 에이전트 소비에 적합하다.
     * (현재 HWP5 경로 지원)
     */
    inlineImages?: boolean;
}
/** 파싱 중 스킵/실패한 요소 보고 */
interface ParseWarning {
    /** 관련 페이지 번호 (알 수 있는 경우) */
    page?: number;
    /** 경고 메시지 */
    message: string;
    /** 구조화된 경고 코드 */
    code: WarningCode;
}
type WarningCode = "SKIPPED_IMAGE" | "SKIPPED_OLE" | "TRUNCATED_TABLE" | "OCR_FALLBACK" | "UNSUPPORTED_ELEMENT" | "BROKEN_ZIP_RECOVERY" | "HIDDEN_TEXT_FILTERED" | "MALFORMED_XML" | "PARTIAL_PARSE" | "LENIENT_CFB_RECOVERY" | "NEEDS_OCR";
/** 문서 구조 (헤딩 트리) */
interface OutlineItem {
    level: number;
    text: string;
    pageNumber?: number;
}
/** 구조화된 에러 코드 — 프로그래밍적 에러 핸들링용 */
type ErrorCode = "EMPTY_INPUT" | "UNSUPPORTED_FORMAT" | "ENCRYPTED" | "DRM_PROTECTED" | "CORRUPTED" | "DECOMPRESSION_BOMB" | "ZIP_BOMB" | "IMAGE_BASED_PDF" | "NO_SECTIONS" | "PARSE_ERROR" | "MISSING_DEPENDENCY";
type FileType = "hwpx" | "hwp" | "hwp3" | "hwpml" | "pdf" | "xlsx" | "xls" | "docx" | "unknown";
interface ParseResultBase {
    fileType: FileType;
    /** 페이지/섹션 수 — PDF: 실제 페이지 수, HWP/HWPX: 섹션 수, XLSX: 시트 수 */
    pageCount?: number;
    /** 이미지 기반 PDF 여부 (텍스트 추출 불가) */
    isImageBased?: boolean;
}
interface ParseSuccess extends ParseResultBase {
    success: true;
    /** 추출된 마크다운 텍스트 */
    markdown: string;
    /** 중간 표현 블록 (구조화된 데이터 접근용) */
    blocks: IRBlock[];
    /** 문서 메타데이터 */
    metadata?: DocumentMetadata;
    /** 문서 구조 (헤딩 트리) — v2.0 */
    outline?: OutlineItem[];
    /** 파싱 중 발생한 경고 — v2.0 */
    warnings?: ParseWarning[];
    /** 추출된 이미지 목록 — 마크다운에서 파일명으로 참조됨 */
    images?: ExtractedImage[];
    /** 페이지별 텍스트 품질 신호 — PDF에서만 제공 */
    pageQuality?: PageQuality[];
    /** 문서 단위 품질 요약 — PDF에서만 제공 */
    qualitySummary?: DocumentQualitySummary;
}
/** 페이지별 텍스트 품질 신호 (PDF 전용). 자세한 설명은 src/pdf/quality.ts */
interface PageQuality {
    page: number;
    textChars: number;
    hangulRatio: number;
    controlCharRatio: number;
    replacementCharRatio: number;
    puaRatio: number;
    needsOcr: boolean;
    ocrReason?: "low_text" | "high_pua" | "high_control" | "high_replacement";
}
/** 문서 단위 품질 요약 (PDF 전용). */
interface DocumentQualitySummary {
    totalPages: number;
    totalTextChars: number;
    avgHangulRatio: number;
    avgControlCharRatio: number;
    avgReplacementCharRatio: number;
    avgPuaRatio: number;
    lowTextPageCount: number;
    highPuaPageCount: number;
    needsOcr: boolean;
    ocrCandidatePages: number[];
}
/** 추출된 이미지 — ParseSuccess.images에 포함 */
interface ExtractedImage {
    /** 마크다운에서 참조되는 파일명 (예: image_001.png) */
    filename: string;
    /** 이미지 바이너리 */
    data: Uint8Array;
    /** MIME 타입 */
    mimeType: string;
}
interface ParseFailure extends ParseResultBase {
    success: false;
    /** 오류 메시지 */
    error: string;
    /** 구조화된 에러 코드 */
    code?: ErrorCode;
}
type ParseResult = ParseSuccess | ParseFailure;
type DiffChangeType = "added" | "removed" | "modified" | "unchanged";
interface BlockDiff {
    type: DiffChangeType;
    /** 원본 블록 (added이면 undefined) */
    before?: IRBlock;
    /** 변경 후 블록 (removed이면 undefined) */
    after?: IRBlock;
    /** modified 테이블의 셀 단위 diff */
    cellDiffs?: CellDiff[][];
    /** 유사도 (0-1) */
    similarity?: number;
}
interface CellDiff {
    type: DiffChangeType;
    before?: string;
    after?: string;
}
interface DiffResult {
    stats: {
        added: number;
        removed: number;
        modified: number;
        unchanged: number;
    };
    diffs: BlockDiff[];
}
/** 패치 중 매핑 실패/미지원으로 건너뛴 항목 — silent 실패 금지 */
interface PatchSkip {
    /** 건너뛴 사유 */
    reason: string;
    /** 원본 쪽 내용 요약 (최대 80자) */
    before?: string;
    /** 편집 쪽 내용 요약 (최대 80자) */
    after?: string;
    /**
     * 부분 적용 표시 — 변경이 적용은 됐지만(applied 계상) 편집 원형 그대로는
     * 아님 (예: 셀 내 줄 추가를 마지막 문단에 병합). 완전 미적용 skip과 구분.
     */
    partial?: boolean;
}
/** patchHwpx 옵션 */
interface PatchOptions {
    /** 패치 후 재파싱 자동 검증 (기본 true) */
    verify?: boolean;
}
/** patchHwpx / patchBlocks 결과 */
interface PatchResult {
    success: boolean;
    /** 패치된 HWPX (success=true) */
    data?: Uint8Array;
    /** 적용된 변경 수 */
    applied: number;
    /** 매핑 실패 항목 (이유 포함) */
    skipped: PatchSkip[];
    /**
     * 무손실 검증 (patchHwpx/patchHwp 전용): 패치본 재파싱 vs 편집 마크다운의
     * 잔차 diff — modified/added/removed가 0이어야 의도가 전부 반영된 것.
     * session.patchBlocks는 이 필드를 채우지 않는다 (changes 참조).
     */
    verification?: DiffResult;
    /**
     * 변경 가시화 (session.patchBlocks 전용): 패치 전 → 후 문서 diff —
     * 적용된 편집 수만큼 modified가 나오는 것이 정상. verification과 의미가
     * 정반대이므로 혼용 금지.
     */
    changes?: DiffResult;
    /** 실패 사유 (success=false) */
    error?: string;
}
interface FormField {
    label: string;
    value: string;
    /** 0-based 소스 행 */
    row: number;
    /** 0-based 소스 열 */
    col: number;
    /** 매칭된 입력 키(정규화) — 모호 라벨 거부 가드(fillWithUniqueGuard)의 집계 기준 */
    key?: string;
}
interface FormResult {
    fields: FormField[];
    /** 양식 확신도 (0-1) */
    confidence: number;
}
/** 사용자 제공 OCR 함수 — 페이지 이미지를 받아 텍스트 반환 */
type OcrProvider = (pageImage: Uint8Array, pageNumber: number, mimeType: "image/png") => Promise<string>;
interface WatchOptions {
    dir: string;
    outDir?: string;
    webhook?: string;
    format?: "markdown" | "json";
    pages?: string;
    silent?: boolean;
}

/** 양식 필드 매칭 공용 유틸 — filler.ts, filler-hwpx.ts에서 공유 */
/**
 * 채울 값 — 문자열이면 같은 라벨 모든 등장에 동일값(단일 양식),
 * 배열이면 등장 순서대로 하나씩 소진(2~30장 반복 양식·명부형 표).
 */
type FillValue = string | string[];
/**
 * 채울 값 입력 — 값만 주거나, 서식 변환(format)을 함께 지정한다.
 * 프로필엔 정준값 하나(생년월일 "19900315"), 서식마다 모양이 다를 때
 * format이 도구 안에서 변환한다 (claw-hwp secure-fill 포맷엔진 이식).
 */
type FillInput = FillValue | {
    value: FillValue;
    format?: string;
};
/**
 * 값 서식 변환 — `종류:스타일` 접두형(date:/phone:/rrn:/mask:/digits/upper/lower/nospace)
 * 또는 접두 없는 자유 패턴(`#` 포함 → 숫자마스크, yyyy·yy·mm·dd 포함 → 날짜 토큰).
 * 모르는 포맷은 값 원형 반환 (fail-open — 채움 자체는 진행).
 */
declare function formatFillValue(value: string, format?: string): string;
/**
 * 다중값 커서 — 라벨별 값 소비 상태를 추적한다.
 * 스칼라 값은 무한 반복(기존 동작), 배열 값은 적용 순서대로 소진되며
 * 다 쓰면 available=false가 되어 이후 등장은 채우지 않는다.
 */
declare class ValueCursor {
    private values;
    private nextIdx;
    constructor(values: Map<string, FillValue>);
    keys(): IterableIterator<string>;
    has(key: string): boolean;
    isArray(key: string): boolean;
    /** 남은 값이 있으면 true (스칼라는 항상 true) */
    available(key: string): boolean;
    /** 현재 값 미리보기 (소진 없음) */
    peek(key: string): string | undefined;
    /** 값 소비 — 배열이면 커서 전진, 소진 시 undefined */
    consume(key: string): string | undefined;
}
/**
 * 모호 라벨 거부 가드 — 한 입력 키(스칼라)가 서식의 2곳 이상에 채워지면 남의 블록
 * 오염 위험(대표자 행에 참여인력 값이 들어가는 류)이므로, 그 키는 채우지 않고
 * rejected로 보고한 뒤 나머지 키만으로 다시 채운다 (claw-hwp require_occurrence 이식).
 * 배열 값은 다중 등장 소진이 의도된 동작이라 거부 대상이 아니다.
 * @param run 같은 원본에 대해 결정적으로 재실행 가능한 채우기 함수
 */
declare function fillWithUniqueGuard<R extends {
    filled: Array<{
        key?: string;
        label: string;
    }>;
}>(values: Record<string, FillInput>, run: (vals: Record<string, FillInput>, blockedLabels?: Set<string>) => R | Promise<R>): Promise<R & {
    rejected: string[];
}>;

/** 문서 비교 엔진 — IR 레벨 블록 비교로 신구대조표 생성 */

/**
 * 두 문서를 비교하여 블록 단위 diff 생성.
 * 크로스 포맷 지원 — HWP vs HWPX 비교 가능 (IR 레벨).
 */
declare function compare(bufferA: ArrayBuffer, bufferB: ArrayBuffer, options?: ParseOptions): Promise<DiffResult>;
/** IRBlock[] 간 diff — LCS 기반 정렬 */
declare function diffBlocks(blocksA: IRBlock[], blocksB: IRBlock[]): DiffResult;

/** 양식(서식) 필드 인식 — 테이블 기반 label-value 패턴 매칭 */

/** 라벨처럼 보이는 셀인지 판별 */
declare function isLabelCell(text: string): boolean;
/**
 * IRBlock[]에서 양식 필드를 인식하여 추출.
 * 테이블의 label-value 패턴을 감지.
 */
declare function extractFormFields(blocks: IRBlock[]): FormResult;
/** 양식 필드 타입 — 폼 UI 위젯 선택의 근거 (데이트피커/체크박스 등) */
type FormFieldType = "text" | "date" | "phone" | "email" | "amount" | "checkbox" | "idnum";
/** 타입이 추론된 양식 필드 */
interface FormFieldSchema extends FormField {
    type: FormFieldType;
    /** 라벨에 필수 표시(※·*·★·"(필수)")가 있을 때만 true */
    required?: boolean;
    /** 값이 비어 있거나 플레이스홀더(밑줄/괄호 빈칸)뿐 — 채움 대상 */
    empty: boolean;
}
interface FormSchemaResult {
    fields: FormFieldSchema[];
    /** 양식 확신도 (0-1, extractFormFields와 동일) */
    confidence: number;
}
/** 필드 타입 추론 — 기존 값의 패턴 우선, 없으면 라벨 키워드 */
declare function inferFieldType(label: string, value: string): FormFieldType;
/**
 * 양식 필드 인식 + 타입/필수/빈값 추론 — 폼 UI 자동 생성용 (v3.1).
 * extractFormFields 결과에 type(date/phone/amount/checkbox/...)·required·empty를 부여한다.
 */
declare function extractFormSchema(blocks: IRBlock[]): FormSchemaResult;

/** 양식 서식 필드 값 채우기 — IRBlock[] 기반 in-place 교체 */

/** 필드 채우기 결과 */
interface FillResult {
    /** 값이 교체된 IRBlock[] */
    blocks: IRBlock[];
    /** 실제 채워진 필드 목록 */
    filled: FormField[];
    /** 매칭 실패한 라벨 (입력에는 있지만 서식에서 못 찾은 것) */
    unmatched: string[];
}
/**
 * IRBlock[]에서 양식 필드를 찾아 값을 교체.
 *
 * @param blocks 원본 IRBlock[] (변경하지 않음 — deep clone)
 * @param values 채울 값 맵 (라벨 → 새 값). 라벨은 접두사 매칭 지원.
 *   값이 배열이면 같은 라벨의 등장 순서대로 하나씩 소진(반복 양식·명부형 표),
 *   문자열이면 모든 등장에 동일값.
 * @returns FillResult
 *
 * @example
 * ```ts
 * const result = await parse("신청서.hwp")
 * if (!result.success) throw new Error(result.error)
 * const { blocks, filled } = fillFormFields(result.blocks, {
 *   "성명": "홍길동",
 *   "전화번호": "010-1234-5678",
 *   "주소": "서울시 강남구",
 * })
 * ```
 */
declare function fillFormFields(blocks: IRBlock[], values: Record<string, FillInput>, 
/** require_unique 2차에서 거부된 라벨 셀 차단 (sfill-2) — hwpx 경로와 동일 계약 */
blockedLabels?: Set<string>): FillResult;

/**
 * HWPX 원본 서식 유지 채우기 — section XML 오프셋 splice (v3.1, 바이트 보존)
 *
 * v3.0까지는 xmldom 전체 재직렬화 방식이라 변경하지 않은 영역도 속성 순서·
 * 공백·자기닫힘 표기가 바뀔 수 있었다. v3.1부터 patchHwpx와 동일한
 * source-map splice + ZIP in-place 재조립을 사용해, 변경 문단 외 XML과
 * 비변경 ZIP 엔트리를 1바이트도 건드리지 않는다.
 *
 * 전략 (v3.0과 동일, 적용 순서 보존):
 * 0. 인셀 패턴 — 체크박스 □→☑, 괄호 빈칸 (  )→(값), 어노테이션 (한자：)→(한자：값)
 * 1. 인접 라벨-값 셀 — label | value (패턴 적용 셀은 값을 앞에 삽입해 어노테이션 보존)
 * 2. 헤더+데이터 행 — 첫 행이 전부 라벨이면 열 단위 매칭 (나중 쓰기 우선 — v3.0 동일)
 * 3. 인라인 "라벨: 값" — 표 밖 본문/글상자/머리말·꼬리말·각주 문단
 *
 * 적용 범위는 v3.0과 동일하게 머리말/꼬리말 등 ctrl 내부 표·문단을 포함하고
 * (scan.orphanTables/excludedParagraphs), 셀 라벨 판정은 v3.0과 동일하게
 * 글상자(drawText) 문단을 제외한다. 패턴 매칭·범위 치환은 hp:t 연결 텍스트
 * (t-도메인) 좌표로 수행해 사이에 끼인 tab/br 요소를 건드리지 않는다.
 *
 * v3.0과의 의도적 차이: 인셀 패턴(전략 0)은 문단 단위로 매칭한다 — 문단
 * 경계에 걸친 패턴(극히 드묾)은 채우지 않는다.
 */

/** 채우기 결과 */
interface HwpxFillResult {
    /** 채워진 HWPX 바이너리 */
    buffer: ArrayBuffer;
    /** 실제 채워진 필드 목록 */
    filled: FormField[];
    /** 매칭 실패한 라벨 */
    unmatched: string[];
}
/**
 * HWPX 원본을 직접 수정하여 서식 필드를 채움 — 스타일 100% 보존.
 *
 * @param hwpxBuffer 원본 HWPX 파일 버퍼
 * @param values 채울 값 맵 (라벨 → 값). 값이 배열이면 같은 라벨의 등장 순서대로
 *   하나씩 소진된다 — 2~30장 반복 양식·명부형 표(헤더+여러 데이터 행) 채우기용.
 *   문자열이면 기존처럼 모든 등장에 동일값.
 * @returns HwpxFillResult
 */
declare function fillHwpx(hwpxBuffer: ArrayBuffer, values: Record<string, FillInput>, 
/** 이 정규화 라벨의 셀은 어떤 키로도 채우지 않음 — require_unique 2차에서 거부된
 *  라벨 셀이 접두사 매칭으로 남의 값에 오염되는 것을 차단 (sfill-2) */
blockedLabels?: Set<string>): Promise<HwpxFillResult>;

/**
 * place_seal — 도장/서명 이미지를 앵커 문구("(인)"·"서명 또는 인" 등) 위에
 * 부유(글 앞) 배치. 표/페이지 불확장 (P6, claw-hwp placeSeal 이식).
 *
 * 원리:
 * - 앵커 문구가 든 문단을 찾아 그 문단에 <hp:pic> 부유 개체를 anchor 한다.
 *   핵심 속성: treatAsChar="0" + flowWithText="0" + allowOverlap="1" +
 *   textWrap="IN_FRONT_OF_TEXT" — flowWithText="1"이면 한컴이 개체 높이만큼
 *   셀/페이지를 키운다 (claw-hwp GT 검증 규칙).
 * - 수평 위치는 폰트 메트릭으로 계산: 전각(한글/CJK)=1em, ASCII·반각=0.5em,
 *   em = 앵커 run charPr 높이(1/100pt). 렌더 없이 배치하고 렌더는 검증용.
 * - 가운데/오른쪽 정렬 문단(서식 셀에 흔함)은 블록 전체가 밀리므로
 *   (사용가능폭 − 문단폭)의 정렬 이동분을 x에 더한다.
 * - 위치 프레임은 PARA(문단 좌상단 기준) — 한컴은 문단 위로는 못 올라가게
 *   클램프하므로, 여유 공간이 있는 표 셀에서는 줄 세로 중앙에 앉고 본문
 *   최상단 줄에서는 상단 정렬로 눕는다.
 *
 * 적용 범위: 본문/표 셀/글상자 문단 (머리말·꼬리말·각주 내 앵커는 제외).
 * ZIP 재조립은 patchZipEntries — 비변경 엔트리는 1바이트도 건드리지 않고,
 * 도장 PNG는 BinData 신규 엔트리 + manifest(opf:item) 등재로 추가한다.
 */
/** 도장 배치 요청 */
interface SealOp {
    /** 앵커 문구 (예: "(인)", "서명 또는 인") */
    anchor: string;
    /** 같은 앵커가 여럿일 때 0-based 선택 (기본 0) */
    occurrence?: number;
    /** 도장/서명 이미지 바이트 (투명 배경 PNG 권장) */
    image: Uint8Array;
    /** 이미지 확장자 (기본 png) */
    ext?: "png" | "jpg" | "jpeg" | "bmp" | "gif";
    /** 도장 한 변 크기 mm (기본: 줄높이×1.6, 7~18mm 클램프) */
    sizeMm?: number;
    /** overlap=문구 위에 겹침, right=문구 오른쪽 옆, auto=공간 있으면 right (기본 auto) */
    mode?: "overlap" | "right" | "auto";
    /** 미세조정 mm */
    dxMm?: number;
    dyMm?: number;
}
/** 배치 결과 (도장 1개당 1건) */
interface SealPlacement {
    anchor: string;
    occurrence: number;
    sectionIndex: number;
    mode: "overlap" | "right";
    posXMm: number;
    posYMm: number;
    sizeMm: number;
    /** ZIP에 추가된 이미지 파트 경로 (BinData/imageN.ext) */
    entry: string;
    /** 근사 한계 경고 — 탭·줄바꿈 문단(seal-8), 중첩표(seal-2), 글상자(seal-3). 실측 전 근사. */
    warnings?: string[];
}
interface PlaceSealResult {
    buffer: ArrayBuffer;
    placed: SealPlacement[];
}
/**
 * HWPX에 도장/서명 이미지를 앵커 문구 기준으로 부유 배치한다.
 *
 * @param hwpxBuffer 원본 HWPX
 * @param ops 도장 배치 요청 (여러 개 가능 — 같은 이미지 재사용 시에도 op마다 파트가 추가됨)
 * @throws KordocError 앵커 미발견 (본문 내 등장 횟수를 메시지에 포함)
 */
declare function placeSealHwpx(hwpxBuffer: ArrayBuffer, ops: SealOp[]): Promise<PlaceSealResult>;

/**
 * 공문서(公文書) 모드 — 한국 행정 공문서 표준 서식 렌더링 로직
 *
 * 근거: 「행정업무의 운영 및 혁신에 관한 규정」 및 동 시행규칙(제2조 항목 표시),
 *       행정안전부 「2020 행정업무운영 편람」.
 * 자세한 표준은 docs/gongmunseo-reference.md, 구현 매핑은 docs/gongmunseo-engine-spec.md 참조.
 *
 * 이 모듈은 **순수 로직**만 담는다(항목부호 시퀀스 생성, 단계별 들여쓰기 계산,
 * 프리셋 해석). 실제 XML 조립은 generator.ts가 한다.
 */
type GongmunPreset = "official" | "report" | "plan" | "notice" | "minutes";
type GongmunNumbering = "standard" | "report";
type GongmunFont = "myeongjo" | "gothic";
/** 프리셋 입력값 — 영문 키 또는 한글 별칭(기안문·보고서·계획서·통지·회의록 등) */
type GongmunPresetInput = GongmunPreset | "기안문" | "시행문" | "공문" | "공문서" | "보고서" | "계획서" | "계획" | "통지" | "알림" | "안내" | "회의록";
/** 공문서 모드 옵션 (전부 선택 — 프리셋 기본값을 개별 override) */
interface GongmunOptions {
    /** 문서 종류 프리셋(영문 키 또는 한글 별칭). 기본 'official'(일반 기안문) */
    preset?: GongmunPresetInput;
    /** 본문 글꼴. 'myeongjo'=함초롬바탕(명조, 보고서·대외공문 관행) / 'gothic'=맑은 고딕(전자결재 기본) */
    bodyFont?: GongmunFont;
    /** 본문 글자 크기(pt). 기본 15 */
    bodyPt?: number;
    /** 본문 줄간격(%). 기본 160 (회의록 130) */
    lineSpacing?: number;
    /** 항목부호 체계. 'standard'=법정 8단계(1. 가. 1) …) / 'report'=보고서 불릿(□ ○ - ㆍ) */
    numbering?: GongmunNumbering;
    /** 용지 여백(mm). 기본 공식값 위20/아래10/좌20/우20 */
    margins?: {
        top: number;
        bottom: number;
        left: number;
        right: number;
    };
    /** 문서 제목(첫 h1)을 가운데 정렬. 기본 true (행정기관명·보고서 제목) */
    centerTitle?: boolean;
    /**
     * 문단별 자동 장평 — 한두 글자(짧은 꼬리)만 다음 줄로 넘어가는 문단의 장평을
     * 95→90%까지 자동 축소해 한 줄에 담는다(공무원 실무 관행의 자동화).
     * false로 끄거나 minRatio(기본 90)로 하한 조정. 기본 켜짐.
     */
    autoFit?: boolean | {
        minRatio?: number;
    };
}
/** 프리셋 별칭(한글/영문) → 내부 preset 키. CLI·라이브러리 공용 */
declare const PRESET_ALIAS: Record<string, GongmunPreset>;
/** 프리셋 입력(영문 키 또는 한글 별칭)을 내부 GongmunPreset로 정규화. 미상은 'official' */
declare function normalizeGongmunPreset(preset?: string): GongmunPreset;

/** HWPX 생성 시 적용할 시각 테마 (모두 선택) */
interface HwpxTheme {
    /**
     * 헤딩 레벨별 텍스트 색상. 미지정 시 검정.
     * 현재 charPr 매핑은 h1/h2/h3/h4 4단계 (h5, h6은 h4와 같은 charPr 공유)이므로
     * 키는 1~4만 받는다.
     */
    headingColors?: Partial<Record<1 | 2 | 3 | 4, string>>;
    /** 본문 단락 텍스트 색상. 미지정 시 검정 */
    bodyColor?: string;
    /**
     * 인용문 텍스트 색상. 미지정 시 검정.
     *
     * 주의: 이 옵션을 지정하면 인용문이 별도 charPr(이탤릭)로 렌더링된다.
     * 미지정 시 기존 동작 그대로 본문 charPr로 렌더링 (이탤릭 아님).
     */
    quoteColor?: string;
    /** 표 첫 행 텍스트 색상. 미지정 시 본문과 동일 */
    tableHeaderColor?: string;
    /** 표 첫 행 텍스트를 굵게 표시 (기본 false) */
    tableHeaderBold?: boolean;
}

/**
 * 서식 프로필(Format Profile) — generate 시각 서식 재현 (이슈 #41 / PR #42).
 *
 * markdownToHwpx가 표의 위상(병합 구조)뿐 아니라 음영·괘선·열 너비·셀 글꼴까지
 * 재현할 수 있도록, 원본 문서 없이 서식만 실어 나르는 프로필의 타입·리맵·XML 빌더.
 *
 * 파서 IR(IRCell/IRTable)에는 서식 필드가 없으므로 프로필은 IR과 독립된 통로다.
 * 프로필의 borderFill/charPr id는 표별 로컬 네임스페이스라, 여기서 문서 전역 id로
 * 재할당(remap)한 뒤 header에 정의를 등록하고 셀에 연결한다.
 */
/** 한 변의 괘선 정의 */
interface BorderDef {
    /** SOLID | NONE | DASH | DOT ... (HWPX border type) */
    type: string;
    /** "0.12 mm" 등 HWPX width 문자열 */
    width: string;
    /** "#RRGGBB" */
    color: string;
}
/** 셀 테두리+음영 정의 (표별 로컬 id로 참조됨) */
interface BorderFillDef {
    leftBorder?: BorderDef;
    rightBorder?: BorderDef;
    topBorder?: BorderDef;
    bottomBorder?: BorderDef;
    /** 셀 음영 — winBrush faceColor. 채움 없으면 생략 */
    fill?: {
        faceColor: string;
    };
}
/** 셀 글꼴 정의 (표별 로컬 id로 참조됨) */
interface CharPrDef {
    /** "1100" (= 11pt × 100) */
    height_hwpunit?: string;
    textColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    /** fontfaces HANGUL 순번. render는 이름표로 손실하므로 원본 순번 보존용 */
    fontRef_hangul?: string;
}
/** 셀 하나의 서식 참조 (좌표 = 병합 셀 좌상단 앵커) */
interface CellProfile {
    row: number;
    col: number;
    rowSpan?: number;
    colSpan?: number;
    width_hwpunit?: string;
    height_hwpunit?: string;
    /** used_border_fills 키 */
    borderFillIDRef?: string;
    /** used_char_prs 키 */
    charPrIDRef?: string;
}
/** 표 하나의 서식 프로필 */
interface TableProfile {
    /** 문서 내 표 등장 순서 (0-기준) */
    table_index: number;
    rows: number;
    cols: number;
    /**
     * 첫 셀(0,0) 텍스트의 정규화 앵커(normalizeAnchor) — 소비 시 표 대응의 보조 키.
     * parse 가 마크다운으로 방출하지 않는 표(1×1 제목박스·머리말 표 등) 때문에 순번이
     * 어긋나도, 앵커+치수가 맞는 프로필만 골라 적용해 남의 서식 오적용을 막는다(v3.18.1).
     */
    anchor_text?: string;
    width_hwpunit?: string;
    col_widths_hwpunit?: string[];
    cells: CellProfile[];
    /** 로컬 id → 정의. 표별 독립 네임스페이스 */
    used_border_fills: Record<string, BorderFillDef>;
    used_char_prs?: Record<string, CharPrDef>;
}
/** 문서 전체 서식 프로필 */
interface FormatProfile {
    schema_version?: string;
    tables: TableProfile[];
}

/**
 * Markdown → HWPX 역변환
 *
 * 지원: 헤딩(h1~h6), 단락, 볼드, 이탤릭, 인라인코드, 코드블록,
 *       순서/비순서 리스트, 수평선, 인용문, 테이블
 * jszip으로 HWPX ZIP 패키징.
 *
 * 엔트리(markdownToHwpx)와 재수출만 남김 — 구현은 목적별 모듈로 분리:
 *   gen-ids.ts        — NS/charPr/paraPr id 상수·테마 해석·XML 원자(escapeXml, charPr/paraPr)
 *   md-runs.ts        — 마크다운 블록/인라인 파싱 + run/문단 XML + PrvText
 *   gen-header.ts     — container/manifest/head.xml 생성
 *   gen-gongmun-fit.ts — 공문 자동장평 계획 + 리스트 항목부호 선계산
 *   gen-table.ts      — GFM/HTML(병합) 표 XML
 *   gen-section.ts    — secPr + 본문 section0.xml 조립
 */

/** markdownToHwpx 옵션 */
interface MarkdownToHwpxOptions {
    theme?: HwpxTheme;
    /**
     * 공문서 모드 — 지정 시 한국 행정 공문서 표준 서식으로 렌더링한다.
     * (공식 여백, 명조 15pt 본문, 항목부호 8단계 행갈굼 정렬, 줄간격 등)
     * 미지정 시 기존 범용 마크다운 변환 동작 그대로 유지.
     */
    gongmun?: GongmunOptions;
    /**
     * 서식 프로필 — 표의 borderFill(테두리·음영)·열 너비·셀 글꼴을 원본 문서 없이
     * 재현한다(이슈 #41). `hwpxToProfile()`로 추출하거나 직접 작성한 프로필을 넘기면,
     * 문서 내 표 등장 순서(table_index)로 매칭해 셀 좌표별 서식을 적용한다.
     * 미지정 시 기존 기본 서식(단일 SOLID 테두리·균등 열폭) 그대로.
     */
    profile?: FormatProfile;
}
/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 */
declare function markdownToHwpx(markdown: string, options?: MarkdownToHwpxOptions): Promise<ArrayBuffer>;

/**
 * 서식 프로필 추출 (hwpx → FormatProfile) — 이슈 #41 / PR #42 Part B.
 *
 * 원본 hwpx에서 표의 borderFill(테두리·음영)·열너비·셀 글꼴을 읽어
 * FormatProfile JSON으로 뽑는다. 이 프로필을 `markdownToHwpx(md, { profile })`에
 * 넘기면 원본 없이 같은 시각 서식을 재현한다(진짜 라운드트립).
 *
 * render 경로(head-styles/svg-render)는 mm→pt·font→family 손실 변환이라
 * 프로필 충실 추출엔 부적합. 여기서는 header/section XML을 원문 그대로 읽는
 * 얇은 전용 파서를 쓴다.
 */

/**
 * hwpx → FormatProfile. 문서 내 top-level 표를 등장 순서대로 추출한다.
 * @param input hwpx ArrayBuffer 또는 Buffer
 */
declare function hwpxToProfile(input: ArrayBuffer | Buffer): Promise<FormatProfile>;

/**
 * 한글 조판 텍스트 폭 계산 — 함초롬바탕(HCR Batang) 실측 advance 테이블
 *
 * 공문서 표준 본문 글꼴인 함초롬바탕 정품 TTF(한컴 공개 배포)의 hmtx advance를
 * upem=1000 기준으로 추출한 값이다. Bold도 advance가 Regular와 완전히 동일함을
 * 전수 확인했다(한컴이 굵기 간 폭을 통일해 제작). 한글 음절 11,172자 전수 = 970,
 * 한자 = 1000, 전각형·원문자·도형·화살표·단위기호 = 970으로 균일하다.
 *
 * 단위: em×1000. 실제 폭(HWPUNIT) = w/1000 × charPr.height × ratio(장평)/100.
 * (1em = 글자크기 = charPr.height HWPUNIT — 1pt = 100 HWPUNIT이므로)
 *
 * 공백: HWP는 charPr useFontSpace=0(기본)일 때 글꼴의 space advance(0.30em) 대신
 * 반각 고정폭(0.50em)을 쓴다 — kordoc 생성 문서는 모두 useFontSpace=0이므로
 * 기본 SPACE_EM=500. (글꼴값을 쓰려면 measure 옵션 fontSpace로 300 지정)
 *
 * 다른 글꼴(맑은 고딕 등)도 한글=전각 균일·숫자≈0.55em의 동일 부류 구조라
 * 이 테이블로 근사한다(오차 수 % 이내 — 공문서 본문은 어차피 함초롬바탕 관행).
 */
/** 코드포인트의 advance(em×1000). 미상 문자는 CJK권 970 / 라틴권 550 폴백 */
declare function charWidthEm1000(cp: number): number;
/** HWP 공백 폭(em×1000) — useFontSpace=0(기본): 반각 고정 500 / =1: 글꼴값 300 */
declare const SPACE_EM_FIXED = 500;
declare const SPACE_EM_FONT = 300;
interface MeasureOptions {
    /** 공백 폭(em×1000). 기본 SPACE_EM_FIXED(500) = useFontSpace 0 */
    spaceEm?: number;
    /** 자간(charPr spacing %) — 글자폭의 %가 문자마다 추가 */
    spacingPct?: number;
}
/**
 * 텍스트 폭(HWPUNIT). height=charPr height(pt×100), ratioPct=장평 %.
 * 결과는 float — 호출부에서 비교 시 ±0.5 HWPUNIT 오차 허용 권장.
 */
declare function measureTextWidth(text: string, height: number, ratioPct: number, opts?: MeasureOptions): number;
type WrapMode = "keep" | "charAll";
interface WrapResult {
    /** 줄 수 */
    lines: number;
    /** 각 줄의 시작 오프셋(UTF-16) — [0, …] */
    starts: number[];
    /** 마지막 줄 텍스트 폭(HWPUNIT) */
    lastLineWidth: number;
}
/**
 * 문단 줄바꿈 시뮬레이션.
 * mode 'keep' = breakNonLatinWord=KEEP_WORD(어절 단위, 공문서 모드·Windows 한글),
 * mode 'charAll' = 글자 단위(BREAK_WORD·macOS 한글·전자결재 변환기의 실동작).
 * 한 어절이 줄보다 길면 keep에서도 글자 단위로 강제 분해(한컴 동일).
 *
 * @param text        문단 전체 텍스트(항목 부호 포함)
 * @param firstWidth  첫 줄 가용 폭(HWPUNIT)
 * @param contWidth   둘째 줄부터 가용 폭(HWPUNIT) — 내어쓰기 반영
 * @param height      charPr height (pt×100)
 * @param ratioPct    장평 %
 */
declare function simulateWrap(text: string, firstWidth: number, contWidth: number, height: number, ratioPct: number, mode?: WrapMode, opts?: MeasureOptions): WrapResult;
/** @deprecated simulateWrap(text, …, 'keep') 별칭 — 하위 호환 */
declare function simulateWrapKeepWord(text: string, firstWidth: number, contWidth: number, height: number, ratioPct: number, opts?: MeasureOptions): WrapResult;
/**
 * 한두 글자(짧은 꼬리)가 다음 줄로 넘어간 문단을 장평 축소로 한 줄 줄일 수 있는지
 * 탐색. baseRatio에서 줄 수 N≥2일 때 r=baseRatio-1…minRatio를 내려가며 처음으로
 * 줄 수가 줄어드는(가장 큰) r을 반환. 불가능하면 null.
 * (실무 관행: 공무원이 문단 장평을 95→92 등으로 줄여 orphan을 위로 당기는 조작의 자동화.
 * keep 모드로 판정 — 글자 단위 조판은 항상 keep 이하의 줄 수라 함께 만족된다.)
 */
declare function fitRatioForFewerLines(text: string, firstWidth: number, contWidth: number, height: number, baseRatio: number, minRatio: number, opts?: MeasureOptions): number | null;

/**
 * HWPX 라운드트립 소스맵 — section XML 문자열에서 문단/표 셀의 문자 범위를 추적.
 *
 * DOM 재직렬화를 거치지 않고(속성 순서·공백·자기닫힘 표기까지 보존하기 위해)
 * 정규식 토크나이저로 태그를 순회하며, 각 <hp:p>가 소유한 <hp:t> 콘텐츠 범위를
 * 기록한다. 패치는 이 범위에 대한 문자열 splice로만 수행되어
 * 변경 문단 외 XML 바이트가 그대로 보존된다 (filler-hwpx.ts 패턴의 오프셋 버전).
 */
/** <hp:t> 콘텐츠 범위 — [contentStart, contentEnd) 가 여는/닫는 태그 사이 */
interface TRange {
    contentStart: number;
    contentEnd: number;
    /** 자기닫힘 <hp:t/> — 범위가 태그 전체이며, 치환 시 태그째 교체 */
    selfClosing?: boolean;
    /** 자기닫힘 치환용 네임스페이스 프리픽스 (예: "hp") */
    prefix?: string;
}
type ScanParaKind = "body" | "cell" | "draw" | "excluded";
/** 스캔된 문단 — 소유한 hp:t 범위와 합산 텍스트 */
interface ScanParagraph {
    sectionIndex: number;
    kind: ScanParaKind;
    /** <hp:p ...> 여는 태그 시작 위치 (문서 순서 정렬용) */
    start: number;
    /** 소유 hp:t 콘텐츠 범위 (문서 순서) */
    tRanges: TRange[];
    /** hp:t 텍스트 합산 (엔티티 디코딩, 내부 태그는 공백화) */
    text: string;
    /** hp:t가 하나도 없을 때 텍스트 삽입 가능한 위치 (첫 run 닫는 태그 앞) */
    runInsertPos?: number;
    /** runInsertPos에 삽입할 때 쓸 t 태그 prefix (예: "hp") */
    runPrefix?: string;
    /** 자기닫힘 <hp:run/> 태그 범위 — t 삽입 시 펼쳐서 사용 (한컴 빈 문단 패턴) */
    selfCloseRun?: {
        start: number;
        end: number;
    };
    /** 글상자(drawText) 경유 문단 — 셀 라벨 판정 등에서 본문과 구분 (v3.1) */
    inTextbox?: boolean;
}
/** 스캔된 표 셀 — 앵커 좌표와 셀 내부 문단 */
interface ScanCell {
    rowAddr?: number;
    colAddr?: number;
    colSpan: number;
    rowSpan: number;
    paragraphs: ScanParagraph[];
    /** 셀 내부 중첩표 (문서 순서) */
    tables: ScanTable[];
    /** <hp:cellAddr> 태그 범위 (자기닫힘=태그 전체, 펼친형=여는 태그) — rowAddr 재작성용 */
    addrTagRange?: {
        start: number;
        end: number;
    };
}
/** 스캔된 표 */
interface ScanTable {
    sectionIndex: number;
    start: number;
    /** 최상위 표 여부 (다른 표/ctrl/캡션 내부가 아님) */
    topLevel: boolean;
    /** 비어있지 않은 행들 (tr 순서) */
    rows: ScanCell[][];
    /** rows[i]의 <hp:tr>...</hp:tr> XML 범위 (행 추가/삭제 splice용, rows와 정렬) */
    rowRanges: {
        start: number;
        end: number;
    }[];
    /** 앵커 좌표 → 셀 ("r,c") */
    cellByAnchor: Map<string, ScanCell>;
}
/** 섹션 하나의 스캔 결과 */
interface SectionScan {
    sectionIndex: number;
    xml: string;
    /** body + draw 문단 (문서 순서) — 본문 텍스트 매핑 대상 */
    bodyParagraphs: ScanParagraph[];
    /** 최상위 표 (문서 순서) */
    tables: ScanTable[];
    /** 머리말/꼬리말 문단 텍스트 (OB 앞/뒤 배치 블록 식별용) */
    headerTexts: string[];
    footerTexts: string[];
    /**
     * 파서 비가시 영역(머리말/꼬리말/각주/캡션/메모 등 ctrl 내부) 문단 — v3.1.
     * patcher 매핑 대상이 아니며, filler가 이 영역의 인라인 패턴을 채울 때 사용.
     */
    excludedParagraphs: ScanParagraph[];
    /**
     * 어느 셀에도 속하지 않는 비최상위 표(머리말/꼬리말 등 ctrl 내부) — v3.1.
     * filler 전용. patcher의 표 서수 매핑(tables)에는 포함되지 않는다.
     */
    orphanTables: ScanTable[];
}
/** 문자열 splice 편집 — [start, end) 를 replacement로 치환 */
interface SpliceEdit {
    start: number;
    end: number;
    replacement: string;
}
/**
 * section XML 한 개를 스캔하여 소스맵을 만든다.
 * 토크나이저는 xmldom과 무관하게 동작하며, 위치(오프셋) 정보가 핵심이다.
 */
declare function scanSectionXml(xml: string, sectionIndex: number): SectionScan;
/**
 * 문단 텍스트 치환용 splice 생성 — filler-hwpx.ts replaceCellText와 동일 전략:
 * 첫 hp:t에 새 텍스트(이스케이프), 나머지 hp:t는 비움. run 구조/charPr 보존.
 * t가 없으면 첫 run 끝에 <hp:t> 삽입. 실패 시 null.
 *
 * IR 텍스트는 sanitize로 양끝 공백이 제거된 상태라, 통째 교체 시 원본의
 * 선행 공백(들여쓰기)/후행 공백이 소실된다 — 원본 t-도메인 텍스트에서
 * 양끝 공백을 복원해 새 텍스트에 입힌다 (재파싱 IR은 동일하게 유지됨).
 */
declare function buildParagraphSplices(para: ScanParagraph, newText: string, xml?: string): SpliceEdit[] | null;
/**
 * t-도메인 텍스트(paraTText 좌표계)의 [start, end) 범위만 치환하는 정밀 splice
 * — run/탭 구조 보존 (v3.1).
 *
 * 좌표계가 t-도메인이므로 tab/br이 사이에 끼어 있어도 동작한다 (해당 요소는
 * 건드리지 않고 t 콘텐츠만 수술). hp:t 콘텐츠에 엔티티/내부 태그가 있으면
 * 오프셋 정합이 깨지므로 null을 반환한다 (호출자가 폴백 결정).
 */
declare function buildRangeSplices(para: ScanParagraph, xml: string, start: number, end: number, replacement: string): SpliceEdit[] | null;
declare function applySplices(xml: string, splices: SpliceEdit[]): string;

/**
 * HWPX 서식 보존 무손실 라운드트립 패치 — v3.0 킬러기능.
 *
 * parse()로 얻은 마크다운을 편집한 뒤 patchHwpx()에 넘기면, 원본 HWPX의
 * ZIP/XML 구조를 그대로 두고 변경된 문단/셀의 텍스트만 in-place 치환한다.
 * 스타일·이미지·표 구조·설정은 1바이트도 건드리지 않는다 (section XML 외
 * ZIP 엔트리는 원본 바이트 그대로, 변경 문단도 run 구조·charPr 보존).
 *
 * 지원: 문단/헤딩 텍스트 수정, 표 셀 텍스트 수정 (GFM·HTML·1x1·1열 표),
 * 문단 → GFM 표 인플레이스 변환 (v3.5 — table-insert.ts),
 * GFM/HTML 표 행 추가/삭제 (v3.7 — table-rows.ts, 병합 교차·개체 포함 행은 skip).
 * 미지원(graceful skip): 블록 추가/삭제/순서 변경, 표 열/병합 변경,
 * 캡션·각주·머리말/꼬리말·이미지 변경. skipped[]에 사유와 함께 보고된다.
 */

/**
 * 원본 HWPX와 편집된 마크다운으로 서식 보존 패치본을 만든다.
 *
 * @param original 원본 HWPX 바이트
 * @param editedMarkdown parse(original).markdown을 편집한 마크다운
 */
declare function patchHwpx(original: Uint8Array, editedMarkdown: string, options?: PatchOptions): Promise<PatchResult>;

/**
 * HWP 5.x 바이너리 서식 보존 무손실 라운드트립 패치 — patchHwpx의 HWP5 대응.
 *
 * parse()로 얻은 마크다운을 편집한 뒤 patchHwp()에 넘기면, 원본 HWP의
 * CFB/레코드 구조를 그대로 두고 변경된 문단/표 셀의 PARA_TEXT만 치환한다.
 * 연쇄 갱신: PARA_HEADER nChars, CHAR_SHAPE 위치, LINE_SEG 재구성, 레코드
 * 크기 재계산 → 섹션 스트림 재직렬화 → deflate 재압축 → CFB 재조립.
 *
 * 안전 게이트 (하나라도 깨지면 해당 수정은 graceful skip — 파일 무결성 우선):
 *  - 섹션 레코드 재직렬화가 원본과 바이트 동일해야 패치 허용
 *  - ctrlMask=0(순수 텍스트) + PARA_TEXT 1개 + 레코드 텍스트 재구성 일치 문단만 수정
 *  - 배포용/암호화/DRM 문서는 전체 거부
 *
 * 지원: 본문 문단/헤딩 텍스트 수정, GFM 표 셀 텍스트 수정 (좌표 기반).
 * 미지원(graceful skip): 블록 추가/삭제, 표 구조 변경, HTML 표 셀, 캡션·각주·
 * 머리말/꼬리말, 컨트롤(탭/개체/필드) 포함 문단. skipped[]에 사유 보고.
 */

/**
 * 원본 HWP 5.x와 편집된 마크다운으로 서식 보존 패치본을 만든다.
 *
 * @param original 원본 HWP 바이트 (OLE2/CFB)
 * @param editedMarkdown parse(original).markdown을 편집한 마크다운
 */
declare function patchHwp(original: Uint8Array, editedMarkdown: string, options?: PatchOptions): Promise<PatchResult>;

/**
 * HWPX 구조 검증 — 한컴오피스/한컴독스가 열기를 거부하는 컨테이너 결함을 사전에 잡는다.
 *
 * 검사 항목 (claw-hwp validate.py의 실측 검사셋 이식 — MIT © DoHyun468/claw-hwp):
 * - 유효한 ZIP인지, mimetype이 첫 엔트리이고 내용이 application/hwp+zip인지
 * - 필수 파일 존재 (META-INF/container.xml, content.hpf, header.xml, section0.xml)
 * - XML/HPF/RDF 엔트리 웰폼드
 * - header.xml secCnt == 실제 Contents/sectionN.xml 수
 *   (한컴독스는 실제 파일 목록이 아니라 secCnt를 신뢰하고, 불일치 시 열기를 거부한다)
 * - content.hpf manifest의 <opf:item href>가 전부 실존하는지
 */
/** 검증에서 발견된 문제 하나 */
interface ValidateIssue {
    /** 문제가 발견된 zip 내부 경로 (컨테이너 전역 문제면 생략) */
    path?: string;
    message: string;
}
/** validateHwpx 결과 */
interface ValidateResult {
    ok: boolean;
    issues: ValidateIssue[];
    /** 검사한 zip 엔트리 수 (디렉토리 제외) */
    entryCount: number;
}
/** HWPX 버퍼의 컨테이너 구조를 검증한다. 문제가 없으면 ok=true. */
declare function validateHwpx(buffer: ArrayBuffer | Uint8Array): Promise<ValidateResult>;

/**
 * HWPX 문서 세션 — 에디터 통합용 블록 단위 증분 패치 API (v3.1).
 *
 * patchHwpx가 "편집된 마크다운 전체"를 받아 내부에서 LCS 정렬하는 것과 달리,
 * 세션은 블록 인덱스로 직접 편집을 지정한다 (에디터의 블록 클릭-편집에 대응).
 *
 * 설계 원칙:
 * - 매핑은 patcher와 동일한 알고리즘 재사용 (정규화 텍스트 버킷 + 표 서수) —
 *   "n회 연속 patchBlocks ≡ 일괄 patchHwpx" 동등성이 성립하는 근거.
 * - 패치 후 상태는 새 바이트에서 전체 재구축 (오프셋 리베이스 대신 재스캔 —
 *   성능보다 정합성). patchBlocks 호출 후 이전 블록 인덱스는 무효이며
 *   session.blocks를 다시 읽어야 한다.
 * - capability()는 patcher의 graceful-skip 게이트를 사전 판정으로 노출 —
 *   에디터가 편집 전에 잠금 UI를 띄울 수 있는 단일 진실 소스.
 */

/** 블록 편집 가능성 — 에디터 잠금 UI의 근거 */
type BlockCapability = "text" | "cell-text" | "locked";
interface CellCapability {
    editable: boolean;
    /** 편집 불가 사유 (한국어) */
    reason?: string;
}
interface BlockCapabilityInfo {
    capability: BlockCapability;
    /** locked 사유 (한국어) */
    reason?: string;
    /** 표 블록: IRTable 격자 좌표(row×col)별 셀 편집 가능 여부 */
    cells?: CellCapability[][];
}
/** 블록 → 원본 위치 참조 (에디터 하이라이트/점프용) */
interface BlockSourceRef {
    kind: "paragraph" | "table";
    /** 0-based 섹션 인덱스 */
    sectionIndex: number;
    /** 섹션 XML 내 시작 문자 오프셋 (<hp:p>/<hp:tbl> 여는 태그) */
    xmlStart: number;
}
/** 블록 단위 편집 — patchBlocks 입력 */
interface BlockEdit {
    /** session.blocks 기준 0-based 블록 인덱스 */
    blockIndex: number;
    /**
     * 문단/헤딩 블록의 새 텍스트 (평문).
     * 빈 문자열(비우기)은 미지원 — patchHwpx의 "블록 삭제 미지원"과 정합
     * (비우면 재파싱 시 블록 핸들이 사라져 세션으로 복구 불가).
     */
    newText?: string;
    /** 표 블록의 셀 편집 (IRTable 격자 좌표 기준). 이미지가 든 셀은 이미지
     *  토큰(`![image](...)`/`[이미지: ...]`)을 유지한 채 텍스트만 수정해야 한다. */
    cells?: Array<{
        row: number;
        col: number;
        text: string;
    }>;
}
declare class HwpxSession {
    private state;
    private constructor();
    /** HWPX 바이트로 세션을 연다 (입력은 복사되어 외부 변이와 격리) */
    static open(input: Uint8Array | ArrayBuffer): Promise<HwpxSession>;
    /** 현재 문서의 IR 블록 — patchBlocks 후 갱신되므로 호출마다 다시 읽을 것 */
    get blocks(): IRBlock[];
    /** 현재 문서의 마크다운 */
    get markdown(): string;
    /** 현재 문서 바이트 (복사본) */
    get bytes(): Uint8Array;
    /** 블록 → 원본 위치 참조. 매핑 실패 시 undefined */
    sourceRef(blockIndex: number): BlockSourceRef | undefined;
    /** 블록 편집 가능성 사전 판정 — patcher graceful-skip 게이트의 사전 버전 */
    capability(blockIndex: number): BlockCapabilityInfo;
    /** 전 블록의 편집 가능성 */
    capabilities(): BlockCapabilityInfo[];
    /**
     * 블록 단위 증분 패치 — 적용 후 세션 상태가 새 바이트로 갱신된다.
     *
     * - 호출은 내부적으로 직렬화된다 (동시 호출 시 도착 순서대로 누적 적용)
     * - 무변경 편집(현재 텍스트와 동일)은 조용히 건너뜀 (applied/skipped 모두 제외)
     * - 변경이 하나도 적용되지 않으면 반환 data는 현재 문서와 바이트 동일
     * - changes는 "패치 전 → 후" 문서 diff — modified 수가 기대 편집 수와
     *   일치하는지 확인 용도. patchHwpx의 verification(잔차 검증)과 의미가 다르다.
     */
    patchBlocks(edits: BlockEdit[], options?: PatchOptions): Promise<PatchResult>;
    private opQueue;
    private patchBlocksInner;
    /** 문단/헤딩 평문 편집 — patcher.patchParagraphUnit의 평문 입력 버전 */
    private patchParagraphPlain;
}
/** HWPX 문서 세션 열기 */
declare function openHwpxDocument(input: Uint8Array | ArrayBuffer): Promise<HwpxSession>;
/** 원샷 블록 패치 — 세션 없이 한 번에 (stateless RPC용) */
declare function patchHwpxBlocks(original: Uint8Array | ArrayBuffer, edits: BlockEdit[], options?: PatchOptions): Promise<PatchResult>;

/**
 * Print Renderer — Markdown / IRBlock[] → PDF (puppeteer-core 기반).
 *
 * 흐름:
 *   blocks → markdown (blocksToMarkdown)
 *   markdown → HTML (markdown-it)
 *   HTML + 프리셋 CSS → PDF (puppeteer-core)
 *
 * puppeteer-core는 optional peer dep. 미설치 시 markdownToPdf는 명확한 에러를 던지지만
 * `renderHtml()`은 항상 동작 (외부 PDF 엔진과 결합용).
 *
 * 참조: docs/SPEC.md §1.3
 */

type PrintPreset = "default" | "gov-formal" | "compact";
interface PageMargin {
    top: string | number;
    right: string | number;
    bottom: string | number;
    left: string | number;
}
interface PrintOptions {
    preset?: PrintPreset;
    pageSize?: "A4" | "Letter";
    orientation?: "portrait" | "landscape";
    margin?: PageMargin;
    /** 페이지 머리글 (HTML 허용, gov-formal 프리셋에서 자동 표시) */
    header?: string;
    /** 페이지 바닥글 (HTML 허용) */
    footer?: string;
    /** 워터마크 텍스트 (대각선 회색) */
    watermark?: string;
    /** 사용자 정의 추가 CSS */
    extraCss?: string;
}
/**
 * Markdown 또는 IRBlock[] → HTML 문자열.
 * 외부 PDF 엔진(weasyprint, wkhtmltopdf 등)과 결합 가능.
 */
declare function renderHtml(markdown: string, options?: PrintOptions): string;
/** Markdown → PDF (Buffer). */
declare function markdownToPdf(markdown: string, options?: PrintOptions): Promise<Buffer>;
/** IRBlock[] → PDF (Buffer). */
declare function blocksToPdf(blocks: IRBlock[], options?: PrintOptions): Promise<Buffer>;

/**
 * 레이아웃 보존 렌더 — HWPX 조판 캐시(lineseg·cellAddr·hp:pos)를 SVG 절대배치로 그린다.
 *
 * 조판 엔진 없음: 한컴이 저장 시 기록한 좌표를 그대로 사용한다. 따라서
 * 한컴(또는 조판 캐시를 기록하는 편집기)에서 저장한 파일만 렌더 가능 —
 * markdownToHwpx 산출물엔 linesegarray가 없어 KordocError를 던진다.
 *
 * 좌표 산식(실측 검증 — .claude/plans/render-poc/findings.md):
 * - 단위 HWPUNIT(1/7200in), pt = /100. 최상위 문단 lineseg = 본문영역 로컬,
 *   셀 문단 = 셀 로컬. PARA 밀어내기 개체 anchor = 호스트vp − (omTop+h+omBottom) 역산.
 * - horzsize는 줄 "영역" 폭(텍스트 폭 아님) — 마지막 줄이 아닌 줄은 원본 줄바꿈에
 *   맞춰 textLength로 고정하고, 마지막 줄만 paraPr 정렬(LEFT 자연폭/CENTER/RIGHT/배분)을 적용.
 * - 좌표 속성엔 uint32로 저장된 음수가 섞여 있다(toInt32 필수).
 * - 표 열은 span 제약 경계 전파로, 행은 rs=1 max + 콘텐츠 초과 성장으로 푼다.
 *
 * 페이지: 최상위 lineseg vertpos는 페이지 로컬(페이지마다 0부터 리셋)이므로 역행
 *   지점을 페이지 경계로 감지, 전 페이지를 세로 스택으로 그린다(페이지별 흰 배경 +
 *   클립). 페이지에 걸친 표는 시작 페이지에서 잘린다(조판 캐시에 분할점이 없음).
 *
 * 범위: section0 한정(다중 구역은 첫 구역만), 수식·그리기개체 도형은 미지원(경고 수집).
 */

interface RenderSvgOptions {
    /** 이미지 1장당 허용 최대 바이트 (기본 40MB) */
    maxImageBytes?: number;
    /** 검색어 형광펜 — 텍스트 조각 내 매치 구간에 배경 rect (대소문자 무시).
     *  charPr(스타일) 경계에 걸친 매치는 칠하지 못한다. */
    highlights?: string[];
    /** Tier-2 reflow — 조판 캐시(linesegarray) 없는 파일도 순수 TS 조판으로 렌더.
     *  캐시가 있으면 무시(한컴본은 캐시 재생). 기본 false(캐시 없으면 KordocError). */
    reflow?: boolean;
    /** reflow 줄바꿈 모드 — 'keep'(어절, Windows 한글·공문서) / 'charAll'(글자, macOS·전자결재) */
    reflowMode?: WrapMode;
}
interface RenderSvgResult {
    svg: string;
    /** 페이지 폭 (pt) */
    width: number;
    /** 전체 캔버스 높이 (pt) — 페이지 세로 스택 + 간격 */
    height: number;
    /** 렌더된 페이지 수 */
    pageCount: number;
    warnings: string[];
    stats: {
        texts: number;
        images: number;
        tables: number;
    };
}
/**
 * HWPX(한컴 저장본) → 레이아웃 보존 SVG. **전 구역(section*)을 세로 스택으로** 렌더한다.
 * 조판 캐시(linesegarray)가 없는 구역은 reflow 옵션으로 합성 조판(없으면 그 구역 생략);
 * 렌더 가능한 구역이 하나도 없으면 KordocError.
 */
declare function renderHwpxToSvg(input: ArrayBuffer | Uint8Array, options?: RenderSvgOptions): Promise<RenderSvgResult>;

/** 매직 바이트 기반 파일 포맷 감지 */

/** ZIP 파일 여부: PK\x03\x04 */
declare function isZipFile(buffer: ArrayBuffer): boolean;
/** HWPX (ZIP 기반 한컴 문서): PK\x03\x04 — 하위 호환용 */
declare function isHwpxFile(buffer: ArrayBuffer): boolean;
/** HWP 5.x (OLE2 바이너리 한컴 문서): \xD0\xCF\x11\xE0 */
declare function isOldHwpFile(buffer: ArrayBuffer): boolean;
/** PDF 문서: %PDF */
declare function isPdfFile(buffer: ArrayBuffer): boolean;
/** 동기 포맷 감지 — ZIP은 모두 "hwpx"로 반환 (하위 호환) */
declare function detectFormat(buffer: ArrayBuffer): FileType;
/**
 * OLE2 컨테이너 내부 스트림 기반 포맷 세분화.
 * HWP 5.x, XLS 모두 OLE2이므로 스트림 이름으로 구분.
 *  - "Workbook" 또는 "Book" → 'xls'
 *  - 그 외 (FileHeader 등) → 'hwp'
 */
declare function detectOle2Format(buffer: ArrayBuffer): "hwp" | "xls" | "unknown";
/**
 * ZIP 내부 구조 기반 포맷 세분화.
 * HWPX, XLSX, DOCX 모두 ZIP이므로 내부 파일로 구분.
 */
declare function detectZipFormat(buffer: ArrayBuffer): Promise<"hwpx" | "xlsx" | "docx" | "unknown">;

/** 2-pass colSpan/rowSpan 테이블 빌더 및 Markdown 변환 */

declare function blocksToMarkdown(blocks: IRBlock[]): string;

/** kordoc 공용 유틸리티 */
declare const VERSION: string;

/**
 * 파일 버퍼를 자동 감지하여 Markdown으로 변환
 *
 * @example
 * ```ts
 * import { parse } from "kordoc"
 * // 파일 경로로 파싱
 * const result = await parse("document.hwp")
 * // 또는 Buffer로 파싱
 * const result = await parse(buffer)
 * ```
 */
declare function parse(input: string | ArrayBuffer | Buffer, options?: ParseOptions): Promise<ParseResult>;
/** HWP 3.x (구버전 한컴 워드프로세서) 파일을 Markdown 으로 변환. */
declare function parseHwp3(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** HWPX 파일을 Markdown으로 변환 */
declare function parseHwpx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** HWP 5.x 바이너리 파일을 Markdown으로 변환 */
declare function parseHwp(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** PDF 파일에서 텍스트를 추출하여 Markdown으로 변환 */
declare function parsePdf(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** XLSX 파일을 Markdown으로 변환 */
declare function parseXlsx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** XLS (Excel 97-2003) 파일을 Markdown으로 변환 */
declare function parseXls(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** DOCX 파일을 Markdown으로 변환 */
declare function parseDocx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** HWPML (XML 기반 한컴 문서) 파일을 Markdown으로 변환 */
declare function parseHwpml(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/**
 * 서식 채우기 출력 포맷
 * - "markdown": 마크다운 텍스트
 * - "hwpx": 새로 생성한 HWPX (스타일 초기화)
 * - "hwpx-preserve": 원본 HWPX ZIP 직접 수정 (스타일 100% 보존, HWPX 입력만 가능)
 */
type FillOutputFormat = "markdown" | "hwpx" | "hwpx-preserve";
/** 서식 채우기 결과 */
interface FillFormOutput {
    /** 채워진 문서 (markdown: string, hwpx/hwpx-preserve: ArrayBuffer) */
    output: string | ArrayBuffer;
    /** 출력 포맷 */
    format: FillOutputFormat;
    /** 채우기 상세 — filled 필드 목록 + unmatched 라벨 */
    fill: {
        filled: FormField[];
        unmatched: string[];
    };
}
/**
 * 서식 문서를 파싱하여 필드를 채우고, 원하는 포맷으로 출력.
 *
 * - "hwpx-preserve": HWPX 입력 → 원본 ZIP XML 직접 수정 (테두리/폰트/병합 등 100% 보존)
 * - "hwpx": 아무 포맷 → IRBlock → Markdown → HWPX 생성 (스타일 초기화됨)
 * - "markdown": 아무 포맷 → IRBlock → Markdown
 *
 * @example
 * ```ts
 * // HWPX 원본 스타일 보존 채우기
 * const result = await fillForm("신청서.hwpx", { "성명": "홍길동" }, "hwpx-preserve")
 * writeFileSync("결과.hwpx", Buffer.from(result.output as ArrayBuffer))
 *
 * // 아무 포맷 → 마크다운 채우기
 * const result = await fillForm("신청서.hwp", { "성명": "홍길동" })
 * console.log(result.output)  // 채워진 마크다운
 * ```
 */
declare function fillForm(input: string | ArrayBuffer | Buffer, values: Record<string, FillInput>, outputFormat?: FillOutputFormat): Promise<FillFormOutput>;

export { type BlockCapability, type BlockCapabilityInfo, type BlockDiff, type BlockEdit, type BlockSourceRef, type BorderDef, type BorderFillDef, type BoundingBox, type CellCapability, type CellContext, type CellDiff, type CellProfile, type CharPrDef, type DiffChangeType, type DiffResult, type DocumentMetadata, type DocumentQualitySummary, type ErrorCode, type ExtractedImage, type FileType, type FillFormOutput, type FillInput, type FillOutputFormat, type FillResult, type FillValue, type FormField, type FormFieldSchema, type FormFieldType, type FormResult, type FormSchemaResult, type FormatProfile, type GongmunFont, type GongmunNumbering, type GongmunOptions, type GongmunPreset, type GongmunPresetInput, type HwpxFillResult, HwpxSession, type HwpxTheme, type IRBlock, type IRBlockType, type IRCell, type IRTable, type ImageData, type InlineStyle, type MarkdownToHwpxOptions, type MeasureOptions, type OcrProvider, type OutlineItem, PRESET_ALIAS, type PageMargin, type PageQuality, type ParseFailure, type ParseOptions, type ParseResult, type ParseSuccess, type ParseWarning, type PatchOptions, type PatchResult, type PatchSkip, type PlaceSealResult, type PrintOptions, type PrintPreset, type RenderSvgOptions, type RenderSvgResult, SPACE_EM_FIXED, SPACE_EM_FONT, type ScanCell, type ScanParaKind, type ScanParagraph, type ScanTable, type SealOp, type SealPlacement, type SectionScan, type SpliceEdit, type TRange, type TableProfile, VERSION, type ValidateIssue, type ValidateResult, ValueCursor, type WarningCode, type WatchOptions, type WrapMode, type WrapResult, applySplices, blocksToMarkdown, blocksToPdf, buildParagraphSplices, buildRangeSplices, charWidthEm1000, compare, detectFormat, detectOle2Format, detectZipFormat, diffBlocks, extractFormFields, extractFormSchema, fillForm, fillFormFields, fillHwpx, fillWithUniqueGuard, fitRatioForFewerLines, formatFillValue, hwpxToProfile, inferFieldType, isHwpxFile, isLabelCell, isOldHwpFile, isPdfFile, isZipFile, markdownToHwpx, markdownToPdf, measureTextWidth, normalizeGongmunPreset, openHwpxDocument, parse, parseDocx, parseHwp, parseHwp3, parseHwpml, parseHwpx, parsePdf, parseXls, parseXlsx, patchHwp, patchHwpx, patchHwpxBlocks, placeSealHwpx, renderHtml, renderHwpxToSvg, scanSectionXml, simulateWrap, simulateWrapKeepWord, validateHwpx };
