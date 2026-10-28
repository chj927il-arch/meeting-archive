// 기존 KV 인덱스에 actionItems 필드 추가 (재색인)
const { execSync } = require('child_process');
const NS = 'f7c3cfa16b6b400b977489625811575f';

function kv(cmd) {
  return JSON.parse(execSync(`npx wrangler kv key ${cmd} --namespace-id=${NS} 2>nul`, { encoding: 'utf8' }));
}

async function main() {
  const keys = kv('list').map(k => k.name).filter(k => k.startsWith('meeting-') && k !== 'meetings-index');
  console.log(`총 ${keys.length}개 회의록 재색인 중...`);

  const newIndex = [];
  for (const k of keys) {
    const m = kv(`get "${k}"`);
    const entry = {
      id: m.id,
      fileName: m.fileName, fileSize: m.fileSize,
      meetingTitle: m.meetingTitle, meetingDate: m.meetingDate,
      attendees: m.attendees, oneLiner: m.oneLiner,
      tags: m.tags, uploadedAt: m.uploadedAt, analysisStatus: m.analysisStatus,
      team: m.team || '',
      previewResult:       m.summary?.result?.slice(0,1)       || [],
      previewImplications: m.summary?.implications?.slice(0,1) || [],
      previewDecisions:    m.summary?.decisions?.slice(0,1)    || [],
      actionItems:         m.summary?.actionItems               || [],
    };
    newIndex.push(entry);
    process.stdout.write('.');
  }

  // uploadedAt 내림차순 정렬
  newIndex.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));

  const fs = require('fs');
  const tmpFile = 'C:\\meeting-archive\\scripts\\index-tmp.json';
  fs.writeFileSync(tmpFile, JSON.stringify(newIndex));

  execSync(`npx wrangler kv key put --namespace-id=${NS} meetings-index --path="${tmpFile}" 2>nul`);
  fs.unlinkSync(tmpFile);

  console.log(`\n완료: ${newIndex.length}개 인덱스 업데이트`);
}

main().catch(console.error);
