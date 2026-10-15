// meeting-archive worker.js — Cloudflare Worker
// KV: MEETING_KV (파일+메타데이터 모두 KV 저장) / Secrets: GEMINI_API_KEY, SITE_PW

const INDEX_KEY = 'meetings-index';
const AUTH_COOKIE = 'ma_auth';

// ── 인증 ─────────────────────────────────────────────────────────────
function isAuthed(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`));
  return match && match[1] === env.SITE_PW;
}

function authResponse() {
  return new Response(JSON.stringify({ ok: false, error: '인증 필요' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// ── KV 인덱스 헬퍼 ────────────────────────────────────────────────────
async function getIndex(env) {
  const raw = await env.MEETING_KV.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveIndex(env, list) {
  await env.MEETING_KV.put(INDEX_KEY, JSON.stringify(list));
}

// ── DOCX 텍스트 추출 (Workers 환경: DecompressionStream) ────────────
async function extractDocxText(arrayBuffer) {
  try {
    const uint8 = new Uint8Array(arrayBuffer);
    let pos = 0;
    const texts = [];
    while (pos < uint8.length - 4) {
      if (uint8[pos] === 0x50 && uint8[pos+1] === 0x4b &&
          uint8[pos+2] === 0x03 && uint8[pos+3] === 0x04) {
        const compression = uint8[pos+8] | (uint8[pos+9] << 8);
        const compSize    = uint8[pos+18] | (uint8[pos+19] << 8) | (uint8[pos+20] << 16) | (uint8[pos+21] << 24);
        const nameLen     = uint8[pos+26] | (uint8[pos+27] << 8);
        const extraLen    = uint8[pos+28] | (uint8[pos+29] << 8);
        const nameBytes   = uint8.slice(pos+30, pos+30+nameLen);
        const name        = new TextDecoder().decode(nameBytes);
        const dataStart   = pos + 30 + nameLen + extraLen;

        if (name === 'word/document.xml') {
          let xmlBytes;
          if (compression === 0) {
            xmlBytes = uint8.slice(dataStart, dataStart + compSize);
          } else if (compression === 8) {
            const compressed = uint8.slice(dataStart, dataStart + compSize);
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(compressed);
            writer.close();
            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const total = chunks.reduce((a, c) => a + c.length, 0);
            xmlBytes = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { xmlBytes.set(c, off); off += c.length; }
          }
          if (xmlBytes) {
            const xml = new TextDecoder('utf-8').decode(xmlBytes);
            const matches = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
            for (const m of matches) {
              const t = m.replace(/<[^>]+>/g, '').trim();
              if (t) texts.push(t);
            }
          }
          break;
        }
        pos = dataStart + compSize;
      } else {
        pos++;
      }
    }
    return texts.join(' ').substring(0, 60000);
  } catch (e) {
    return null;
  }
}

// ── Gemini 분석 ────────────────────────────────────────────────────────
async function analyzeWithGemini(env, fileBuffer, mimeType, fileName, textContent) {
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  const schema = {
    type: 'object',
    properties: {
      meetingTitle: { type: 'string' },
      meetingDate: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' } },
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

  const promptText = `당신은 회의록 분석 전문가입니다. 다음 회의록 파일을 분석해 JSON으로 반환하세요.

파일명: ${fileName}

분석 규칙:
- meetingTitle: 회의 제목. 문서에 없으면 내용 기반으로 적절히 생성
- meetingDate: 회의 날짜(YYYY-MM-DD). 없으면 빈 문자열
- attendees: 참석자 목록. 이름+직함 형태면 그대로 포함
- summary.result: 회의 결과를 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)
- summary.implications: 시사점을 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)
- summary.decisions: 결정된 사항들 개조식 목록 (각 항목 명확하게)
- summary.actionItems: 후속 조치와 담당자 (예: "마케팅팀 — 제안서 초안 작성 (~10/20)")
- tags: 핵심 키워드 5~10개
- oneLiner: 가장 핵심적인 한 줄 요약 (30자 이내)`;

  let parts;
  if (mimeType === 'application/pdf' && fileBuffer) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));
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

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errText = await res.text();
        lastErr = errText;
        if (res.status === 503 || res.status === 429) {
          await new Promise(r => setTimeout(r, 2000 * (i + 1)));
          continue;
        }
        break;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('빈 응답');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e.message;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  console.error('Gemini 분석 실패:', lastErr);
  return null;
}

// ── 업로드 처리 ────────────────────────────────────────────────────────
async function handleUpload(request, env) {
  if (!isAuthed(request, env)) return authResponse();

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json({ ok: false, error: '파일 없음' }, 400);

  const fileName = file.name;
  const fileSize = file.size;
  const ext = fileName.split('.').pop().toLowerCase();
  const mimeMap = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    hwp:  'application/x-hwp',
    hwpx: 'application/x-hwpx'
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  // 15MB 제한 (KV 25MB 한도 여유분 고려)
  if (fileSize > 15 * 1024 * 1024) {
    return json({ ok: false, error: '파일 크기는 15MB 이하만 가능합니다.' }, 400);
  }

  const supportedExts = ['pdf', 'docx', 'doc', 'hwp', 'hwpx'];
  if (!supportedExts.includes(ext)) {
    return json({ ok: false, error: 'PDF, DOCX, DOC, HWP 파일만 업로드 가능합니다.' }, 400);
  }

  const id = crypto.randomUUID();
  const arrayBuffer = await file.arrayBuffer();

  // KV에 원본 파일 저장 (ArrayBuffer → base64)
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8.slice(i, i + chunkSize));
  }
  const base64File = btoa(binary);
  await env.MEETING_KV.put(`file-${id}`, base64File);

  // Gemini 분석
  let analysis = null;
  let analysisStatus = 'ok';

  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(env, arrayBuffer, 'application/pdf', fileName, null);
    if (!analysis) analysisStatus = 'failed';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(arrayBuffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(env, null, null, fileName, textContent);
      if (!analysis) analysisStatus = 'failed';
    } else {
      analysisStatus = 'text_extract_failed';
    }
  } else if (ext === 'doc') {
    analysisStatus = 'unsupported_format';
  } else if (ext === 'hwp' || ext === 'hwpx') {
    analysisStatus = 'hwp_no_analysis';
  }

  const now = new Date().toISOString();
  const meta = {
    id, fileName, fileSize, mimeType,
    uploadedAt: now, analysisStatus,
    meetingTitle: analysis?.meetingTitle || fileName.replace(/\.[^.]+$/, ''),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || [],
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null
  };

  // KV 저장 — 개별 메타
  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  // KV 저장 — 인덱스 업데이트
  const idx = await getIndex(env);
  idx.unshift({
    id, fileName, fileSize, meetingTitle: meta.meetingTitle,
    meetingDate: meta.meetingDate, attendees: meta.attendees,
    oneLiner: meta.oneLiner, tags: meta.tags,
    uploadedAt: now, analysisStatus,
    // 카드 미리보기용 요약 (각 최대 2개)
    previewResult:       analysis?.summary?.result?.slice(0,1)       || [],
    previewImplications: analysis?.summary?.implications?.slice(0,1) || [],
    previewDecisions:    analysis?.summary?.decisions?.slice(0,1)    || []
  });
  if (idx.length > 500) idx.splice(500);
  await saveIndex(env, idx);

  return json({ ok: true, id, analysisStatus, meta });
}

// ── 회의록 목록 ───────────────────────────────────────────────────────
async function handleList(request, env) {
  if (!isAuthed(request, env)) return authResponse();
  const idx = await getIndex(env);
  return json({ ok: true, meetings: idx });
}

// ── 회의록 상세 ───────────────────────────────────────────────────────
async function handleDetail(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없는 회의록입니다.' }, 404);
  return json({ ok: true, meeting: JSON.parse(raw) });
}

// ── 파일 다운로드/미리보기 ─────────────────────────────────────────────
async function handleFile(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);

  // KV에서 base64 파일 복원
  const base64 = await env.MEETING_KV.get(`file-${id}`);
  if (!base64) return json({ ok: false, error: '파일 없음' }, 404);

  const binary = atob(base64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

  const isPreview = new URL(request.url).searchParams.get('preview') === '1';
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

// ── 회의록 삭제 ───────────────────────────────────────────────────────
async function handleDelete(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);

  await env.MEETING_KV.delete(`meeting-${id}`);
  await env.MEETING_KV.delete(`file-${id}`);

  const idx = await getIndex(env);
  await saveIndex(env, idx.filter(m => m.id !== id));

  return json({ ok: true });
}

// ── 재분석 ────────────────────────────────────────────────────────────
async function handleReanalyze(request, env, id) {
  if (!isAuthed(request, env)) return authResponse();
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);

  const base64 = await env.MEETING_KV.get(`file-${id}`);
  if (!base64) return json({ ok: false, error: 'KV 파일 없음' }, 404);

  const binary = atob(base64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
  const arrayBuffer = uint8.buffer;

  const ext = meta.fileName.split('.').pop().toLowerCase();
  let analysis = null;
  let analysisStatus = meta.analysisStatus;

  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(env, arrayBuffer, 'application/pdf', meta.fileName, null);
    if (!analysis) analysisStatus = 'failed';
    else analysisStatus = 'ok';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(arrayBuffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(env, null, null, meta.fileName, textContent);
      if (!analysis) analysisStatus = 'failed';
      else analysisStatus = 'ok';
    }
  }

  if (analysis) {
    meta.meetingTitle    = analysis.meetingTitle || meta.meetingTitle;
    meta.meetingDate     = analysis.meetingDate  || meta.meetingDate;
    meta.attendees       = analysis.attendees    || meta.attendees;
    meta.oneLiner        = analysis.oneLiner     || meta.oneLiner;
    meta.tags            = analysis.tags         || meta.tags;
    meta.summary         = analysis.summary;
    meta.analysisStatus  = 'ok';
    meta.reanalyzedAt    = new Date().toISOString();
    await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

    const idx = await getIndex(env);
    const item = idx.find(m => m.id === id);
    if (item) {
      Object.assign(item, {
        meetingTitle: meta.meetingTitle, meetingDate: meta.meetingDate,
        attendees: meta.attendees, oneLiner: meta.oneLiner,
        tags: meta.tags, analysisStatus: 'ok',
        previewResult:       analysis?.summary?.result?.slice(0,1)       || [],
        previewImplications: analysis?.summary?.implications?.slice(0,1) || [],
        previewDecisions:    analysis?.summary?.decisions?.slice(0,1)    || []
      });
      await saveIndex(env, idx);
    }
  }

  return json({ ok: true, analysisStatus, meta });
}

// ── 로그인/로그아웃 ────────────────────────────────────────────────────
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
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${AUTH_COOKIE}=; Path=/; Max-Age=0`
    }
  });
}

// ── 메인 라우터 ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    if (pathname === '/api/login'    && method === 'POST') return handleLogin(request, env);
    if (pathname === '/api/logout'   && method === 'POST') return handleLogout();
    if (pathname === '/api/upload'   && method === 'POST') return handleUpload(request, env);
    if (pathname === '/api/meetings' && method === 'GET')  return handleList(request, env);

    const detailMatch = pathname.match(/^\/api\/meetings\/([^/]+)$/);
    if (detailMatch) {
      const id = detailMatch[1];
      if (method === 'GET')    return handleDetail(request, env, id);
      if (method === 'DELETE') return handleDelete(request, env, id);
    }

    const fileMatch = pathname.match(/^\/api\/file\/([^/]+)$/);
    if (fileMatch && method === 'GET') return handleFile(request, env, fileMatch[1]);

    const reMatch = pathname.match(/^\/api\/reanalyze\/([^/]+)$/);
    if (reMatch && method === 'POST') return handleReanalyze(request, env, reMatch[1]);

    return env.ASSETS.fetch(request);
  }
};
