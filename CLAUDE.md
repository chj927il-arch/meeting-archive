# 회의록 아카이브 — CLAUDE.md

## 프로젝트 한 줄 요약
팀 공유 회의록 아카이브. PDF/DOCX/HWP 업로드 → Gemini 2.5 Flash AI 자동 분석(회의일자·참석자·핵심요약·결정사항·태그) → 목록/검색/상세/다운로드.
- **공개 URL**: 배포 후 wrangler 출력 확인
- **저장소**: (git 설정 후 기입)

## 아키텍처
- `worker.js` — Cloudflare Worker: 업로드·AI분석·CRUD API
- `server.js` — 로컬 테스트용 Express 서버 (포트 3100)
- `public/index.html` — 단일 파일 UI (vanilla JS)
- `wrangler.toml` — Cloudflare 배포 설정
- **파일 저장**: Cloudflare R2 (`meeting-files` 버킷)
- **메타데이터**: Cloudflare KV (`MEETING_KV`)

## 운영 흐름
```bash
node server.js                    # 로컬 테스트 (http://localhost:3100)
npx wrangler deploy               # Cloudflare 배포
git add . && git commit -m "수정" && git push  # GitHub 백업
```

## 배포 전 필수 작업 (처음 한 번)
1. KV 네임스페이스 생성: `npx wrangler kv namespace create MEETING_KV`
2. wrangler.toml의 `id`와 `preview_id` 교체
3. R2 버킷 생성: `npx wrangler r2 bucket create meeting-files`
4. 시크릿 등록:
   - `npx wrangler secret put GEMINI_API_KEY`
   - `npx wrangler secret put SITE_PW`  (팀 비밀번호)

## 절대 규칙
1. **AI: Gemini 2.5 Flash만** — Anthropic SDK 금지
2. **API 키는 .env의 GEMINI_API_KEY만** — 코드/커밋에 노출 금지
3. **파일 형식 지원**: PDF(AI분석+미리보기), DOCX(AI분석+텍스트미리보기), HWP(저장만)
4. **한글 파일은 UTF-8로** 작성

## 데이터 스키마 (KV)
- `meetings-index` — 전체 목록 JSON 배열 (최대 500건)
- `meeting-{uuid}` — 개별 회의록 상세
- R2 파일 경로: `files/{uuid}/{원본파일명}`

### 회의록 메타 필드
```json
{
  "id": "uuid",
  "fileName": "회의록.pdf",
  "fileSize": 102400,
  "mimeType": "application/pdf",
  "r2Key": "files/uuid/회의록.pdf",
  "uploadedAt": "ISO timestamp",
  "analysisStatus": "ok|failed|hwp_no_analysis|text_extract_failed",
  "meetingTitle": "2026년 4분기 전략 회의",
  "meetingDate": "2026-10-10",
  "attendees": ["홍길동 팀장", "이순신 대리"],
  "oneLiner": "Q4 전략 방향 확정 및 예산 승인",
  "tags": ["전략", "예산", "Q4"],
  "summary": {
    "result": "회의 결과 텍스트",
    "implications": "시사점 텍스트",
    "decisions": ["결정사항1", "결정사항2"],
    "actionItems": ["홍팀장 - 보고서 작성 (~10/20)"]
  }
}
```

## 완료된 기능
- 파일 업로드 (드래그앤드롭 + 파일선택)
- AI 자동 분석 (Gemini 2.5 Flash)
- 목록 검색 + 연도/형식 필터
- 상세 패널 (슬라이드인)
- PDF 인라인 미리보기 (iframe)
- DOCX 텍스트 미리보기 (클라이언트 사이드 ZIP 파싱)
- 원문 다운로드
- 재분석 기능
- 삭제 기능
- 팀 공유 비밀번호 로그인 (쿠키 30일)
- 모바일 반응형 (햄버거 메뉴)
