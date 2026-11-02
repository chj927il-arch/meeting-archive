// meeting-archive worker.js — Cloudflare Worker
// KV: MEETING_KV / Secrets: GEMINI_API_KEY, SITE_PW, GDRIVE_SERVICE_ACCOUNT, GDRIVE_FOLDER_ID

// ── Google Drive 서비스 계정 인증 ────────────────────────────────────────
function pemToBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getGDriveToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = s => btoa(JSON.stringify(s)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const header  = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  });
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const jwt = `${input}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  return data.access_token;
}

async function uploadToGDrive(env, buffer, fileName) {
  if (!env.GDRIVE_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.GDRIVE_SERVICE_ACCOUNT);
    const token = await getGDriveToken(sa);
    const folderId = env.GDRIVE_FOLDER_ID || null;
    const metadata = { name: fileName, ...(folderId ? { parents: [folderId] } : {}) };

    // 파일명에서 mimeType 추론
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeMap = { mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg', webm:'audio/webm', aac:'audio/aac', flac:'audio/flac' };
    const mime = mimeMap[ext] || 'audio/mpeg';

    // 공유 드라이브 지원 파라미터
    const qs = 'uploadType=resumable&fields=id,webViewLink,name&supportsAllDrives=true';

    // Drive 재개 가능 업로드 초기화
    const initRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files?${qs}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(buffer.byteLength),
        },
        body: JSON.stringify(metadata)
      }
    );
    if (!initRes.ok) throw new Error('Drive 초기화 실패: ' + await initRes.text());
    const uploadUrl = initRes.headers.get('Location');

    // 파일 업로드
    const upRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Content-Length': String(buffer.byteLength) },
      body: buffer
    });
    if (!upRes.ok) throw new Error('Drive 업로드 실패: ' + await upRes.text());
    return await upRes.json(); // { id, webViewLink, name }
  } catch (e) {
    console.error('GDrive 업로드 오류:', e.message);
    return null;
  }
}

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

// ── 직원 이름 오타 교정 + 퍼지 매칭 ────────────────────────────────
// 음성 AI가 잘못 인식하는 이름 → 올바른 이름 (오타 발생시 여기에 추가)
const NAME_CORRECTIONS = {
  '백은':   '백용기',
  '정구영': '정구용',
  '이길':   '이기열',
};

function applyNameCorrections(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const [wrong, correct] of Object.entries(NAME_CORRECTIONS)) {
    result = result.replaceAll(wrong, correct);
  }
  return result;
}

// Levenshtein 거리 계산
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) { dp[i] = [i]; }
  for (let j = 0; j <= n; j++) { dp[0][j] = j; }
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// 참석자 이름 하나를 직원 명단에 퍼지 매칭
// - 명단에 정확히 있으면 그대로
// - 성 일치 후보 중 Levenshtein 거리 ≤ threshold면 교체
// - 성이 명단에 없으면 외부인으로 간주, 그대로 반환
function fuzzyMatchName(name) {
  if (!name || name.length < 2) return name;
  if (EMPLOYEE_NAMES.includes(name)) return name;
  const surname = name[0];
  const candidates = EMPLOYEE_NAMES.filter(e => e[0] === surname);
  if (candidates.length === 0) return name; // 외부인
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  // 이름 길이 2자면 거리 1 이하, 3자 이상이면 2 이하만 교체
  const threshold = name.length <= 2 ? 1 : 2;
  return bestDist <= threshold ? best : name;
}

function correctAnalysisNames(analysis) {
  if (!analysis) return analysis;
  const fix = (v) => {
    if (typeof v === 'string') return applyNameCorrections(v);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = fix(v[k]); return o; }
    return v;
  };
  const result = fix(analysis);
  // attendees 배열에만 퍼지 매칭 적용 (오타 교정 후)
  if (Array.isArray(result.attendees)) {
    result.attendees = result.attendees.map(n => fuzzyMatchName(n));
  }
  return result;
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
    tags:            { type: 'array', items: { type: 'string' } },
    oneLiner:        { type: 'string' },
    nextMeetingDate: { type: 'string' }
  },
  required: ['meetingTitle', 'meetingDate', 'attendees', 'summary', 'tags', 'oneLiner']
};

const EMPLOYEE_NAMES = ["김근욱","남웅식","이기열","강태혁","최혁준","정구용","김태현","윤희지","강민석","권현","장훈희","강민구","송의진","박숙진","신수경","김연주","조영준","주윤미","김지현","최선규","배소연","김민지","김다은","고소영","김지명","소현지","김영준","김성태","임주연","배은진","최우리","최혜민","조수연","허린","김지영","유동석","노의영","김현동","조은애","김진경","이재윤","백용기","박영준","강범석","박재완","윤슬기","최정섭","안소나","강희은","안한","최수연","이건","박선경","전우승","이장권","구남웅","전동혁","김호일","정유성","김승헌","유석호","정대희","황민영","조명석","노현영","남궁희","이동훈","김예은","석예슬","이지용","이준엽","허대영","김희정","이옥경","윤정현","윤진우","민혜종","정민호","박호연","조승희","박진현","양예지","권미진","안홍준","양성대","송현겸","주현식","송우석","박재성","고재학","안장원","전상진","이상헌","홍채범","원승욱","김경호","전대웅","변용호","백은수","한주희","정헌철","우다령","김세영","이안나","박은정","정주영","나수진","문정석","이영종","이은령","김예림","문용길","안지유","이문성","조자혜","최용준","박종박","안유정","윤하림","김소희","강인혜","이수지","주혜리","안나현","이상수","김태형","유창혜","장석진","이강훈"];

function makePrompt(fileName, isAudio, manualAttendees) {
  const src = isAudio
    ? '첨부된 회의 녹음 파일을 듣고'
    : '다음 회의록 파일을';
  const nameHint = `\n\n[이투스ECI 직원명부 — 참석자 이름을 이 목록에서 최대한 매칭하세요]\n${EMPLOYEE_NAMES.join(', ')}`;

  // 파일명에서 날짜 힌트 추출 (예: 261016 → 2026-10-16)
  const dateFromName = (() => {
    const m = fileName.match(/(\d{2})(\d{2})(\d{2})/);
    if (!m) return '';
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (y >= 20 && y <= 40 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      return `파일명에서 날짜 힌트: 20${String(y).padStart(2,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    return '';
  })();

  const attendeesRule = manualAttendees && manualAttendees.trim()
    ? `- attendees: 사용자가 직접 입력한 참석자 목록을 그대로 사용하세요 (아래 [참석자 직접 입력] 참조). 이름이 성씨만 있으면 위 직원명부에서 풀네임으로 보완하세요.`
    : `- attendees: ${isAudio
        ? '이 회의에 실제로 참석해 발언하거나 자기소개를 한 사람만 포함. 회의 중 단순히 언급된 외부인·부재자·타 부서 인원은 절대 포함하지 마세요. 성씨+직함만 들리면(예: "백 원장") 직원명부에서 해당 성씨의 풀네임으로 매칭. 직원명부에 있는 이름과 발음이 유사하면 명부의 정확한 이름으로 기재.'
        : '이 회의에 실제로 참석한 사람만 포함. 문서에 이름이 언급되더라도 참석자로 명시되지 않은 사람은 제외. 성씨만 있으면(예: "신 팀장") 직원명부에서 풀네임으로 보완. 직원명부에서 매칭되는 이름 우선 사용.'
      }`;

  const manualBlock = manualAttendees && manualAttendees.trim()
    ? `\n\n[참석자 직접 입력 — 이 목록을 attendees로 사용하고, 직원명부로 풀네임 보완]\n${manualAttendees.trim()}`
    : '';

  return `당신은 회의록 분석 전문가입니다. ${src} 분석해 JSON으로 반환하세요.

파일명: ${fileName}${dateFromName ? '\n' + dateFromName : ''}${nameHint}${manualBlock}

분석 규칙:
- meetingTitle: 회의 제목. 문서/음성의 실제 제목을 사용하되, 없으면 핵심 주제로 간결하게 생성. 연도가 내용에 언급되더라도 제목에 포함하지 말 것(예: "2023년 ..." 금지). 30자 이내.
- meetingDate: 회의 날짜(YYYY-MM-DD). 문서 내 명시된 날짜 우선. 없으면 파일명 힌트 사용. 파일명 힌트도 없으면 빈 문자열. ※ 연도는 반드시 4자리(2026 등)로, 파일명의 앞 두 자리가 연도(예: 26→2026).
${attendeesRule}
- summary.result: 회의 결과를 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)
- summary.implications: 시사점을 핵심만 뽑아 3~5개 개조식 bullet (각 항목 15~30자, 명사형으로 끝낼 것)
- summary.decisions: 결정된 사항들 개조식 목록
- summary.actionItems: 후속 조치와 담당자 (예: "마케팅팀 — 제안서 초안 작성 (~10/20)")
- tags: 핵심 키워드 5~10개
- oneLiner: 가장 핵심적인 한 줄 요약 (30자 이내)
- nextMeetingDate: 다음 회의 날짜(YYYY-MM-DD). "다음 회의", "다음 주 N요일", "N월 N일에 다시" 등 언급이 있으면 추출. 없으면 빈 문자열`;
}

async function callGemini(env, parts, thinkingBudget = 2048) {
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';
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
async function analyzeWithGemini(env, fileBuffer, mimeType, fileName, textContent, manualAttendees) {
  const prompt = makePrompt(fileName, false, manualAttendees);
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

  // Word HTML에서 border-left CSS는 미지원 → 좁은 컬럼 테이블로 대체
  const sectionHeader = (label) => `
<table width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:14pt;margin-bottom:6pt;border-collapse:collapse;">
  <tr>
    <td width="4" bgcolor="#1a56a0" style="background:#1a56a0;padding:0;font-size:1pt;">&nbsp;</td>
    <td style="padding:3pt 0 3pt 10pt;"><b><font size="3" color="#1a56a0">${esc(label)}</font></b></td>
  </tr>
</table>`;

  // 리스트: Word에서 bullet 정렬 보장을 위해 table 기반으로
  const listHtml = (items) => {
    if (!items || !items.length) return '';
    return `<table width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4pt 0 8pt 0;border-collapse:collapse;">
${items.map(i => `  <tr>
    <td width="18" valign="top" style="padding:2pt 6pt 2pt 0;font-size:11pt;color:#555;">•</td>
    <td style="padding:2pt 0;font-size:11pt;line-height:1.75;color:#111;">${esc(i)}</td>
  </tr>`).join('\n')}
</table>`;
  };

  // 한줄 요약 박스: border-left 대신 좌측 컬럼 배경색 테이블
  const onelinerBox = meta.oneLiner ? `
<table width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:14pt;border-collapse:collapse;background:#f5f7fa;">
  <tr>
    <td width="4" bgcolor="#1a56a0" style="background:#1a56a0;padding:0;font-size:1pt;">&nbsp;</td>
    <td bgcolor="#f5f7fa" style="background:#f5f7fa;padding:8pt 14pt;font-size:11pt;color:#333;font-style:italic;">${esc(meta.oneLiner)}</td>
  </tr>
</table>` : '';

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:w="urn:schemas-microsoft-com:office:word"
  xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<!--[if gte mso 9]>
<xml><w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
</w:WordDocument></xml>
<![endif]-->
<style>
  @page { size: A4; margin: 2.5cm 2.5cm 2.5cm 2.5cm; }
  body { font-family: '맑은 고딕', 'Malgun Gothic', sans-serif; font-size: 11pt; line-height: 1.8; color: #111; }
  h1 { font-size: 16pt; font-weight: bold; border-bottom: 2px solid #1a1a1a; padding-bottom: 6pt; margin-bottom: 10pt; page-break-after: avoid; }
  table.info-table { border-collapse: collapse; margin-bottom: 14pt; width: 100%; }
  table.info-table td { padding: 5pt 10pt; font-size: 10.5pt; border: 1px solid #ccc; vertical-align: top; }
  table.info-table td.lbl { background: #f0f4fa; font-weight: bold; width: 22%; color: #333; }
  .tags { margin-top: 14pt; font-size: 10pt; color: #666; }
  .footer { margin-top: 20pt; font-size: 9pt; color: #999; border-top: 1px solid #ddd; padding-top: 5pt; }
</style>
</head>
<body>
<h1>${esc(meta.meetingTitle)}</h1>
${onelinerBox}
<table class="info-table">
  <tr><td class="lbl">회의 일자</td><td>${esc(meta.meetingDate || '—')}</td></tr>
  <tr><td class="lbl">참석자</td><td>${esc((meta.attendees||[]).join(', ') || '—')}</td></tr>
  <tr><td class="lbl">파일명</td><td>${esc(meta.fileName)}</td></tr>
  <tr><td class="lbl">등록일</td><td>${esc(meta.uploadedAt?.slice(0,10) || '')}</td></tr>
</table>
${meta.summary?.result?.length ? sectionHeader('■ 회의 결과') + listHtml(meta.summary.result) : ''}
${meta.summary?.implications?.length ? sectionHeader('■ 시사점') + listHtml(meta.summary.implications) : ''}
${meta.summary?.decisions?.length ? sectionHeader('■ 핵심 결정사항') + listHtml(meta.summary.decisions) : ''}
${meta.summary?.actionItems?.length ? sectionHeader('■ 후속 조치') + listHtml(meta.summary.actionItems) : ''}
${meta.tags?.length ? `<p class="tags">🏷️ 키워드: ${meta.tags.map(t=>esc(t)).join(' · ')}</p>` : ''}
<p class="footer">본 문서는 AI(Gemini 3.8 Flash)가 분석하여 자동 생성한 회의록입니다.</p>
</body>
</html>`;
}

// ── 오디오 분석 (fileUri 방식) ────────────────────────────────────────
async function analyzeAudioWithGemini(env, fileUri, fileName, mimeType, manualAttendees) {
  const prompt = makePrompt(fileName, true, manualAttendees);
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
    team: meta.team || '',
    previewResult:       analysis?.summary?.result?.slice(0,1)       || [],
    previewImplications: analysis?.summary?.implications?.slice(0,1) || [],
    previewDecisions:    analysis?.summary?.decisions?.slice(0,1)    || [],
    actionItems:         analysis?.summary?.actionItems               || [],
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

  const manualAttendees = formData.get('manualAttendees') || '';

  let analysis = null, analysisStatus = 'ok';
  if (ext === 'pdf') {
    analysis = await analyzeWithGemini(env, arrayBuffer, 'application/pdf', fileName, null, manualAttendees);
    if (!analysis) analysisStatus = 'failed';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(arrayBuffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(env, null, null, fileName, textContent, manualAttendees);
      if (!analysis) analysisStatus = 'failed';
    } else { analysisStatus = 'text_extract_failed'; }
  } else if (ext === 'hwp' || ext === 'hwpx') {
    analysisStatus = 'hwp_no_analysis';
  } else {
    analysisStatus = 'unsupported_format';
  }

  if (analysis) analysis = correctAnalysisNames(analysis);

  const now  = new Date().toISOString();
  const team = formData.get('team') || '';
  const meta = {
    id, fileName, fileSize, mimeType, uploadedAt: now, analysisStatus,
    team,
    meetingTitle: analysis?.meetingTitle || fileName.replace(/\.[^.]+$/, ''),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || (manualAttendees ? manualAttendees.split(/[,\n]/).map(s=>s.trim()).filter(Boolean) : []),
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null
  };
  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  const idx = await getIndex(env);
  idx.unshift(makeIndexEntry(id, meta, analysis));
  if (idx.length > 500) idx.splice(500);
  await saveIndex(env, idx);

  await autoAddNextMeeting(env, analysis, meta.meetingTitle);

  return json({ ok: true, id, analysisStatus, meta });
}

// ── 오디오 업로드 (브라우저 → Worker → Google File API → Gemini) ──────
async function handleAudioUpload(request, env) {
  if (!isAuthed(request, env)) return authResponse();

  const fileName        = decodeURIComponent(request.headers.get('X-File-Name') || 'recording');
  const fileSize        = parseInt(request.headers.get('X-File-Size') || '0');
  const mimeType        = request.headers.get('Content-Type') || 'audio/mpeg';
  const team            = decodeURIComponent(request.headers.get('X-Team') || '');
  const manualAttendees = decodeURIComponent(request.headers.get('X-Manual-Attendees') || '');

  // ① 음성 파일 버퍼링 (Drive + Gemini 둘 다 전송하기 위해)
  const audioBuffer = await request.arrayBuffer();

  // ② Google Drive 업로드 (설정된 경우)
  let driveFileId  = null;
  let driveUrl     = null;
  if (env.GDRIVE_SERVICE_ACCOUNT) {
    const driveResult = await uploadToGDrive(env, audioBuffer, fileName);
    if (driveResult?.id) {
      driveFileId = driveResult.id;
      driveUrl    = driveResult.webViewLink || `https://drive.google.com/file/d/${driveResult.id}/view`;
    } else if (driveResult?._error) {
      console.error('Drive 업로드 실패:', driveResult._error);
    }
  }

  // ③ Gemini File API resumable 업로드 초기화
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}&uploadType=resumable`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(audioBuffer.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { displayName: fileName } })
    }
  );
  if (!initRes.ok) {
    const err = await initRes.text();
    return json({ ok: false, error: 'Gemini 업로드 초기화 실패: ' + err }, 500);
  }
  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) return json({ ok: false, error: '업로드 URL 발급 실패' }, 500);

  // ④ 버퍼를 Gemini로 전송
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(audioBuffer.byteLength),
    },
    body: audioBuffer,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    return json({ ok: false, error: 'Gemini 파일 업로드 실패: ' + err }, 500);
  }
  const fileData = await uploadRes.json();
  const fileUri  = fileData.file?.uri;
  if (!fileUri) return json({ ok: false, error: '파일 URI 획득 실패' }, 500);

  // ③ Gemini 분석
  const analysis      = await analyzeAudioWithGemini(env, fileUri, fileName, mimeType, manualAttendees);
  const analysisStatus = analysis ? 'ok' : 'failed';

  // ④ KV 저장 (오디오 원본은 저장 안 함 — 용량 문제)
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = {
    id, fileName, fileSize: audioBuffer.byteLength, mimeType, fileType: 'audio',
    uploadedAt: now, analysisStatus, team,
    driveFileId, driveUrl,
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
  if (body.team         !== undefined) meta.team         = body.team;
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
      team: meta.team || '',
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

  let reqBody = {};
  try { reqBody = await request.json(); } catch {}
  const manualAttendees = reqBody.manualAttendees || '';

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
    analysis = await analyzeWithGemini(env, arrayBuffer, 'application/pdf', meta.fileName, null, manualAttendees);
    analysisStatus = analysis ? 'ok' : 'failed';
  } else if (ext === 'docx') {
    const textContent = await extractDocxText(arrayBuffer);
    if (textContent && textContent.length > 50) {
      analysis = await analyzeWithGemini(env, null, null, meta.fileName, textContent, manualAttendees);
      analysisStatus = analysis ? 'ok' : 'failed';
    }
  }

  if (analysis) analysis = correctAnalysisNames(analysis);

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

    await autoAddNextMeeting(env, analysis, meta.meetingTitle);
  }

  return json({ ok: true, analysisStatus, meta });
}

// ── 로그인/로그아웃 ───────────────────────────────────────────────────
async function autoAddNextMeeting(env, analysis, meetingTitle) {
  const nmd = analysis?.nextMeetingDate;
  if (!nmd || !/^\d{4}-\d{2}-\d{2}$/.test(nmd)) return;
  const raw = await env.MEETING_KV.get('calendar-events');
  const events = raw ? JSON.parse(raw) : [];
  const title = `다음 회의: ${meetingTitle || ''}`.trim();
  if (events.some(e => e.date === nmd && e.title === title)) return; // 중복 방지
  events.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), title, date: nmd, note: '회의록 자동 추출', createdAt: new Date().toISOString() });
  await env.MEETING_KV.put('calendar-events', JSON.stringify(events));
}

async function handleCalEventsGet(request, env) {
  const raw = await env.MEETING_KV.get('calendar-events');
  return json(raw ? JSON.parse(raw) : []);
}

async function handleCalEventsPost(request, env) {
  const body = await request.json();
  const { title, date, note } = body;
  if (!title || !date) return json({ error: 'title and date required' }, 400);
  const raw = await env.MEETING_KV.get('calendar-events');
  const events = raw ? JSON.parse(raw) : [];
  const ev = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), title, date, note: note || '', createdAt: new Date().toISOString() };
  events.push(ev);
  await env.MEETING_KV.put('calendar-events', JSON.stringify(events));
  return json({ ok: true, event: ev });
}

async function handleCalEventDelete(request, env, id) {
  const raw = await env.MEETING_KV.get('calendar-events');
  let events = raw ? JSON.parse(raw) : [];
  events = events.filter(e => e.id !== id);
  await env.MEETING_KV.put('calendar-events', JSON.stringify(events));
  return json({ ok: true });
}

async function handleTodoGet(request, env) {
  const raw = await env.MEETING_KV.get('todo-states');
  const states = raw ? JSON.parse(raw) : {};
  return json(states);
}

async function handleTodoSet(request, env) {
  const { id, col } = await request.json();
  if (!id || !col) return json({ error: 'bad request' }, 400);
  if (id === '__reset__') {
    await env.MEETING_KV.put('todo-states', '{}');
    return json({ ok: true });
  }
  const raw = await env.MEETING_KV.get('todo-states');
  const states = raw ? JSON.parse(raw) : {};
  states[id] = col;
  await env.MEETING_KV.put('todo-states', JSON.stringify(states));
  return json({ ok: true });
}

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
    if (pathname === '/api/todo-states'   && method === 'GET')  return handleTodoGet(request, env);
    if (pathname === '/api/todo-states'   && method === 'POST') return handleTodoSet(request, env);
    if (pathname === '/api/cal-events'    && method === 'GET')  return handleCalEventsGet(request, env);
    if (pathname === '/api/cal-events'    && method === 'POST') return handleCalEventsPost(request, env);
    const calDelMatch = pathname.match(/^\/api\/cal-events\/([^/]+)$/);
    if (calDelMatch && method === 'DELETE') return handleCalEventDelete(request, env, calDelMatch[1]);

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
