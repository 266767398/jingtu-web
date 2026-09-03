const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', 'public', 'js');
const names = ['openChatWithUser', 'renderPagination', 'escapeHtml', 'createContainer',
  'loadStatus', 'renderStatus', 'renderRewards', 'doCheckin', 'initEventDelegates',
  'loadAchievements', 'renderAchievements', 'formatDate', 'getComputedStyle'];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
for (const n of names) {
  const hits = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8');
    const re = new RegExp('(?:function\\s+' + n + '\\s*\\(|\\b' + n + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\())', 'g');
    let m;
    while ((m = re.exec(s))) hits.push(f + ':' + s.slice(0, m.index).split('\n').length);
  }
  console.log(n.padEnd(22), hits.length ? hits.join(', ') : '*** 全站无定义 ***');
}
