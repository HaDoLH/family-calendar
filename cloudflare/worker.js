/* ============================================================
   準時的鬧鐘（Cloudflare Worker）

   為什麼需要它：
   GitHub Actions 的 schedule 觸發極不可靠 —— 實測延遲 6～12 小時，
   而且會大量丟棄（設定每 30 分鐘，14 小時只跑 2 次）。提醒類功能
   不能建立在這種基礎上。

   但 GitHub 的「手動觸發」（workflow_dispatch）是即時的，不排隊。
   所以這支程式只做一件事：時間到了就去按那顆按鈕。

   推播邏輯完全不動，還是跑 repo 裡的 scripts/notify.js。
   這裡只是換一個準時的人去按。

   ------------------------------------------------------------
   部署設定（在 Cloudflare 後台）
     Variables and Secrets → 新增 Secret：
       GITHUB_TOKEN = GitHub 的 fine-grained token
                      （只給 family-calendar 這個 repo，
                        權限 Actions: Read and write）
     Trigger Events → Cron Triggers → 新增兩組（UTC，台北要減 8）：
       0 1 * * *     台北 09:00 → 推「今天的行程」
       0 13 * * *    台北 21:00 → 推「明天的行程」
   ============================================================ */

const OWNER = 'HaDoLH';
const REPO  = 'family-calendar';
const WORKFLOW = 'push-notify.yml';

export default {
  async scheduled(event, env, ctx) {
    // 用哪一組 cron 觸發的，決定要推今天還是明天
    const mode = event.cron === '0 13 * * *' ? 'tomorrow' : 'today';

    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'family-calendar-cron',   // GitHub API 一定要有這個，否則 403
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode } })
    });

    // 成功是 204 No Content
    if (res.status === 204) {
      console.log(`已觸發推播：${mode}`);
    } else {
      console.log(`觸發失敗 HTTP ${res.status}：${await res.text()}`);
    }
  },

  /* 打開 Worker 網址可以手動測一次，確認 token 設定正確。
     網址後面加 ?mode=tomorrow 可指定。 */
  async fetch(request, env, ctx) {
    const mode = new URL(request.url).searchParams.get('mode') || 'today';
    await this.scheduled({ cron: mode === 'tomorrow' ? '0 13 * * *' : '0 1 * * *' }, env, ctx);
    return new Response(`已嘗試觸發：${mode}\n詳細結果看 Cloudflare 的 Logs\n`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
