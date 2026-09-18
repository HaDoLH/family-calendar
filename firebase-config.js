/* ============================================================
   Firebase 設定
   ------------------------------------------------------------
   從 Firebase Console 取得：
   專案設定（齒輪）→ 我的應用程式 → 網頁應用程式 → firebaseConfig

   ⚠️ 這份設定會被公開（GitHub Pages 的 repo 是公開的），這是正常的 ——
   Firebase 的網頁設定值本來就設計成可公開。真正的安全靠 Firestore 規則：
   資料都放在 families/<家庭代碼>/ 底下，不知道代碼的人讀不到任何東西，
   也無法列出有哪些家庭代碼。規則內容見 README.md。
   ============================================================ */
window.FIREBASE_CONFIG = {
  apiKey:            "TODO 貼上 apiKey",
  authDomain:        "TODO 貼上 authDomain",
  projectId:         "TODO 貼上 projectId",
  storageBucket:     "TODO 貼上 storageBucket",
  messagingSenderId: "TODO 貼上 messagingSenderId",
  appId:             "TODO 貼上 appId"
};
