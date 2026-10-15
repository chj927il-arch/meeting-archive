// meeting-archive server.js — 로컬 테스트용 Express 서버
require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3100;
const SITE_PW = process.env.SITE_PW || 'meetingarchive2026';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 로컬 저장소
const DATA_DIR  = path.join(__dirname, 'local-data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 쿠키 파싱 ──────────────────────────────────────────────────────────
function parseCookie(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

function isAuthed(req) {
  return parseCookie(req)['ma_auth'] === SITE_PW;
}

// ── 인덱스 I/O ──────────────────────────────────────────────────────────
function getIndex() {
  if (!fs.existsSync(INDEX_FILE)) return [];
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
}
function saveIndex(list) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

// ── DOCX 텍스트 추출 ────────────────────────────────────────────────────
async function extractDocxText(buffer) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) return null;
    const xml = await xmlFile.async('text');
    const matches = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    return matches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(' ').substring(0, 60000);
  } catch {
    return null;
  }
}

// ── Gemini 분석 ────────────────────────────────────────────────────────
async function analyzeWithGemini(fileBuffer, mimeType, fileName, textContent) {
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  const schema = {
    type: 'object',
    properties: {
      meetingTitle: { type: 'string' },
      meetingDate:  { type: 'string' },
      attendees:    { type: 'array', items: { type: 'string' } },
      summary: {
        type: 'object',
        properties: {
          result:      { type: 'array', items: { type: 'string' } },
          implications:{ type: 'array', items: { type: 'string' } },
          decisions:   { type: 'array', items: { type: 'string' } },
          actionItems: { type: 'array', items: { type: 'string' } }
        },
        required: ['result', 'implications', 'decisions', 'actionItems']
      },
      tags:    { type: 'array', items: { type: 'string' } },
      oneLiner:{ type: 'string' }
    },
    required: ['meetingTitle', 'meetingDate', 'attendees', 'summary', 'tags', 'oneLiner']
  };

  const promptText = `당신은 회의록 분석 전문가입니다. 다음 회의록 파일을 분석해 JSON으로 반환하세요.

파일명: ${fileName}

분석 규칙:
- meetingTitle: 회의 제목. 문서에 없으면 내용 기반으로 적절히 생성
- meetingDate: 회의 날짜(YYYY-MM-DD). 여러 날짜 중 주요 회의일 선택. 없으면 빈 문자열
- attendees: 참석자 목록. 이름+직함 형태면 그대로 포함
- summary.result: 회의 결과를 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)
- summary.implications: 시사점을 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)
- summary.decisions: 결정된 사항들 (개조식 목록)
- summary.actionItems: 후속 조치와 담당자 (예: "마케팅팀 - 제안서 초안 작성 (~10/20)")
- tags: 핵심 키워드 5~10개
- oneLiner: 가장 핵심적인 한 줄 요약 (30자 이내)`;

  let parts;
  if (mimeType === 'application/pdf' && fileBuffer) {
    const base64 = fileBuffer.toString('base64');
    parts = [
      { text: promptText },
      { inlineData: { mimeType: 'application/pdf', data: base64 } }
    ];
  } else if (textContent) {
    parts = [{ text: `${promptText}\n\n--- 회의록 내용 ---\n${textContent}` }];
  } else {
    return null;
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 2048 }
    }
  };

  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.text();
        if (res.status === 503 || res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
        console.error('Gemini error:', err);
        break;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('빈 응답');
      return JSON.parse(text);
    } catch (e) {
      console.error('Gemini retry', i, e.message);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

// ── 로그인 ──────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { pw } = req.body;
  if (pw !== SITE_PW) return res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });
  res.cookie('ma_auth', SITE_PW, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('ma_auth');
  res.json({ ok: true });
});

// ── 업로드 ──────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  if (!req.file) return res.status(400).json({ ok: false, error: '파일 없음' });

  const { originalname, buffer, size, mimetype } = req.file;
  const ext = originalname.split('.').pop().toLowerCase();
  const supportedExts = ['pdf', 'docx', 'doc', 'hwp', 'hwpx'];
  if (!supportedExts.includes(ext)) {
    return res.status(400).json({ ok: false, error: 'PDF, DOCX, DOC, HWP 파일만 가능합니다.' });
  }

  const id = crypto.randomUUID();
  const fileDir = path.join(FILES_DIR, id);
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(path.join(fileDir, originalname), buffer);

  let analysis = null;
  let analysisStatus = 'ok';

  const mimeMap = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', hwp: 'application/x-hwp', hwpx: 'application/x-hwpx' };
  const mimeType = mimeMap[ext] || mimetype;

  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(buffer, 'application/pdf', originalname, null);
    if (!analysis) analysisStatus = 'failed';
  } else if (ext === 'docx') {
    let textContent = null;
    try {
      if (fs.existsSync(require.resolve('jszip'))) {
        textContent = await extractDocxText(buffer);
      }
    } catch {}
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(null, null, originalname, textContent);
      if (!analysis) analysisStatus = 'failed';
    } else {
      // fallback: 텍스트 추출 실패 → 바이너리 텍스트로라도 시도
      analysisStatus = 'text_extract_failed';
    }
  } else if (ext === 'hwp' || ext === 'hwpx') {
    analysisStatus = 'hwp_no_analysis';
  } else {
    analysisStatus = 'unsupported_format';
  }

  const now = new Date().toISOString();
  const meta = {
    id, fileName: originalname, fileSize: size, mimeType,
    filePath: path.join(fileDir, originalname),
    uploadedAt: now, analysisStatus,
    meetingTitle: analysis?.meetingTitle || originalname.replace(/\.[^.]+$/, ''),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || [],
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null
  };

  // 개별 저장
  fs.writeFileSync(path.join(DATA_DIR, `meeting-${id}.json`), JSON.stringify(meta, null, 2));

  // 인덱스 업데이트
  const idx = getIndex();
  idx.unshift({
    id, fileName: meta.fileName, fileSize: meta.fileSize,
    meetingTitle: meta.meetingTitle, meetingDate: meta.meetingDate,
    attendees: meta.attendees, oneLiner: meta.oneLiner,
    tags: meta.tags, uploadedAt: now, analysisStatus,
    previewResult:       analysis?.summary?.result?.slice(0,1)       || [],
    previewImplications: analysis?.summary?.implications?.slice(0,1) || [],
    previewDecisions:    analysis?.summary?.decisions?.slice(0,1)    || []
  });
  if (idx.length > 500) idx.splice(500);
  saveIndex(idx);

  res.json({ ok: true, id, analysisStatus, meta });
});

// ── 목록 ──────────────────────────────────────────────────────────────
app.get('/api/meetings', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  res.json({ ok: true, meetings: getIndex() });
});

// ── 상세 ──────────────────────────────────────────────────────────────
app.get('/api/meetings/:id', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  const f = path.join(DATA_DIR, `meeting-${req.params.id}.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false, error: '없음' });
  res.json({ ok: true, meeting: JSON.parse(fs.readFileSync(f)) });
});

// ── 파일 다운로드/미리보기 ────────────────────────────────────────────
app.get('/api/file/:id', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  const f = path.join(DATA_DIR, `meeting-${req.params.id}.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false, error: '없음' });
  const meta = JSON.parse(fs.readFileSync(f));
  if (!fs.existsSync(meta.filePath)) return res.status(404).json({ ok: false, error: '파일 없음' });

  const isPreview = req.query.preview === '1';
  const disposition = isPreview && meta.mimeType === 'application/pdf'
    ? 'inline'
    : `attachment; filename="${encodeURIComponent(meta.fileName)}"`;

  res.set('Content-Type', meta.mimeType);
  res.set('Content-Disposition', disposition);
  fs.createReadStream(meta.filePath).pipe(res);
});

// ── 삭제 ──────────────────────────────────────────────────────────────
app.delete('/api/meetings/:id', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  const metaFile = path.join(DATA_DIR, `meeting-${req.params.id}.json`);
  if (!fs.existsSync(metaFile)) return res.status(404).json({ ok: false, error: '없음' });
  const meta = JSON.parse(fs.readFileSync(metaFile));

  // 파일 삭제
  try { fs.rmSync(path.dirname(meta.filePath), { recursive: true }); } catch {}
  fs.unlinkSync(metaFile);

  // 인덱스에서 제거
  const idx = getIndex().filter(m => m.id !== req.params.id);
  saveIndex(idx);
  res.json({ ok: true });
});

// ── 재분석 ────────────────────────────────────────────────────────────
app.post('/api/reanalyze/:id', async (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  const metaFile = path.join(DATA_DIR, `meeting-${req.params.id}.json`);
  if (!fs.existsSync(metaFile)) return res.status(404).json({ ok: false, error: '없음' });
  const meta = JSON.parse(fs.readFileSync(metaFile));

  const ext = meta.fileName.split('.').pop().toLowerCase();
  const buffer = fs.readFileSync(meta.filePath);
  let analysis = null;
  let analysisStatus = meta.analysisStatus;

  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(buffer, 'application/pdf', meta.fileName, null);
    if (!analysis) analysisStatus = 'failed';
    else analysisStatus = 'ok';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(buffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(null, null, meta.fileName, textContent);
      if (!analysis) analysisStatus = 'failed';
      else analysisStatus = 'ok';
    }
  }

  if (analysis) {
    meta.meetingTitle = analysis.meetingTitle || meta.meetingTitle;
    meta.meetingDate  = analysis.meetingDate  || meta.meetingDate;
    meta.attendees    = analysis.attendees    || meta.attendees;
    meta.oneLiner     = analysis.oneLiner     || meta.oneLiner;
    meta.tags         = analysis.tags         || meta.tags;
    meta.summary      = analysis.summary;
    meta.analysisStatus = 'ok';
    meta.reanalyzedAt = new Date().toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    const idx = getIndex();
    const item = idx.find(m => m.id === req.params.id);
    if (item) {
      Object.assign(item, {
        meetingTitle: meta.meetingTitle, meetingDate: meta.meetingDate,
        attendees: meta.attendees, oneLiner: meta.oneLiner,
        tags: meta.tags, analysisStatus: 'ok'
      });
      saveIndex(idx);
    }
  }

  res.json({ ok: true, analysisStatus, meta });
});

app.listen(PORT, () => {
  console.log(`회의록 아카이브 로컬 서버: http://localhost:${PORT}`);
  console.log(`비밀번호: ${SITE_PW}`);
});
