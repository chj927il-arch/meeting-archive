// meeting-archive worker.js — Cloudflare Worker
// KV: MEETING_KV / Secrets: GEMINI_API_KEY, SITE_PW

const INDEX_KEY  = 'meetings-index';
const AUTH_COOKIE = 'ma_auth';

// ── 인증 ─────────────────────────────────────────────────────────────
function isAuthed(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const match  = cookie.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`));
  return match && match[1] === env.SITE_PW;
}
function authResponse() {
  return new Response(JSON.stringify({ ok: false, error: '인증 필요' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// ── KV 인덱스 ─────────────────────────────────────────────────────────
async function getIndex(env) {
  const raw = await env.MEETING_KV.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function saveIndex(env, list) {
  await env.MEETING_KV.put(INDEX_KEY, JSON.stringify(list));
}

// ── DOCX 텍스트 추출 ──────────────────────────────────────────────────
async function extractDocxText(arrayBuffer) {
  try {
    const uint8 = new Uint8Array(arrayBuffer);
    let pos = 0;
    const texts = [];
    while (pos < uint8.length - 4) {
      if (uint8[pos]===0x50 && uint8[pos+1]===0x4b && uint8[pos+2]===0x03 && uint8[pos+3]===0x04) {
        const compression = uint8[pos+8]  | (uint8[pos+9]  << 8);
        const compSize    = uint8[pos+18] | (uint8[pos+19] << 8) | (uint8[pos+20] << 16) | (uint8[pos+21] << 24);
        const nameLen     = uint8[pos+26] | (uint8[pos+27] << 8);
        const extraLen    = uint8[pos+28] | (uint8[pos+29] << 8);
        const name        = new TextDecoder().decode(uint8.slice(pos+30, pos+30+nameLen));
        const dataStart   = pos + 30 + nameLen + extraLen;
        if (name === 'word/document.xml') {
          let xmlBytes;
          if (compression === 0) {
            xmlBytes = uint8.slice(dataStart, dataStart + compSize);
          } else if (compression === 8) {
            const ds = new DecompressionStream('deflate-raw');
            const w  = ds.writable.getWriter();
            w.write(uint8.slice(dataStart, dataStart + compSize)); w.close();
            const chunks = []; const r = ds.readable.getReader();
            while (true) { const {done, value} = await r.read(); if (done) break; chunks.push(value); }
            const tot = chunks.reduce((a,c) => a+c.length, 0);
            xmlBytes = new Uint8Array(tot); let off = 0;
            for (const c of chunks) { xmlBytes.set(c, off); off += c.length; }
          }
          if (xmlBytes) {
            const xml = new TextDecoder('utf-8').decode(xmlBytes);
            for (const m of xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []) {
              const t = m.replace(/<[^>]+>/g, '').trim();
              if (t) texts.push(t);
            }
          }
          break;
        }
        pos = dataStart + compSize;
      } else { pos++; }
    }
    return texts.join(' ').substring(0, 60000);
  } catch { return null; }
}

// ── Gemini 분석 공통 스키마/프롬프트 ─────────────────────────────────
const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    meetingTitle: { type: 'string' },
    meetingDate:  { type: 'string' },
    attendees:    { type: 'array', items: { type: 'string' } },
    summary: {
      type: 'object',
      properties: {
        result:       { type: 'array', items: { type: 'string' } },
        implications: { type: 'array', items: { type: 'string' } },
        decisions:    { type: 'array', items: { type: 'string' } },
        actionItems:  { type: 'array', items: { type: 'string' } }
      },
      required: ['result', 'implications', 'decisions', 'actionItems']
    },
    tags:     { type: 'array', items: { type: 'string' } },
    oneLiner: { type: 'string' }
  },
  required: ['meetingTitle', 'meetingDate', 'attendees', 'summary', 'tags', 'oneLiner']
};

function makePrompt(fileName, isAudio) {
  const src = isAudio
    ? '첨부된 회의 녹음 파일을 듣고'
    : '다음 회의록 파일을';
  return `당신은 회의록 분석 전문가입니다. ${src} 분석해 JSON으로 반환하세요.\n\n파일명: ${fileName}\n\n분석 규칙:\n- meetingTitle: 회의 제목. ${isAudio ? '대화에서 파악하거나' : '문서에 없으면'} 내용 기반으로 적절히 생성\n- meetingDate: 회의 날짜(YYYY-MM-DD). 없으면 빈 문자열\n- attendees: 참석자 목록. ${isAudio ? '발언자/자기소개에서 이름 추출' : '이름+직함 형태면 그대로 포함'}\n- summary.result: 회의 결과를 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)\n- summary.implications: 시사점을 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)\n- summary.decisions: 결정된 사항들 개조식 목록\n- summary.actionItems: 후속 조치와 담당자 (예: "마케팅팀 — 제안서 초안 작성 (~10/20)")\n- tags: 핵심 키워드 5~10개\n- oneLiner: 가장 핵심적인 한 줄 요약 (30자 이내)`;
}

async function callGemini(env, parts, thinkingBudget = 2048) {
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_SCHEMA,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget }
    }
  };
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        if (res.status === 503 || res.status === 429) {
          await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue;
        }
        console.error('Gemini 오류:', await res.text()); break;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('빈 응답');
      return JSON.parse(text);
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

// ── 문서 분석 ─────────────────────────────────────────────────────────
async function analyzeWithGemini(env, fileBuffer, mimeType, fileName, textContent) {
  const prompt = makePrompt(fileName, false);
  let parts;
  if (mimeType === 'application/pdf' && fileBuffer) {
    const uint8 = new Uint8Array(fileBuffer);
    let binary = '';
    for (let i = 0; i < uint8.length; i += 8192)
      binary += String.fromCharCode(...uint8.slice(i, i + 8192));
    parts = [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: btoa(binary) } }];
  } else if (textContent) {
    parts = [{ text: `${prompt}\n\n--- 회의록 내용 ---\n${textContent}` }];
  } else { return null; }
  return callGemini(env, parts, 2048);
}

// ── 회의록 Word(HTML) 문서 생성 ──────────────────────────────────────
function generateMeetingDoc(meta) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const listHtml = (items) => (items||[]).map(i => `<li>${esc(i)}</li>`).join('');

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:w="urn:schemas-microsoft-com:office:word"
  xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<!--[if gte mso 9]>
<xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml>
<![endif]-->
<style>
  @page { size: A4; margin: 2.5cm 2.5cm 2.5cm 2.5cm; }
  body {
    font-family: '맑은 고딕', 'Malgun Gothic', sans-serif;
    font-size: 11pt;
    line-height: 1.8;
    color: #111;
    width: 100%;
    max-width: 100%;
  }
  h1 { font-size: 16pt; font-weight: bold; border-bottom: 2px solid #1a1a1a; padding-bottom: 6pt; margin-bottom: 12pt; page-break-after: avoid; }
  h2 { font-size: 12pt; font-weight: bold; color: #1a56a0; margin-top: 16pt; margin-bottom: 6pt; padding-left: 8pt; border-left: 3pt solid #1a56a0; page-break-after: avoid; }
  table { border-collapse: collapse; margin-bottom: 14pt; width: 100%; table-layout: fixed; }
  td { padding: 5pt 10pt; font-size: 10.5pt; border: 1px solid #ccc; vertical-align: top; word-break: keep-all; }
  td:first-child { background: #f0f4fa; font-weight: bold; width: 22%; color: #333; }
  ul { margin: 4pt 0 4pt 18pt; padding: 0; }
  li { margin: 3pt 0; font-size: 11pt; }
  .oneliner { background: #f5f7fa; border-left: 4pt solid #1a56a0; padding: 8pt 12pt; font-size: 11pt; color: #333; margin-bottom: 14pt; font-style: italic; }
  .tags { margin-top: 16pt; font-size: 10pt; color: #666; }
  .footer { margin-top: 20pt; font-size: 9pt; color: #999; border-top: 1px solid #ddd; padding-top: 5pt; }
</style>
</head>
<body>
<h1>${esc(meta.meetingTitle)}</h1>
${meta.oneLiner ? `<div class="oneliner">${esc(meta.oneLiner)}</div>` : ''}
<table>
  <tr><td>회의 일자</td><td>${esc(meta.meetingDate || '—')}</td></tr>
  <tr><td>참석자</td><td>${esc((meta.attendees||[]).join(', ') || '—')}</td></tr>
  <tr><td>파일명</td><td>${esc(meta.fileName)}</td></tr>
  <tr><td>등록일</td><td>${esc(meta.uploadedAt?.slice(0,10) || '')}</td></tr>
</table>
${meta.summary?.result?.length ? `<h2>■ 회의 결과</h2><ul>${listHtml(meta.summary.result)}</ul>` : ''}
${meta.summary?.implications?.length ? `<h2>■ 시사점</h2><ul>${listHtml(meta.summary.implications)}</ul>` : ''}
${meta.summary?.decisions?.length ? `<h2>■ 핵심 결정사항</h2><ul>${listHtml(meta.summary.decisions)}</ul>` : ''}
${meta.summary?.actionItems?.length ? `<h2>■ 후속 조치</h2><ul>${listHtml(meta.summary.actionItems)}</ul>` : ''}
${meta.tags?.length ? `<div class="tags">키워드: ${meta.tags.map(t=>esc(t)).join(' · ')}</div>` : ''}
<div class="footer">본 문서는 AI(Gemini 2.5 Flash)가 회의 녹음을 분석하여 자동 생성한 회의록입니다.</div>
</body>
</html>`;
}

// ── 오디오 분석 (fileUri 방식) ────────────────────────────────────────
async function analyzeAudioWithGemini(env, fileUri, fileName, mimeType) {
  const prompt = makePrompt(fileName, true);
  const parts  = [{ text: prompt }, { fileData: { mimeType, fileUri } }];
  return callGemini(env, parts, 4096);
}

// ── 인덱스 항목 공통 생성 ─────────────────────────────────────────────
function makeIndexEntry(id, meta, analysis, extra = {}) {
  return {
    id, fileName: meta.fileName, fileSize: meta.fileSize,
    meetingTitle: meta.meetingTitle, meetingDate: meta.meetingDate,
    attendees: meta.attendees, oneLiner: meta.oneLiner,
    tags: meta.tags, uploadedAt: meta.uploadedAt, analysisStatus: meta.analysisStatus,
    previewResult:       analysis?.summary?.result?.slice(0,1)       || [],
    previewImplications: analysis?.summary?.implications?.slice(0,1) || [],
    previewDecisions:    analysis?.summary?.decisions?.slice(0,1)    || [],
    ...extra
  };
}

// ── 문서 업로드 ───────────────────────────────────────────────────────
async function handleUpload(request, env) {
  if (!isAuthed(request, env)) return authResponse();

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json({ ok: false, error: '파일 없음' }, 400);

  const fileName = file.name;
  const fileSize = file.size;
  const ext      = fileName.split('.').pop().toLowerCase();

  if (fileSize > 15 * 1024 * 1024)
    return json({ ok: false, error: '파일 크기는 15MB 이하만 가능합니다.' }, 400);

  const supportedExts = ['pdf', 'docx', 'doc', 'hwp', 'hwpx'];
  if (!supportedExts.includes(ext))
    return json({ ok: false, error: 'PDF, DOCX, DOC, HWP 파일만 업로드 가능합니다.' }, 400);

  const mimeMap = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword', hwp: 'application/x-hwp', hwpx: 'application/x-hwpx'
  };
  const mimeType    = mimeMap[ext] || 'application/octet-stream';
  const id          = crypto.randomUUID();
  const arrayBuffer = await file.arrayBuffer();

  // KV에 base64 파일 저장
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i += 8192)
    binary += String.fromCharCode(...uint8.slice(i, i + 8192));
  await env.MEETING_KV.put(`file-${id}`, btoa(binary));

  let analysis = null, analysisStatus = 'ok';
  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(env, arrayBuffer, 'application/pdf', fileName, null);
    if (!analysis) analysisStatus = 'failed';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(arrayBuffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(env, null, null, fileName, textContent);
      if (!analysis) analysisStatus = 'failed';
    } else { analysisStatus = 'text_extract_failed'; }
  } else if (ext === 'hwp' || ext === 'hwpx') {
    analysisStatus = 'hwp_no_analysis';
  } else {
    analysisStatus = 'unsupported_format';
  }

  const now  = new Date().toISOString();
  const meta = {
    id, fileName, fileSize, mimeType, uploadedAt: now, analysisStatus,
    meetingTitle: analysis?.meetingTitle || fileName.replace(/\.[^.]+$/, ''),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || [],
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null
  };
  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  const idx = await getIndex(env);
  idx.unshift(makeIndexEntry(id, meta, analysis));
  if (idx.length > 500) idx.splice(500);
  await saveIndex(env, idx);

  return json({ ok: true, id, analysisStatus, meta });
}

// ── 오디오 업로드 (브라우저 → Worker → Google File API → Gemini) ──────
async function handleAudioUpload(request, env) {
  if (!isAuthed(request, env)) return authResponse();

  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'recording');
  const fileSize = parseInt(request.headers.get('X-File-Size') || '0');
  const mimeType = request.headers.get('Content-Type') || 'audio/mpeg';

  // ① Google File API resumable 업로드 초기화
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}&uploadType=resumable`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { displayName: fileName } })
    }
  );
  if (!initRes.ok) {
    const err = await initRes.text();
    return json({ ok: false, error: 'Google 업로드 초기화 실패: ' + err }, 500);
  }
  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) return json({ ok: false, error: '업로드 URL 발급 실패' }, 500);

  // ② request.body를 Google로 스트리밍 전달 (메모리 버퍼링 없음)
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(fileSize),
    },
    body: request.body,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    return json({ ok: false, error: 'Google 파일 업로드 실패: ' + err }, 500);
  }
  const fileData = await uploadRes.json();
  const fileUri  = fileData.file?.uri;
  if (!fileUri) return json({ ok: false, error: '파일 URI 획득 실패' }, 500);

  // ③ Gemini 분석
  const analysis      = await analyzeAudioWithGemini(env, fileUri, fileName, mimeType);
  const analysisStatus = analysis ? 'ok' : 'failed';

  // ④ KV 저장 (오디오 원본은 저장 안 함 — 용량 문제)
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = {
    id, fileName, fileSize, mimeType, fileType: 'audio',
    uploadedAt: now, analysisStatus,
    meetingTitle: analysis?.meetingTitle || fileName.replace(/\.[^.]+$/, ''),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || [],
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null,
    hasDoc: false
  };

  // 분석 성공 시 Word 문서 생성 후 KV 저장
  if (analysis) {
    const docHtml = generateMeetingDoc(meta);
    const encoder = new TextEncoder();
    const docBytes = encoder.encode(docHtml);
    let binary = '';
    for (let i = 0; i < docBytes.length; i += 8192)
      binary += String.fromCharCode(...docBytes.slice(i, i + 8192));
    await env.MEETING_KV.put(`doc-${id}`, btoa(binary));
    meta.hasDoc = true;
  }

  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  const idx = await getIndex(env);
  idx.unshift(makeIndexEntry(id, meta, analysis, { fileType: 'audio' }));
  if (idx.length > 500) idx.splice(500);
  await saveIndex(env, idx);

  return json({ ok: true, id, analysisStatus, meta });
}

// ── Word 문서 다운로드 ────────────────────────────────────────────────
async function handleDoc(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta   = JSON.parse(raw);
  const base64 = await env.MEETING_KV.get(`doc-${id}`);
  if (!base64) return json({ ok: false, error: '문서 없음' }, 404);

  const binary = atob(base64);
  const uint8  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

  const docName = encodeURIComponent(meta.meetingTitle.replace(/[/\\:*?"<>|]/g, '_') + '.doc');
  return new Response(uint8, {
    headers: {
      'Content-Type': 'application/msword',
      'Content-Disposition': `attachment; filename="${docName}"`,
    }
  });
}

// ── 목록 ─────────────────────────────────────────────────────────────
async function handleList(request, env) {
  if (!isAuthed(request, env)) return authResponse();
  return json({ ok: true, meetings: await getIndex(env) });
}

// ── 상세 ─────────────────────────────────────────────────────────────
async function handleDetail(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없는 회의록입니다.' }, 404);
  return json({ ok: true, meeting: JSON.parse(raw) });
}

// ── 파일 다운로드 ─────────────────────────────────────────────────────
async function handleFile(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);

  if (meta.fileType === 'audio')
    return json({ ok: false, error: '음성 파일은 원본이 저장되지 않습니다.' }, 404);

  const base64 = await env.MEETING_KV.get(`file-${id}`);
  if (!base64) return json({ ok: false, error: '파일 없음' }, 404);

  const binary = atob(base64);
  const uint8  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

  const isPreview   = new URL(request.url).searchParams.get('preview') === '1';
  const disposition = isPreview && meta.mimeType === 'application/pdf'
    ? 'inline'
    : `attachment; filename="${encodeURIComponent(meta.fileName)}"`;

  return new Response(uint8, {
    headers: {
      'Content-Type': meta.mimeType,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=3600'
    }
  });
}

// ── 삭제 ─────────────────────────────────────────────────────────────
async function handleDelete(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  if (!await env.MEETING_KV.get(`meeting-${id}`)) return json({ ok: false, error: '없음' }, 404);

  await env.MEETING_KV.delete(`meeting-${id}`);
  await env.MEETING_KV.delete(`file-${id}`);

  const idx = await getIndex(env);
  await saveIndex(env, idx.filter(m => m.id !== id));
  return json({ ok: true });
}

// ── 회의록 편집 (PUT) ─────────────────────────────────────────────────
async function handleEdit(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);

  const body = await request.json();
  // 편집 가능한 필드만 허용
  if (body.meetingTitle !== undefined) meta.meetingTitle = body.meetingTitle;
  if (body.meetingDate  !== undefined) meta.meetingDate  = body.meetingDate;
  if (body.attendees    !== undefined) meta.attendees    = body.attendees;
  if (body.oneLiner     !== undefined) meta.oneLiner     = body.oneLiner;
  if (body.tags         !== undefined) meta.tags         = body.tags;
  if (body.summary      !== undefined) meta.summary      = body.summary;
  meta.editedAt = new Date().toISOString();

  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  // 인덱스도 업데이트
  const idx  = await getIndex(env);
  const item = idx.find(m => m.id === id);
  if (item) {
    Object.assign(item, {
      meetingTitle: meta.meetingTitle, meetingDate: meta.meetingDate,
      attendees: meta.attendees, oneLiner: meta.oneLiner, tags: meta.tags,
      previewResult:       meta.summary?.result?.slice(0,1)       || item.previewResult       || [],
      previewImplications: meta.summary?.implications?.slice(0,1) || item.previewImplications || [],
      previewDecisions:    meta.summary?.decisions?.slice(0,1)    || item.previewDecisions    || [],
    });
    await saveIndex(env, idx);
  }

  // 음성 파일이면 Word 문서도 재생성
  if (meta.fileType === 'audio' && meta.hasDoc) {
    const docHtml   = generateMeetingDoc(meta);
    const docBytes  = new TextEncoder().encode(docHtml);
    let binary = '';
    for (let i = 0; i < docBytes.length; i += 8192)
      binary += String.fromCharCode(...docBytes.slice(i, i + 8192));
    await env.MEETING_KV.put(`doc-${id}`, btoa(binary));
  }

  return json({ ok: true, meta });
}

// ── 재분석 ───────────────────────────────────────────────────────────
async function handleReanalyze(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);

  if (meta.fileType === 'audio')
    return json({ ok: false, error: '음성 파일은 재분석이 지원되지 않습니다. 다시 업로드해주세요.' }, 400);

  const base64 = await env.MEETING_KV.get(`file-${id}`);
  if (!base64) return json({ ok: false, error: 'KV 파일 없음' }, 404);

  const binary = atob(base64);
  const uint8  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
  const arrayBuffer = uint8.buffer;

  const ext = meta.fileName.split('.').pop().toLowerCase();
  let analysis = null, analysisStatus = meta.analysisStatus;

  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(env, arrayBuffer, 'application/pdf', meta.fileName, null);
    analysisStatus = analysis ? 'ok' : 'failed';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(arrayBuffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(env, null, null, meta.fileName, textContent);
      analysisStatus = analysis ? 'ok' : 'failed';
    }
  }

  if (analysis) {
    Object.assign(meta, {
      meetingTitle: analysis.meetingTitle || meta.meetingTitle,
      meetingDate:  analysis.meetingDate  || meta.meetingDate,
      attendees:    analysis.attendees    || meta.attendees,
      oneLiner:     analysis.oneLiner     || meta.oneLiner,
      tags:         analysis.tags         || meta.tags,
      summary:      analysis.summary,
      analysisStatus: 'ok',
      reanalyzedAt: new Date().toISOString()
    });
    await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

    const idx  = await getIndex(env);
    const item = idx.find(m => m.id === id);
    if (item) Object.assign(item, makeIndexEntry(id, meta, analysis));
    await saveIndex(env, idx);
  }

  return json({ ok: true, analysisStatus, meta });
}

// ── 로그인/로그아웃 ───────────────────────────────────────────────────
async function handleLogin(request, env) {
  const { pw } = await request.json();
  if (pw !== env.SITE_PW) return json({ ok: false, error: '비밀번호가 틀렸습니다.' }, 401);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${AUTH_COOKIE}=${env.SITE_PW}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`
    }
  });
}
async function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${AUTH_COOKIE}=; Path=/; Max-Age=0` }
  });
}

// ── 메인 라우터 ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const { pathname } = url;
    const method   = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-File-Size'
        }
      });
    }

    if (pathname === '/api/login'         && method === 'POST') return handleLogin(request, env);
    if (pathname === '/api/logout'        && method === 'POST') return handleLogout();
    if (pathname === '/api/upload'        && method === 'POST') return handleUpload(request, env);
    if (pathname === '/api/audio/upload'  && method === 'POST') return handleAudioUpload(request, env);
    if (pathname === '/api/meetings'      && method === 'GET')  return handleList(request, env);

    const detailMatch = pathname.match(/^\/api\/meetings\/([^/]+)$/);
    if (detailMatch) {
      if (method === 'GET')    return handleDetail(request, env, detailMatch[1]);
      if (method === 'DELETE') return handleDelete(request, env, detailMatch[1]);
    }

    const fileMatch = pathname.match(/^\/api\/file\/([^/]+)$/);
    if (fileMatch && method === 'GET') return handleFile(request, env, fileMatch[1]);

    const docMatch = pathname.match(/^\/api\/doc\/([^/]+)$/);
    if (docMatch && method === 'GET') return handleDoc(request, env, docMatch[1]);

    const reMatch = pathname.match(/^\/api\/reanalyze\/([^/]+)$/);
    if (reMatch && method === 'POST') return handleReanalyze(request, env, reMatch[1]);

    const editMatch = pathname.match(/^\/api\/meetings\/([^/]+)$/);
    if (editMatch && method === 'PUT') return handleEdit(request, env, editMatch[1]);

    return env.ASSETS.fetch(request);
  }
};
