/* ============================================================
   Service Worker — 行程表的推播接收員

   這支程式跟網頁本身是分開跑的：App 關掉之後它還能被系統叫醒，
   所以「推播」一定要靠它。網頁裡的 JavaScript 在 App 關閉時不會執行。

   （用比喻：網頁是店面，這支是門口的信箱 —— 店打烊了信還是收得到。）
   ============================================================ */

const VERSION = 'v1';

// 裝好就立刻接手，不用等使用者關掉所有頁面
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* 收到推播。伺服器送來的內容是加密的，到這裡才解開。 */
self.addEventListener('push', event => {
  let d = {};
  try{ d = event.data ? event.data.json() : {}; }catch(err){ d = {}; }

  const title = d.title || '行程表';
  const options = {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // 同一個 tag 會覆蓋舊的，不會疊一堆重複通知
    tag: d.tag || 'gunli-daily',
    renotify: true,
    data: { url: d.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* 點通知：已經開著就把那個視窗帶到前面，沒開就開起來 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for(const w of wins){
      if(w.url.includes('/family-calendar/')){
        await w.focus();
        // 順便把它導到正確的家庭代碼網址
        if('navigate' in w && target !== './') { try{ await w.navigate(target); }catch(e){} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
