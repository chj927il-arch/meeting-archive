// meeting-archive worker.js — Cloudflare Worker
// KV: MEETING_KV / Secrets: GEMINI_API_KEY, SITE_PW, GDRIVE_SERVICE_ACCOUNT, GDRIVE_FOLDER_ID
import { handleChat, RESPONSE_SCHEMA as CHAT_SCHEMA } from './chat-api.js';

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
const SESSION_COOKIE = 'ma_sess';
const SESSION_TTL = 60 * 60 * 12;      // 12시간 (쿠키는 브라우저 종료 시 삭제 — 매번 로그인)
const ADMIN_EMP_NO = 'BE210302';       // 최초 관리자 사번 (가입 시 관리자 확인 코드 = SITE_PW 필요)
const PBKDF2_ITER = 100000;

// ── 회원 등급 (열람 권한) ─────────────────────────────────────────────
// S: 대표·원장·이사·관리자 / A: 실장 / B: 팀장·센터장·부원장·부실장
// 회의록 accessLevel(S|A|B) = 열람 가능한 최저 등급. 기본값 S.
const RANK = { S: 3, A: 2, B: 1 };
const LEVEL_LABEL = { S: '대표·원장·관리자', A: '실장 이상', B: '팀장급 이상' };
function gradeFromPosition(pos) {
  const p = String(pos || '').split('/')[0].trim();
  if (/^대표/.test(p) || p === '원장' || /이사$/.test(p)) return 'S';
  if (p === '실장') return 'A';
  if (['팀장', '센터장', '부원장', '부실장'].includes(p)) return 'B';
  return null;
}
// 사내 명부: KV 'roster' = { 사번: [이름, 소속, 직책, 등급] } — 관리자 화면에서 엑셀 업로드
let _roster = null, _rosterAt = 0;
async function getRoster(env) {
  if (_roster && Date.now() - _rosterAt < 60000) return _roster;
  const raw = await env.MEETING_KV.get('roster');
  _roster = raw ? JSON.parse(raw) : {}; _rosterAt = Date.now();
  return _roster;
}
function userGrade(u, roster) {
  if (u.role === 'admin') return 'S';
  if (u.gradeOverride && RANK[u.gradeOverride]) return u.gradeOverride;
  const r = roster[u.empNo];
  return r && RANK[r[3]] ? r[3] : null;
}
const levelOf = m => (m && RANK[m.accessLevel]) ? m.accessLevel : 'S';
// 공개 범위에 따라 제목 앞에 자동 표시: S → (원장단), A → (실장단), B → 없음
const LEVEL_PREFIX = { S: '(원장단) ', A: '(실장단) ' };
function titleFor(title, level) {
  const base = String(title || '').replace(/^\s*(\((원장단|실장단)\)\s*)+/, '');
  return (LEVEL_PREFIX[level] || '') + base;
}
const withLevelTitle = m => (m ? { ...m, meetingTitle: titleFor(m.meetingTitle, levelOf(m)) } : m);
const canSee = (user, m) => !!user && RANK[user.grade] >= RANK[levelOf(m)];
// 요청 → 로그인 사용자 (라우터에서 확인 후 저장)
const REQ_USER = new WeakMap();
const reqUser = request => REQ_USER.get(request);
// 업로더가 고른 공개 등급 확인 (본인 등급보다 높게는 불가)
function pickLevel(user, v) {
  const lv = String(v || '').toUpperCase();
  if (!RANK[lv]) return null;
  return RANK[lv] > RANK[user.grade] ? user.grade : lv;
}
const nameKey = s => String(s || '').replace(/[A-Z]$/, '').replace(/\s+/g, '');

// ── 계정·세션 ─────────────────────────────────────────────────────────
// KV: user-{사번} = { empNo, name, dept, position, salt, hash, status: pending|approved|rejected|reset, role: user|admin, ... }
//     sess-{token} = 사번 (TTL 30일)
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const normEmpNo = s => String(s || '').trim().toUpperCase();

async function hashPassword(pw, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64(salt), hash: b64(bits) };
}
function sameStr(a, b) { // 길이·내용 비교 시간 일정
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function getUser(env, empNo) {
  const raw = await env.MEETING_KV.get(`user-${normEmpNo(empNo)}`);
  return raw ? JSON.parse(raw) : null;
}
const putUser = (env, u) => env.MEETING_KV.put(`user-${u.empNo}`, JSON.stringify(u));
const publicUser = (u, roster) => ({ empNo: u.empNo, name: u.name, dept: u.dept, position: u.position || '', status: u.status, role: u.role, grade: roster ? userGrade(u, roster) : (u.grade || null), gradeOverride: u.gradeOverride || null, createdAt: u.createdAt, approvedAt: u.approvedAt || null, lastLoginAt: u.lastLoginAt || null });

function getCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
// 로그인 + 승인된 사용자만 반환
async function getSessionUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const empNo = await env.MEETING_KV.get(`sess-${token}`);
  if (!empNo) return null;
  const u = await getUser(env, empNo);
  if (!u || u.status !== 'approved') return null;
  u.grade = userGrade(u, await getRoster(env));
  return u.grade ? u : null; // 등급 없는 계정은 이용 불가
}

async function handleSignup(request, env) {
  const body = await request.json().catch(() => ({}));
  const empNo = normEmpNo(body.empNo);
  const pw = String(body.password || '');
  if (!/^[A-Z0-9가-힣]{4,16}$/.test(empNo)) return json({ ok: false, error: '사번은 영문·숫자·한글 4~16자로 입력해 주세요.' }, 400);
  if (!String(body.name || '').trim()) return json({ ok: false, error: '이름을 입력해 주세요.' }, 400);
  if (!pw) return json({ ok: false, error: '비밀번호를 입력해 주세요.' }, 400);
  if (pw.length > 100) return json({ ok: false, error: '비밀번호가 너무 깁니다.' }, 400);

  const isAdminSeat = empNo === ADMIN_EMP_NO;
  if (isAdminSeat && !sameStr(String(body.adminCode || ''), env.SITE_PW || '\u0000'))
    return json({ ok: false, error: '관리자 사번은 관리자 확인 코드가 필요합니다.', needAdminCode: true }, 403);

  // 사내 명부로 본인 확인 + 소속·직책·등급 자동 설정
  const roster = await getRoster(env);
  const r = roster[empNo];
  const existing = await getUser(env, empNo);
  if (!isAdminSeat) {
    if (!r || nameKey(r[0]) !== nameKey(body.name))
      return json({ ok: false, error: '사내 명부에서 사번과 이름을 확인할 수 없습니다. 다시 확인해 주세요.' }, 403);
    if (!r[3] && !existing?.gradeOverride)
      return json({ ok: false, error: '가입 대상이 아닙니다. 회의록 열람은 팀장급 이상만 가능합니다.' }, 403);
  }
  const name = r ? r[0] : String(body.name).trim().slice(0, 20);
  const dept = r ? r[1] : (existing?.dept || '');
  const position = r ? r[2] : (existing?.position || '');

  if (existing && !isAdminSeat) {
    if (existing.status === 'pending')  return json({ ok: false, error: '이미 가입 신청한 사번입니다. 관리자 승인을 기다려 주세요.' }, 409);
    if (existing.status === 'approved') return json({ ok: false, error: '이미 가입된 사번입니다. 비밀번호를 잊었다면 관리자에게 초기화를 요청하세요.' }, 409);
  }
  const { salt, hash } = await hashPassword(pw);
  const now = new Date().toISOString();
  const u = {
    ...(existing || {}), empNo, name, dept, position, salt, hash,
    failCount: 0, lockUntil: 0,
    createdAt: existing?.createdAt || now, updatedAt: now,
  };
  if (isAdminSeat) { u.status = 'approved'; u.role = 'admin'; u.approvedAt = u.approvedAt || now; }
  else if (existing?.status === 'reset') { u.status = 'approved'; } // 관리자가 초기화한 계정: 새 비밀번호 설정 후 바로 사용
  else { u.status = 'pending'; u.role = existing?.role || 'user'; delete u.approvedAt; }
  await putUser(env, u);
  const grade = userGrade(u, roster);
  return json({ ok: true, status: u.status, name, dept, position, grade, gradeLabel: grade ? LEVEL_LABEL[grade] : '' });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const empNo = normEmpNo(body.empNo);
  const u = empNo ? await getUser(env, empNo) : null;
  const fail = (msg, code = 401) => json({ ok: false, error: msg }, code);
  if (!u || !u.hash) return fail('사번 또는 비밀번호가 맞지 않습니다.');
  if (u.lockUntil && Date.now() < u.lockUntil) return fail('비밀번호를 여러 번 틀려 10분간 로그인이 잠겼습니다.', 429);
  const { hash } = await hashPassword(String(body.password || ''), u.salt);
  if (!sameStr(hash, u.hash)) {
    u.failCount = (u.failCount || 0) + 1;
    if (u.failCount >= 5) { u.lockUntil = Date.now() + 10 * 60 * 1000; u.failCount = 0; }
    await putUser(env, u);
    return fail('사번 또는 비밀번호가 맞지 않습니다.');
  }
  if (u.status === 'pending')  return json({ ok: false, status: 'pending',  error: '가입 승인 대기 중입니다. 관리자 승인 후 이용할 수 있어요.' }, 403);
  if (u.status === 'rejected') return json({ ok: false, status: 'rejected', error: '가입 신청이 반려되었습니다. 관리자에게 문의해 주세요.' }, 403);
  if (u.status === 'reset')    return json({ ok: false, status: 'reset',    error: '비밀번호가 초기화되었습니다. 회원가입 화면에서 같은 사번으로 새 비밀번호를 설정해 주세요.' }, 403);
  u.failCount = 0; u.lockUntil = 0; u.lastLoginAt = new Date().toISOString();
  await putUser(env, u);
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.MEETING_KV.put(`sess-${token}`, u.empNo, { expirationTtl: SESSION_TTL });
  return new Response(JSON.stringify({ ok: true, user: publicUser(u, await getRoster(env)) }), {
    headers: {
      'Content-Type': 'application/json',
      // Max-Age 없음 = 브라우저를 닫으면 쿠키 삭제 → 다시 로그인
      'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`
    }
  });
}

async function handleLogout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.MEETING_KV.delete(`sess-${token}`);
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  h.append('Set-Cookie', `ma_auth=; Path=/; Max-Age=0`); // 예전 공용 비밀번호 쿠키 정리
  return new Response(JSON.stringify({ ok: true }), { headers: h });
}

async function handleMe(request, env) {
  const u = await getSessionUser(request, env);
  if (!u) return authResponse();
  const out = { ok: true, user: publicUser(u, await getRoster(env)), levelLabels: LEVEL_LABEL };
  if (u.role === 'admin') {
    const list = await env.MEETING_KV.list({ prefix: 'user-' });
    let pending = 0;
    for (const k of list.keys) { const x = await env.MEETING_KV.get(k.name); if (x && JSON.parse(x).status === 'pending') pending++; }
    out.pendingCount = pending;
  }
  return json(out);
}

async function handleAdminUsers(env) {
  const list = await env.MEETING_KV.list({ prefix: 'user-' });
  const roster = await getRoster(env);
  const users = [];
  for (const k of list.keys) { const x = await env.MEETING_KV.get(k.name); if (x) users.push(publicUser(JSON.parse(x), roster)); }
  users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const counts = { S: 0, A: 0, B: 0 };
  Object.values(roster).forEach(r => { if (counts[r[3]] !== undefined) counts[r[3]]++; });
  return json({ ok: true, users, roster: { total: Object.keys(roster).length, counts, updatedAt: roster.__updatedAt || null } });
}

// 사내 명부 업로드 (관리자) — 브라우저에서 엑셀을 읽어 [{dept, empNo, name, position}] 전송
async function handleAdminRoster(request, env) {
  const { rows } = await request.json().catch(() => ({}));
  if (!Array.isArray(rows) || !rows.length) return json({ ok: false, error: '명부 데이터가 비어 있습니다.' }, 400);
  const out = {};
  for (const row of rows) {
    const emp = normEmpNo(row.empNo);
    const name = String(row.name || '').trim();
    if (!/^[A-Z0-9가-힣]{4,16}$/.test(emp) || !name) continue;
    const pos = String(row.position || '').split('/')[0].trim();
    const grade = gradeFromPosition(pos);
    const dept = String(row.dept || '').split('>').map(s => s.trim()).filter(Boolean).pop() || '';
    const cur = out[emp];
    // 한 사람이 여러 번 나오면 가장 높은 등급(겸직) 사용
    if (!cur || (RANK[grade] || 0) > (RANK[cur[3]] || 0))
      out[emp] = [name.replace(/[A-Z]$/, ''), dept, pos === '-' ? '' : pos, grade];
  }
  const n = Object.keys(out).length;
  if (n < 5) return json({ ok: false, error: '사번·이름 열을 찾지 못했습니다. 명부 형식을 확인해 주세요.' }, 400);
  out.__updatedAt = new Date().toISOString();
  await env.MEETING_KV.put('roster', JSON.stringify(out));
  _roster = out; _rosterAt = Date.now();
  const counts = { S: 0, A: 0, B: 0, none: 0 };
  Object.entries(out).forEach(([k, r]) => { if (k !== '__updatedAt') counts[r[3] || 'none']++; });
  return json({ ok: true, total: n, counts });
}

async function handleAdminUserAction(request, env, admin, empNo) {
  const { action, grade } = await request.json().catch(() => ({}));
  const u = await getUser(env, empNo);
  if (!u) return json({ ok: false, error: '없는 사번입니다.' }, 404);
  const self = u.empNo === admin.empNo;
  if (self && ['reject', 'delete', 'revokeAdmin', 'reset'].includes(action))
    return json({ ok: false, error: '본인 계정에는 할 수 없는 작업입니다.' }, 400);
  const now = new Date().toISOString();
  if (action === 'approve')      { u.status = 'approved'; u.approvedAt = now; u.approvedBy = admin.empNo; }
  else if (action === 'reject')  { u.status = 'rejected'; }
  else if (action === 'reset')   { u.status = 'reset'; u.hash = null; u.salt = null; }
  else if (action === 'makeAdmin')   { if (u.status !== 'approved') return json({ ok: false, error: '승인된 회원만 관리자로 지정할 수 있습니다.' }, 400); u.role = 'admin'; }
  else if (action === 'revokeAdmin') { u.role = 'user'; }
  else if (action === 'setGrade') { if (grade && !RANK[grade]) return json({ ok: false, error: '등급 오류' }, 400); if (grade) u.gradeOverride = grade; else delete u.gradeOverride; }
  else if (action === 'delete')  { await env.MEETING_KV.delete(`user-${u.empNo}`); return json({ ok: true }); }
  else return json({ ok: false, error: '알 수 없는 작업' }, 400);
  u.updatedAt = now;
  await putUser(env, u);
  return json({ ok: true, user: publicUser(u, await getRoster(env)) });
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
const TEXT_EXTS = ['md', 'markdown', 'txt'];
// UTF-8 우선, 깨지면 한국어 윈도우 메모장(EUC-KR/CP949)으로 다시 읽기
function decodeText(arrayBuffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer).replace(/^\uFEFF/, ''); }
  catch { try { return new TextDecoder('euc-kr').decode(arrayBuffer); } catch { return new TextDecoder().decode(arrayBuffer); } }
}
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
        agenda: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title:  { type: 'string' },
              points: { type: 'array', items: { type: 'string' } }
            },
            required: ['title', 'points']
          }
        },
        implications: { type: 'array', items: { type: 'string' } },
        decisions:    { type: 'array', items: { type: 'string' } },
        actionItems:  { type: 'array', items: { type: 'string' } }
      },
      required: ['result', 'agenda', 'implications', 'decisions', 'actionItems']
    },
    tags:            { type: 'array', items: { type: 'string' } },
    oneLiner:        { type: 'string' },
    nextMeetingDate: { type: 'string' },
    uncertainTerms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term:       { type: 'string' },
          suggestion: { type: 'string' },
          reason:     { type: 'string' }
        },
        required: ['term', 'reason']
      }
    }
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
[요약 작성 원칙 — 회의에 참석하지 않은 사람이 이 회의록만 읽고도 무엇이 왜 논의·결정됐는지 파악할 수 있을 만큼 밀도 있게]
- 모든 항목은 개조식(명사형/음슴체 종결). 막연한 표현("논의함", "검토 필요") 단독 사용 금지 — 무엇을·왜·어떻게를 담을 것.
- 회의에 나온 숫자·금액·비율·날짜·기한·고유명사(사람·팀·브랜드·경쟁사·제품명)는 빠짐없이 그대로 살릴 것.
- 내용에 없는 사실을 지어내지 말 것.
- summary.result: 회의 결과·핵심 내용 4~7개 (각 30~70자, 구체 수치/대상/일정 포함)
- summary.agenda: 회의에서 다룬 안건(주제)별 상세 논의. 안건 수는 실제 회의 흐름대로(보통 2~6개). title은 안건명(20자 이내), points는 해당 안건의 논의 내용 3~6개(각 30~90자) — 현황·문제 제기, 제시된 의견·근거, 대안·반론, 합의 방향 순으로 맥락이 드러나게
- summary.implications: 시사점 3~5개 (각 30~70자, "무엇 때문에 → 무엇이 필요/우려"처럼 근거와 영향을 함께)
- summary.decisions: 확정된 결정사항 전부 (각 항목에 무엇을·언제까지·누가가 있으면 포함)
- summary.actionItems: 후속 조치 전부, 형식 "담당자 또는 팀 — 할 일 (~기한)" (예: "마케팅팀 — 겨울방학 프로모션 제안서 초안 작성 (~10/20)"), 담당·기한이 언급 안 됐으면 생략 가능
- tags: 핵심 키워드 5~10개
- oneLiner: 가장 핵심적인 한 줄 요약 (30자 이내)
- nextMeetingDate: 다음 회의 날짜(YYYY-MM-DD). "다음 회의", "다음 주 N요일", "N월 N일에 다시" 등 언급이 있으면 추출. 없으면 빈 문자열
- uncertainTerms: 반드시 위 결과(제목·참석자·요약·태그)에 실제로 적어 넣은 단어 중에서만, 정확한지 확신이 낮아 사람 확인이 필요한 것. 결과에 쓰지 않은 단어(녹음에서 들렸지만 요약에 안 넣은 말)는 절대 넣지 말 것. ${isAudio ? '발음이 불명확했던 고유명사·사람이름·브랜드/학원명·제품명·숫자/금액/날짜, 업계 약어' : '오탈자 의심 고유명사, 문맥상 의미가 모호한 약어, 숫자/금액/날짜'} 위주로 최대 8개. term은 결과에 실제로 쓴 표기 그대로, suggestion은 맞을 가능성이 높은 표기(없으면 빈 문자열), reason은 15자 이내 사유. 확실한 단어는 넣지 말 것. 없으면 빈 배열.
  ※ 참고 고유명사(아래와 정확히 같게 적은 단어는 uncertainTerms에 넣지 말 것): 이투스247, 잇올스파르타, 대성디랩, 수만휘스파르타, 수능선배, 작심스터디카페, 윈터스쿨, LMCT, LMTI, LMAT`;
}

async function callGemini(env, parts, thinkingBudget = 2048) {
  const MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
  const genConfig = {
    responseMimeType: 'application/json',
    responseSchema: GEMINI_SCHEMA,
    maxOutputTokens: 32768,
  };
  if (thinkingBudget > 0) genConfig.thinkingConfig = { thinkingBudget };
  const body = { contents: [{ parts }], generationConfig: genConfig };
  let lastErr = '';
  // 과부하(503/429) 시 대체 모델로 전환: 각 모델 2회씩
  for (let i = 0; i < MODELS.length * 2; i++) {
    const model = MODELS[Math.floor(i / 2)];
    try {
      // 스트리밍(SSE): 긴 음성 분석 시 중간 연결 100초 타임아웃(524) 회피
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const t = await res.text();
        lastErr = res.status === 503 ? 'Gemini 서버 과부하(503) — 잠시 후 재분석 버튼으로 다시 시도하세요'
                : [504, 524].includes(res.status) ? `Gemini 응답 시간 초과(${res.status}) — 재분석 버튼으로 다시 시도하세요`
                : `HTTP ${res.status}: ${t.slice(0, 200)}`;
        console.error('Gemini 오류:', model, res.status, t.slice(0, 200));
        if ([429, 500, 502, 503, 504, 524].includes(res.status)) {
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        break;
      }
      const sse = await res.text();
      let text = '', finishReason = '-', blockReason = '-';
      for (const line of sse.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const chunk = JSON.parse(line.slice(5));
          const c = chunk?.candidates?.[0];
          text += (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          if (c?.finishReason) finishReason = c.finishReason;
          if (chunk?.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
        } catch (_) {}
      }
      const cand = { finishReason };
      const data = { promptFeedback: { blockReason } };
      if (!text) {
        lastErr = `빈 응답 (finishReason=${cand?.finishReason || '-'}, block=${data?.promptFeedback?.blockReason || '-'})`;
        console.error('Gemini', lastErr);
        continue;
      }
      try { return JSON.parse(text); }
      catch (pe) {
        lastErr = `JSON 파싱 실패 (finishReason=${cand?.finishReason || '-'}, 길이=${text.length})`;
        console.error('Gemini', lastErr);
      }
    } catch (e) {
      lastErr = '네트워크 예외: ' + e.message;
      console.error('Gemini', lastErr);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(lastErr || 'Gemini 응답 없음');
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
  try { return keepUncertainInText(await callGemini(env, parts, 2048)); } catch { return null; }
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
${meta.summary?.agenda?.length ? sectionHeader('■ 안건별 상세 논의') + meta.summary.agenda.map((a, i) => `<p style="margin:8pt 0 2pt;"><b>${i + 1}. ${esc(a.title)}</b></p>` + listHtml(a.points || [])).join('') : ''}
${meta.summary?.implications?.length ? sectionHeader('■ 시사점') + listHtml(meta.summary.implications) : ''}
${meta.summary?.decisions?.length ? sectionHeader('■ 핵심 결정사항') + listHtml(meta.summary.decisions) : ''}
${meta.summary?.actionItems?.length ? sectionHeader('■ 후속 조치') + listHtml(meta.summary.actionItems) : ''}
${meta.tags?.length ? `<p class="tags">🏷️ 키워드: ${meta.tags.map(t=>esc(t)).join(' · ')}</p>` : ''}
<p class="footer">본 문서는 AI(Gemini 3.8 Flash)가 분석하여 자동 생성한 회의록입니다.</p>
</body>
</html>`;
}

// ── 오디오 분석 (fileUri 방식) ────────────────────────────────────────
// 결과 본문에 실제로 없는 불확실 단어는 제거 (고칠 대상이 없으므로)
function keepUncertainInText(analysis) {
  if (!analysis || !Array.isArray(analysis.uncertainTerms)) return analysis;
  const s = analysis.summary || {};
  const text = [analysis.meetingTitle, analysis.oneLiner, ...(analysis.attendees || []), ...(analysis.tags || []),
    ...(s.result || []), ...(s.implications || []), ...(s.decisions || []), ...(s.actionItems || []),
    ...(s.agenda || []).flatMap(a => [a.title, ...(a.points || [])])]
    .join(' ').replace(/\s+/g, '');
  const has = w => !!w && !!w.replace(/\s+/g, '') && text.includes(w.replace(/\s+/g, ''));
  analysis.uncertainTerms = analysis.uncertainTerms.filter(u => has(u.term) || has(u.suggestion));
  return analysis;
}

async function analyzeAudioWithGemini(env, fileUri, fileName, mimeType, manualAttendees) {
  const prompt = makePrompt(fileName, true, manualAttendees);
  const parts  = [{ text: prompt }, { fileData: { mimeType, fileUri } }];
  return keepUncertainInText(await callGemini(env, parts, 0));
}

// ── 인덱스 항목 공통 생성 ─────────────────────────────────────────────
function makeIndexEntry(id, meta, analysis, extra = {}) {
  return {
    id, fileName: meta.fileName, fileSize: meta.fileSize,
    meetingTitle: meta.meetingTitle, meetingDate: meta.meetingDate,
    attendees: meta.attendees, oneLiner: meta.oneLiner,
    tags: meta.tags, uploadedAt: meta.uploadedAt, analysisStatus: meta.analysisStatus,
    team: meta.team || '', accessLevel: levelOf(meta), uploadedBy: meta.uploadedBy || null,
    previewResult:       analysis?.summary?.result?.slice(0,1)       || [],
    previewImplications: analysis?.summary?.implications?.slice(0,1) || [],
    previewDecisions:    analysis?.summary?.decisions?.slice(0,1)    || [],
    actionItems:         analysis?.summary?.actionItems               || [],
    ...extra
  };
}

// ── 문서 업로드 ───────────────────────────────────────────────────────
async function handleUpload(request, env) {

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json({ ok: false, error: '파일 없음' }, 400);
  const user = reqUser(request);
  const accessLevel = pickLevel(user, formData.get('accessLevel'));
  if (!accessLevel) return json({ ok: false, error: '공개 범위(S/A/B)를 선택해 주세요.' }, 400);

  const fileName = file.name;
  const fileSize = file.size;
  const ext      = fileName.split('.').pop().toLowerCase();

  if (fileSize > 15 * 1024 * 1024)
    return json({ ok: false, error: '파일 크기는 15MB 이하만 가능합니다.' }, 400);

  const supportedExts = ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'hwp', 'hwpx'];
  if (!supportedExts.includes(ext))
    return json({ ok: false, error: 'PDF, DOCX, DOC, MD, TXT, HWP 파일만 업로드 가능합니다.' }, 400);

  const mimeMap = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword', hwp: 'application/x-hwp', hwpx: 'application/x-hwpx',
    md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8'
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
  } else if (TEXT_EXTS.includes(ext)) {
    const textContent = decodeText(arrayBuffer);
    if (textContent.trim().length > 50) {
      analysis = await analyzeWithGemini(env, null, null, fileName, textContent, manualAttendees);
      if (!analysis) analysisStatus = 'failed';
    } else { analysisStatus = 'text_extract_failed'; }
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
    team, accessLevel, uploadedBy: { empNo: user.empNo, name: user.name },
    meetingTitle: titleFor(analysis?.meetingTitle || fileName.replace(/\.[^.]+$/, ''), accessLevel),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || (manualAttendees ? manualAttendees.split(/[,\n]/).map(s=>s.trim()).filter(Boolean) : []),
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null,
    uncertainTerms: analysis?.uncertainTerms || []
  };
  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  const idx = await getIndex(env);
  idx.unshift(makeIndexEntry(id, meta, analysis));
  if (idx.length > 500) idx.splice(500);
  await saveIndex(env, idx);

  await autoAddNextMeeting(env, analysis, meta.meetingTitle, id);

  return json({ ok: true, id, analysisStatus, meta });
}

// ── 오디오 업로드 (브라우저 → Worker → Google File API → Gemini) ──────
async function handleAudioUpload(request, env) {

  const fileName        = decodeURIComponent(request.headers.get('X-File-Name') || 'recording');
  const fileSize        = parseInt(request.headers.get('X-File-Size') || '0');
  const mimeType        = request.headers.get('Content-Type') || 'audio/mpeg';
  const team            = decodeURIComponent(request.headers.get('X-Team') || '');
  const manualAttendees = decodeURIComponent(request.headers.get('X-Manual-Attendees') || '');
  const user = reqUser(request);
  const accessLevel = pickLevel(user, request.headers.get('X-Access-Level'));
  if (!accessLevel) return json({ ok: false, error: '공개 범위(S/A/B)를 선택해 주세요.' }, 400);

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

  const { analysis, analysisError, fatal } = await geminiAudioAnalyze(env, audioBuffer, fileName, mimeType, manualAttendees);
  if (fatal) return json({ ok: false, error: fatal }, 500);
  const analysisStatus = analysis ? 'ok' : 'failed';

  // KV 저장 (오디오 원본은 저장 안 함 — 용량 문제)
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = {
    id, fileName, fileSize: audioBuffer.byteLength, mimeType, fileType: 'audio',
    uploadedAt: now, analysisStatus, analysisError, team,
    accessLevel, uploadedBy: { empNo: user.empNo, name: user.name },
    driveFileId, driveUrl,
    meetingTitle: titleFor(analysis?.meetingTitle || fileName.replace(/\.[^.]+$/, ''), accessLevel),
    meetingDate:  analysis?.meetingDate  || '',
    attendees:    analysis?.attendees    || [],
    oneLiner:     analysis?.oneLiner     || '',
    tags:         analysis?.tags         || [],
    summary:      analysis?.summary      || null,
    uncertainTerms: analysis?.uncertainTerms || [],
    hasDoc: false
  };

  if (analysis) await saveMeetingDoc(env, id, meta);

  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  const idx = await getIndex(env);
  idx.unshift(makeIndexEntry(id, meta, analysis, { fileType: 'audio' }));
  if (idx.length > 500) idx.splice(500);
  await saveIndex(env, idx);

  if (analysis) await autoAddNextMeeting(env, analysis, meta.meetingTitle, id);

  return json({ ok: true, id, analysisStatus, meta });
}

async function saveMeetingDoc(env, id, meta) {
  const docBytes = new TextEncoder().encode(generateMeetingDoc(meta));
  let binary = '';
  for (let i = 0; i < docBytes.length; i += 8192)
    binary += String.fromCharCode(...docBytes.slice(i, i + 8192));
  await env.MEETING_KV.put(`doc-${id}`, btoa(binary));
  meta.hasDoc = true;
}

async function downloadFromGDrive(env, fileId) {
  const sa = JSON.parse(env.GDRIVE_SERVICE_ACCOUNT);
  const token = await getGDriveToken(sa);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Drive 다운로드 실패: HTTP ' + res.status);
  return res.arrayBuffer();
}

// Gemini File API 업로드 → ACTIVE 대기 → 분석. 반환: { analysis, analysisError, fatal }
async function geminiAudioAnalyze(env, audioBuffer, fileName, mimeType, manualAttendees) {
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
  if (!initRes.ok) return { fatal: 'Gemini 업로드 초기화 실패: ' + await initRes.text() };
  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) return { fatal: '업로드 URL 발급 실패' };

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
  if (!uploadRes.ok) return { fatal: 'Gemini 파일 업로드 실패: ' + await uploadRes.text() };
  const fileData = await uploadRes.json();
  const fileUri  = fileData.file?.uri;
  const gName    = fileData.file?.name;
  if (!fileUri) return { fatal: '파일 URI 획득 실패' };

  // 파일이 ACTIVE가 될 때까지 대기 (최대 ~60초)
  let state = fileData.file?.state;
  for (let i = 0; state !== 'ACTIVE' && i < 30; i++) {
    if (state === 'FAILED') return { analysis: null, analysisError: 'Gemini가 음성 파일 처리에 실패함(FAILED)' };
    await new Promise(r => setTimeout(r, 2000));
    try {
      const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${gName}?key=${env.GEMINI_API_KEY}`);
      if (s.ok) state = (await s.json()).state;
    } catch (_) {}
  }
  if (state !== 'ACTIVE') return { analysis: null, analysisError: `Gemini 파일 준비 시간 초과 (state=${state})` };

  try {
    const analysis = await analyzeAudioWithGemini(env, fileUri, fileName, mimeType, manualAttendees);
    return { analysis: analysis ? correctAnalysisNames(analysis) : null, analysisError: analysis ? null : 'Gemini 응답 없음' };
  } catch (e) {
    return { analysis: null, analysisError: e.message || 'Gemini 분석 중 예외 발생' };
  }
}

// ── Word 문서 다운로드 ────────────────────────────────────────────────
async function handleDoc(request, env, id) {
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta   = JSON.parse(raw);
  if (!canSee(reqUser(request), meta)) return json({ ok: false, error: '없음' }, 404);
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
  const user = reqUser(request);
  return json({ ok: true, meetings: (await getIndex(env)).filter(m => canSee(user, m)).map(withLevelTitle) });
}

// 로그인 사용자가 열람할 수 있는 회의록 + 요약 (AI 채팅용) — 목록과 같은 권한 필터(canSee) 재사용
async function loadReadableMeetings(env, user) {
  const idx = (await getIndex(env)).filter(m => canSee(user, m) && m.analysisStatus === 'ok');
  const out = await Promise.all(idx.map(async m => {
    const raw = await env.MEETING_KV.get(`meeting-${m.id}`);
    if (!raw) return null;
    const meta = JSON.parse(raw);
    if (!canSee(user, meta)) return null; // 상세 데이터 기준으로 한 번 더 확인
    return withLevelTitle({ ...meta, actionItems: meta.summary?.actionItems || [] });
  }));
  return out.filter(Boolean);
}

// AI 채팅 호출: 업로드 분석과 같은 모델·과부하 시 대체 모델, 스트리밍으로 시간 초과 회피
async function callChatLLM(env, { system, contents }) {
  const MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] }, contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json', responseSchema: CHAT_SCHEMA },
  });
  let lastErr = '';
  for (let i = 0; i < MODELS.length * 2; i++) {
    const model = MODELS[Math.floor(i / 2)];
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        lastErr = `HTTP ${res.status}`;
        console.error('채팅 Gemini 오류:', model, res.status, t.slice(0, 300));
        if ([429, 500, 502, 503, 504, 524].includes(res.status)) { await new Promise(r => setTimeout(r, 1500)); continue; }
        i = Math.floor(i / 2) * 2 + 1; continue; // 이 모델은 건너뛰고 다음 모델로
      }
      let text = '';
      for (const line of (await res.text()).split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const c = JSON.parse(line.slice(5))?.candidates?.[0]; text += (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''); } catch {}
      }
      if (!text) { lastErr = '빈 응답'; console.error('채팅 Gemini 빈 응답:', model); continue; }
      try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} } return { answer: text }; }
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr || 'AI 응답 없음');
}

// ── 상세 ─────────────────────────────────────────────────────────────
async function handleDetail(request, env, id) {
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없는 회의록입니다.' }, 404);
  const meta = JSON.parse(raw);
  if (!canSee(reqUser(request), meta)) return json({ ok: false, error: '없는 회의록입니다.' }, 404);
  return json({ ok: true, meeting: withLevelTitle(meta) });
}

// ── 파일 다운로드 ─────────────────────────────────────────────────────
async function handleFile(request, env, id) {
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);
  if (!canSee(reqUser(request), meta)) return json({ ok: false, error: '없음' }, 404);

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
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);
  if (!canSee(reqUser(request), meta)) return json({ ok: false, error: '없음' }, 404);

  await env.MEETING_KV.delete(`meeting-${id}`);
  await env.MEETING_KV.delete(`file-${id}`);
  await env.MEETING_KV.delete(`doc-${id}`);

  const idx = await getIndex(env);
  const rest = idx.filter(m => m.id !== id);
  await saveIndex(env, rest);

  // 이 회의록에서 자동 추출된 '다음 회의' 일정도 삭제
  // (출처 ID가 없는 옛 일정은 같은 제목의 다른 회의록이 남아있지 않을 때만)
  const calRaw = await env.MEETING_KV.get('calendar-events');
  let removedEvents = 0;
  if (calRaw) {
    const events = JSON.parse(calRaw);
    const legacyTitle = `다음 회의: ${meta.meetingTitle || ''}`.trim();
    const titleStillUsed = rest.some(m => m.meetingTitle === meta.meetingTitle);
    const kept = events.filter(e => {
      if (e.sourceMeetingId) return e.sourceMeetingId !== id;
      return !(e.note === '회의록 자동 추출' && e.title === legacyTitle && !titleStillUsed);
    });
    removedEvents = events.length - kept.length;
    if (removedEvents) await env.MEETING_KV.put('calendar-events', JSON.stringify(kept));
  }
  return json({ ok: true, removedEvents });
}

// ── 회의록 편집 (PUT) ─────────────────────────────────────────────────
async function handleEdit(request, env, id) {
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);
  const user = reqUser(request);
  if (!canSee(user, meta)) return json({ ok: false, error: '없음' }, 404);

  const body = await request.json();
  // 편집 가능한 필드만 허용
  if (body.accessLevel  !== undefined) { const lv = pickLevel(user, body.accessLevel); if (lv) meta.accessLevel = lv; }
  if (body.team         !== undefined) meta.team         = body.team;
  if (body.meetingTitle !== undefined) meta.meetingTitle = body.meetingTitle;
  if (body.meetingDate  !== undefined) meta.meetingDate  = body.meetingDate;
  if (body.attendees    !== undefined) meta.attendees    = body.attendees;
  if (body.oneLiner     !== undefined) meta.oneLiner     = body.oneLiner;
  if (body.tags         !== undefined) meta.tags         = body.tags;
  // 편집 화면에 없는 요약 항목(안건별 논의 등)은 유지
  if (body.summary      !== undefined) meta.summary      = { ...(meta.summary || {}), ...body.summary };
  meta.meetingTitle = titleFor(meta.meetingTitle, levelOf(meta));
  meta.editedAt = new Date().toISOString();

  await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

  // 인덱스도 업데이트
  const idx  = await getIndex(env);
  const item = idx.find(m => m.id === id);
  if (item) {
    Object.assign(item, {
      team: meta.team || '', accessLevel: levelOf(meta),
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
  const raw = await env.MEETING_KV.get(`meeting-${id}`);
  if (!raw) return json({ ok: false, error: '없음' }, 404);
  const meta = JSON.parse(raw);
  if (!canSee(reqUser(request), meta)) return json({ ok: false, error: '없음' }, 404);

  let reqBody = {};
  try { reqBody = await request.json(); } catch {}
  const manualAttendees = reqBody.manualAttendees || '';
  // keepMeta: 사람이 확인·수정한 제목·날짜·참석자는 유지하고 요약 내용만 다시 분석
  const keep = !!reqBody.keepMeta;

  if (meta.fileType === 'audio') {
    if (!meta.driveFileId || !env.GDRIVE_SERVICE_ACCOUNT)
      return json({ ok: false, error: '원본 음성파일이 Drive에 없어 재분석할 수 없습니다. 다시 업로드해주세요.' }, 400);
    let buf;
    try { buf = await downloadFromGDrive(env, meta.driveFileId); }
    catch (e) { return json({ ok: false, error: e.message }, 500); }
    const attendees = manualAttendees || (meta.attendees || []).join(', ');
    const { analysis, analysisError, fatal } = await geminiAudioAnalyze(env, buf, meta.fileName, meta.mimeType || 'audio/mp4', attendees);
    if (fatal) return json({ ok: false, error: fatal }, 500);
    meta.reanalyzedAt = new Date().toISOString();
    if (analysis) {
      Object.assign(meta, {
        meetingTitle: titleFor(keep ? meta.meetingTitle : (analysis.meetingTitle || meta.meetingTitle), levelOf(meta)),
        meetingDate:  meta.meetingDate || analysis.meetingDate || '',
        attendees:    keep && meta.attendees?.length ? meta.attendees : (analysis.attendees?.length ? analysis.attendees : meta.attendees),
        oneLiner:     analysis.oneLiner || '',
        tags:         analysis.tags || [],
        summary:      analysis.summary,
        uncertainTerms: analysis.uncertainTerms || [],
        analysisStatus: 'ok', analysisError: null
      });
      await saveMeetingDoc(env, id, meta);
    } else {
      meta.analysisStatus = 'failed';
      meta.analysisError = analysisError;
    }
    await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));
    const idx  = await getIndex(env);
    const item = idx.find(m => m.id === id);
    if (item) Object.assign(item, makeIndexEntry(id, meta, analysis, { fileType: 'audio' }));
    await saveIndex(env, idx);
    if (analysis) await autoAddNextMeeting(env, analysis, meta.meetingTitle, id);
    return json({ ok: !!analysis, analysisStatus: meta.analysisStatus, error: analysisError, meta });
  }

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
  } else if (TEXT_EXTS.includes(ext)) {
    const textContent = decodeText(arrayBuffer);
    if (textContent.trim().length > 50) {
      analysis = await analyzeWithGemini(env, null, null, meta.fileName, textContent, manualAttendees);
      analysisStatus = analysis ? 'ok' : 'failed';
    }
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
      meetingTitle: titleFor(keep ? meta.meetingTitle : (analysis.meetingTitle || meta.meetingTitle), levelOf(meta)),
      meetingDate:  keep && meta.meetingDate ? meta.meetingDate : (analysis.meetingDate || meta.meetingDate),
      attendees:    keep && meta.attendees?.length ? meta.attendees : (analysis.attendees || meta.attendees),
      oneLiner:     analysis.oneLiner     || meta.oneLiner,
      tags:         analysis.tags         || meta.tags,
      summary:      analysis.summary,
      uncertainTerms: analysis.uncertainTerms || [],
      analysisStatus: 'ok',
      reanalyzedAt: new Date().toISOString()
    });
    await env.MEETING_KV.put(`meeting-${id}`, JSON.stringify(meta));

    const idx  = await getIndex(env);
    const item = idx.find(m => m.id === id);
    if (item) Object.assign(item, makeIndexEntry(id, meta, analysis));
    await saveIndex(env, idx);

    await autoAddNextMeeting(env, analysis, meta.meetingTitle, id);
  }

  return json({ ok: true, analysisStatus, meta });
}

// ── 로그인/로그아웃 ───────────────────────────────────────────────────
async function autoAddNextMeeting(env, analysis, meetingTitle, sourceMeetingId) {
  const nmd = analysis?.nextMeetingDate;
  if (!nmd || !/^\d{4}-\d{2}-\d{2}$/.test(nmd)) return;
  const raw = await env.MEETING_KV.get('calendar-events');
  const events = raw ? JSON.parse(raw) : [];
  const title = `다음 회의: ${meetingTitle || ''}`.trim();
  const dup = events.find(e => e.date === nmd && (e.title === title || (sourceMeetingId && e.sourceMeetingId === sourceMeetingId)));
  if (dup) { // 중복 방지 (기존 일정에 출처만 보강)
    if (sourceMeetingId && !dup.sourceMeetingId) { dup.sourceMeetingId = sourceMeetingId; await env.MEETING_KV.put('calendar-events', JSON.stringify(events)); }
    return;
  }
  events.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), title, date: nmd, note: '회의록 자동 추출', sourceMeetingId: sourceMeetingId || null, createdAt: new Date().toISOString() });
  await env.MEETING_KV.put('calendar-events', JSON.stringify(events));
}

async function handleCalEventsGet(request, env) {
  const raw = await env.MEETING_KV.get('calendar-events');
  const events = raw ? JSON.parse(raw) : [];
  // 볼 수 없는 회의록에서 자동 추출된 일정은 숨김
  const user = reqUser(request);
  const idx = await getIndex(env);
  const lv = Object.fromEntries(idx.map(m => [m.id, m]));
  const visible = e => {
    if (e.sourceMeetingId) return !lv[e.sourceMeetingId] || canSee(user, lv[e.sourceMeetingId]);
    const t = (e.title || '').match(/^다음 회의:\s*(.+)$/);
    if (!t) return true; // 직접 추가한 일정
    const same = idx.filter(m => m.meetingTitle === t[1].trim());
    return !same.length || same.some(m => canSee(user, m));
  };
  return json(events.filter(visible));
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
    if (reqUser(request)?.role !== 'admin') return json({ ok: false, error: '관리자만 사용할 수 있습니다.' }, 403);
    await env.MEETING_KV.put('todo-states', '{}');
    return json({ ok: true });
  }
  const raw = await env.MEETING_KV.get('todo-states');
  const states = raw ? JSON.parse(raw) : {};
  states[id] = col;
  await env.MEETING_KV.put('todo-states', JSON.stringify(states));
  return json({ ok: true });
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

    // 공개 API (로그인 전)
    if (pathname === '/api/login'         && method === 'POST') return handleLogin(request, env);
    if (pathname === '/api/signup'        && method === 'POST') return handleSignup(request, env);
    if (pathname === '/api/logout'        && method === 'POST') return handleLogout(request, env);
    if (pathname === '/api/me'            && method === 'GET')  return handleMe(request, env);

    // 그 외 모든 API는 승인된 회원만
    if (pathname.startsWith('/api/')) {
      const user = await getSessionUser(request, env);
      if (!user) return authResponse();
      REQ_USER.set(request, user);
      if (pathname === '/api/chat' && method === 'POST') {
        return handleChat(request, env, {
          me: { empNo: user.empNo, name: user.name, dept: user.dept, grade: user.grade, role: user.role },
          loadMeetings: () => loadReadableMeetings(env, user),          // 목록과 같은 열람 권한 필터
          loadTodoStates: async () => JSON.parse((await env.MEETING_KV.get('todo-states')) || '{}'),
          callLLM: ({ system, contents }) => callChatLLM(env, { system, contents }),
          // 시간당 호출 제한만 사용(KV). 질문 원문 감사 로그는 저장하지 않음
          kv: { get: k => k.startsWith('chat:rl:') ? env.MEETING_KV.get(k) : null,
                put: (k, v, o) => k.startsWith('chat:rl:') ? env.MEETING_KV.put(k, v, o) : null },
        });
      }
      if (pathname.startsWith('/api/admin/')) {
        if (user.role !== 'admin') return json({ ok: false, error: '관리자만 사용할 수 있습니다.' }, 403);
        if (pathname === '/api/admin/users' && method === 'GET') return handleAdminUsers(env);
        if (pathname === '/api/admin/roster' && method === 'POST') return handleAdminRoster(request, env);
        const um = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9]+)$/);
        if (um && method === 'POST') return handleAdminUserAction(request, env, user, um[1]);
        return json({ ok: false, error: '없음' }, 404);
      }
    }

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
