/* ============================================================
   每日行程推播 — 由 GitHub Actions 定時執行

   流程：讀 Firestore 的行程 → 篩出今天（或明天）→ 沒有就結束
         → 有的話推給所有已訂閱的裝置

   為什麼一定要有這支程式：手機上的 JavaScript 在 App 關閉時不會執行，
   所以「排定通知」做不到，必須由外面的伺服器在時間到時推進來。

   ⚠️ 為什麼不直接照排程時間送：
   GitHub 的排程觸發實測會延遲 6～12 小時（說好 09:00，16:00 才跑），
   所以「現在幾點」不能相信排程，必須自己看時鐘。
   做法：排程改成每 30 分鐘叫一次，由這支程式判斷「現在是不是該送的
   時段、今天這一則送過了沒」，送過就記在 Firestore 裡不重複送。

   用法：node scripts/notify.js auto        ← 排程用，自己判斷時段
         node scripts/notify.js today       ← 手動強制
         node scripts/notify.js tomorrow
         node scripts/notify.js 2026-10-03  ← 指定日期，測試用
   ============================================================ */

const webpush = require('web-push');

// Firebase 的這兩個值本來就公開在 firebase-config.js，不是機密
const PROJECT_ID = 'hpschedule';
const API_KEY    = 'AIzaSyDhEO4CwitvBkc_T2YksbIKKv68HmLRR3o';
const SITE        = 'https://hadolh.github.io/family-calendar/';

const FAMILY_CODE  = process.env.FAMILY_CODE;
const VAPID_PUB    = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIV   = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJ   = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';

const ARG  = (process.argv[2] || 'auto').toLowerCase();    // auto | today | tomorrow | YYYY-MM-DD
const EXPLICIT_DATE = /^\d{4}-\d{2}-\d{2}$/.test(ARG) ? ARG : null;
let MODE = EXPLICIT_DATE ? 'today' : ARG;                  // 指定日期時措辭當成「今天」

/* 台北此刻的日期與時間。GitHub 主機是 UTC，而且排程會延遲好幾小時，
   所以一律以「執行當下的台北時間」為準。 */
function taipeiNow(){
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Taipei', hourCycle:'h23',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date:`${p.year}-${p.month}-${p.day}`, hour:+p.hour, minute:+p.minute };
}
const WEEK = ['日','一','二','三','四','五','六'];

function requireEnv(){
  const missing = ['FAMILY_CODE','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if(missing.length){
    console.error('缺少環境變數：' + missing.join(', '));
    process.exit(1);
  }
}

/* GitHub 的主機時間是 UTC，不能直接用當地時間算「今天」。
   用 Intl 取台北時區的年月日，一次解決時區和日光節約的問題。 */
function taipeiDate(offsetDays = 0){
  const now = new Date(Date.now() + offsetDays * 86400000);
  // en-CA 的格式剛好是 YYYY-MM-DD，跟資料庫存的格式一致
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/** Firestore REST 回傳的是包過型別的格式（{stringValue:"x"}），拆成普通物件 */
function plain(fields = {}){
  const out = {};
  for(const [k, v] of Object.entries(fields)){
    out[k] = v.stringValue ?? v.integerValue ?? v.doubleValue ??
             (v.booleanValue !== undefined ? v.booleanValue : undefined);
  }
  return out;
}

async function listCollection(name){
  const res = await fetch(`${base}/families/${FAMILY_CODE}/${name}?key=${API_KEY}&pageSize=300`);
  if(!res.ok) throw new Error(`讀取 ${name} 失敗：HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.documents || []).map(d => ({
    _id: d.name.split('/').pop(),
    ...plain(d.fields)
  }));
}

async function deleteDoc(name, id){
  await fetch(`${base}/families/${FAMILY_CODE}/${name}/${id}?key=${API_KEY}`, { method:'DELETE' });
}

/* 記錄「今天這一則送過了沒」。排程每 30 分鐘叫一次，
   靠這個避免同一則送很多次。 */
const LOG_PATH = `${base}/families/${FAMILY_CODE}/settings/notifyLog`;

async function readLog(){
  const res = await fetch(`${LOG_PATH}?key=${API_KEY}`);
  if(res.status === 404) return {};
  if(!res.ok) throw new Error(`讀取 notifyLog 失敗：HTTP ${res.status}`);
  return plain((await res.json()).fields);
}
async function writeLog(patch){
  const fields = {};
  const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${k}`).join('&');
  for(const [k, v] of Object.entries(patch)) fields[k] = { stringValue:String(v) };
  const res = await fetch(`${LOG_PATH}?key=${API_KEY}&${mask}`, {
    method:'PATCH',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ fields })
  });
  if(!res.ok) console.log(`  （notifyLog 寫入失敗 HTTP ${res.status}，下次可能重送）`);
}

/** auto 模式：看現在台北幾點，決定這次該送哪一則、還是什麼都不做 */
async function decideMode(){
  const now = taipeiNow();
  const log = await readLog();
  console.log(`台北現在 ${now.date} ${String(now.hour).padStart(2,'0')}:${String(now.minute).padStart(2,'0')}`);

  // 早上那則：09:00 開始送；拖過 14:00 就不送了（當天過一半了），但一樣記起來免得整天重試
  if(now.hour >= 9 && log.sentToday !== now.date){
    if(now.hour < 14) return { mode:'today', mark:{ sentToday:now.date } };
    console.log('早上那則已經拖過 14:00，今天不補送了');
    await writeLog({ sentToday:now.date });
  }
  // 晚上那則：21:00 開始送「明天的行程」
  if(now.hour >= 21 && log.sentTomorrow !== now.date){
    return { mode:'tomorrow', mark:{ sentTomorrow:now.date } };
  }
  return { mode:null };
}

function buildMessage(events, members, dateStr){
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = WEEK[new Date(y, m - 1, d).getDay()];
  const head = MODE === 'tomorrow'
    ? `明天的行程 · ${m}/${d}（週${dow}）`
    : `今天的行程 · ${m}/${d}（週${dow}）`;

  const lines = events.map(e => {
    const when  = e.time || '整天';
    const shared = !e.kind || e.kind === 'shared';
    const owner  = shared ? '共同' : ((members[e.byId] || {}).name || e.by || '');
    let line = `${when}  ${e.title}${owner ? ' · ' + owner : ''}`;
    // 備註常常正是出門前要看的那句（帶健保卡、訂房編號），太長就截斷
    if(e.note){
      const n = String(e.note).replace(/\s+/g, ' ').trim();
      line += `\n　　${n.length > 40 ? n.slice(0, 40) + '…' : n}`;
    }
    return line;
  });
  return { title: head, body: lines.join('\n') };
}

(async () => {
  requireEnv();
  webpush.setVapidDetails(VAPID_SUBJ, VAPID_PUB, VAPID_PRIV);

  let mark = null;
  if(MODE === 'auto'){
    const d = await decideMode();
    if(!d.mode){ console.log('現在不是推播時段，這次不做事'); return; }
    MODE = d.mode;
    mark = d.mark;
  }

  const target = EXPLICIT_DATE || taipeiDate(MODE === 'tomorrow' ? 1 : 0);
  console.log(`模式 ${MODE}，目標日期 ${target}（台北時間）`);

  const [allEvents, memberList] = await Promise.all([
    listCollection('events'),
    listCollection('members')
  ]);
  const members = {};
  memberList.forEach(m => { members[m._id] = m; });

  // 排序跟 App 裡一致：有時間的在前、整天的在後
  const events = allEvents
    .filter(e => e.date === target)
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));

  console.log(`行程共 ${allEvents.length} 筆，其中 ${target} 有 ${events.length} 筆`);
  if(!events.length){
    console.log('這天沒有行程，略過不推播（省額度也不惱人）');
    if(mark) await writeLog(mark);          // 這個時段算處理過了，不要每半小時再問一次
    return;
  }

  // 先把訊息組出來並印在 log 裡 —— 就算沒有訂閱也看得到「本來會送什麼」，方便除錯
  const { title, body } = buildMessage(events, members, target);
  console.log('---- 通知內容 ----\n' + title + '\n' + body + '\n------------------');

  const subs = await listCollection('pushsubs');
  if(!subs.length){
    console.log('目前沒有任何裝置訂閱通知，略過送出');
    if(mark) await writeLog(mark);
    return;
  }

  const payload = JSON.stringify({
    title, body,
    url: SITE + '#f=' + FAMILY_CODE,
    tag: 'gunli-' + MODE,
    count: events.length          // 主畫面圖示上要顯示的數字
  });

  let sent = 0, gone = 0, failed = 0;
  for(const s of subs){
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try{
      await webpush.sendNotification(sub, payload);
      sent++;
      console.log(`  ✓ 已送出 → ${s.label || s._id}`);
    }catch(err){
      // 404 / 410 表示這個訂閱已經失效（例如主畫面圖示被刪掉），清掉它
      if(err.statusCode === 404 || err.statusCode === 410){
        await deleteDoc('pushsubs', s._id);
        gone++;
        console.log(`  – 訂閱已失效，已清除 → ${s.label || s._id}`);
      }else{
        failed++;
        console.log(`  ✗ 送出失敗 → ${s.label || s._id}：HTTP ${err.statusCode} ${err.body || err.message}`);
      }
    }
  }

  console.log(`完成：成功 ${sent}、失效清除 ${gone}、失敗 ${failed}`);
  if(mark) await writeLog(mark);
  if(failed > 0) process.exitCode = 1;     // 讓 Actions 顯示紅色，方便發現問題
})().catch(err => {
  console.error('執行失敗：', err);
  process.exit(1);
});
