// 家族クラウド（Firebase：匿名ログイン + Firestore）。端末の保存（store.js）を、家族のクラウドと同期する。
// SDK は公式の CDN から、必要になったときだけ読み込む。ネットがつながらなくても、端末の保存だけで遊べる。
// 設計とルール：artifact/firebase-plan.md、artifact/firestore.rules
(function (root) {
  // Firebase の設定。ウェブアプリでは公開される前提の値（秘密ではない）。守りは Firestore のルールで行う
  const CONFIG = {
    apiKey: 'AIzaSyC0mEdUqBg6wUli-BnUjsXCu9VcO7amVqA',
    authDomain: 'barcode-battler-84ace.firebaseapp.com',
    projectId: 'barcode-battler-84ace',
    storageBucket: 'barcode-battler-84ace.firebasestorage.app',
    messagingSenderId: '920139046695',
    appId: '1:920139046695:web:c58e1a6a321f2b481f9302',
  };
  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const KEY = 'bb-cloud';
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 読みまちがえやすい文字（i l o 0 1）を除く
  const timers = {};
  let fb = null, lastSyncAt = 0, statusText = '', onPulled = null;

  const cfg = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const saveCfg = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* 保存できなくても動く */ } };
  const setStatus = (t) => { statusText = t; if (api.onStatus) api.onStatus(t); };
  const pretty = (id) => id.replace(/(.{4})(?=.)/g, '$1-');           // k7m2x9qa4tzp → k7m2-x9qa-4tzp
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  async function sdk() {
    if (fb) return fb;
    const [A, AU, F] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
    const app = A.initializeApp(CONFIG);
    fb = { A, AU, F, app, auth: AU.getAuth(app), db: F.getFirestore(app) };
    return fb;
  }
  async function signIn() {
    const f = await sdk();
    if (f.auth.authStateReady) await f.auth.authStateReady();
    if (!f.auth.currentUser) await f.AU.signInAnonymously(f.auth);
    return f.auth.currentUser;
  }
  function explain(e) {
    const c = (e && (e.code || e.message)) || '';
    if (/configuration-not-found/.test(c)) return 'Firebaseの Authentication がまだ始まっていません（コンソールの「Authentication → 始める」を押して、「匿名」を有効にしてください）';
    if (/operation-not-allowed|admin-restricted/.test(c)) return '匿名ログインが有効になっていません（Firebaseの Authentication で「匿名」をオンにしてください）';
    if (/permission-denied/.test(c)) return '権限がありません（Firestoreのルールが公開されていないか、まだ家族に入っていません）';
    if (/unavailable|network|offline/.test(c)) return 'オフラインです（端末には保存されています。つながったときに同期します）';
    if (/unauthorized-domain/.test(c)) return 'このサイトのドメインが、Firebaseの「承認済みドメイン」に入っていません';
    return '同期できませんでした（' + c + '）';
  }

  async function pushDoc(pid, obj) {
    const f = await sdk(), fid = cfg().familyId;
    const clean = JSON.parse(JSON.stringify(obj));
    if (!clean.updatedAt) clean.updatedAt = Date.now();
    await f.F.setDoc(f.F.doc(f.db, 'families', fid, 'players', pid), clean);
  }
  // 端末とクラウドを比べて、新しい方を残す（プレイヤーごと）。{ imported, pushed } を返す
  async function syncAll() {
    const fid = cfg().familyId;
    if (!fid) return { imported: 0, pushed: 0 };
    setStatus('どうきちゅう…');
    try {
      const f = await sdk(); await signIn();
      const snap = await f.F.getDocs(f.F.collection(f.db, 'families', fid, 'players'));
      const remote = {}; snap.forEach((d) => { remote[d.id] = d.data(); });
      const local = await root.Store.exportProfiles();
      let imported = 0, pushed = 0;
      // 削除したユーザーの印を、先に送る（前にオフラインで送れなかった分）
      const c0 = cfg(), deleted = c0.deleted || {};
      for (const [id, ts] of Object.entries(deleted)) {
        try { await pushDoc(id, { deleted: true, updatedAt: ts }); delete deleted[id]; } catch (e) { /* つながったときに、また送る */ }
      }
      saveCfg({ ...c0, deleted });
      for (const id of new Set([...Object.keys(remote), ...Object.keys(local)])) {
        const r = remote[id], l = local[id];
        if (deleted[id]) continue;                                   // この端末で削除ずみ（印がまだ送れていない）：取り込まない
        if (r && r.deleted) {                                        // ほかの端末で削除された
          if (l && (r.updatedAt || 0) >= (l.updatedAt || 0)) { await root.Store.deleteProfile(id); imported++; }
          else if (l) { await pushDoc(id, l); pushed++; }            // 削除のあとに、この端末で遊んでいた：残す
          continue;
        }
        if (r && (!l || (r.updatedAt || 0) > (l.updatedAt || 0))) { await root.Store.importProfile(id, r); imported++; }
        else if (l && (!r || (l.updatedAt || 0) > (r.updatedAt || 0))) { await pushDoc(id, l); pushed++; }
      }
      lastSyncAt = Date.now();
      const t = new Date(lastSyncAt);
      setStatus(`どうきずみ ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}（うけとり${imported}／おくり${pushed}）`);
      return { imported, pushed };
    } catch (e) { setStatus(explain(e)); throw e; }
  }
  // 変更があったプレイヤーを、少しまとめてからクラウドへ送る
  function schedule(pid) {
    if (!cfg().familyId || (cfg().deleted || {})[pid]) return;
    clearTimeout(timers[pid]);
    timers[pid] = setTimeout(async () => {
      try {
        const l = await root.Store.exportProfile(pid);
        if (l) { await signIn(); await pushDoc(pid, l); lastSyncAt = Date.now(); setStatus('どうきずみ'); }
      } catch (e) { setStatus(explain(e)); }
    }, 1500);
  }
  function attach() { root.Store.onChange = schedule; }

  const api = {
    available: true,
    onStatus: null,
    status: () => statusText,
    isConnected: () => !!cfg().familyId,
    familyCode: () => (cfg().familyId ? pretty(cfg().familyId) : ''),
    syncNow: syncAll,

    // 家族につなぐ（新しい家族を作る）：家族コードを作り、いまの端末のデータをクラウドへ上げる
    async createFamily() {
      const f = await sdk(), user = await signIn();
      for (let i = 0; i < 5; i++) {
        let id = ''; const buf = new Uint32Array(12); crypto.getRandomValues(buf);
        for (const n of buf) id += ALPHABET[n % ALPHABET.length];
        const ref = f.F.doc(f.db, 'families', id);
        if ((await f.F.getDoc(ref)).exists()) continue;
        await f.F.setDoc(ref, { name: '家族', createdAt: Date.now(), members: { [user.uid]: true } });
        saveCfg({ familyId: id }); attach();
        const r = await syncAll();
        return { code: pretty(id), ...r };
      }
      throw new Error('家族コードを作れませんでした');
    },
    // 家族コードで参加：自分の端末を家族に登録して、クラウドのデータを受け取る
    async joinFamily(input) {
      const id = normalize(input);
      if (id.length !== 12) throw new Error('bad-code');
      const f = await sdk(), user = await signIn();
      const ref = f.F.doc(f.db, 'families', id);
      let snap; try { snap = await f.F.getDoc(ref); } catch (e) { throw e; }
      if (!snap.exists()) throw new Error('not-found');
      if (!(snap.data().members || {})[user.uid]) await f.F.updateDoc(ref, { ['members.' + user.uid]: true });
      saveCfg({ familyId: id }); attach();
      const r = await syncAll();
      return { code: pretty(id), ...r };
    },
    // ユーザーを削除したことを、家族のクラウドに伝える。クラウドのデータは空にして、「削除ずみ」の印を残す
    // （印がないと、ほかの端末が、古いデータを送り返して復活させてしまう）
    async deletePlayer(pid) {
      const c = cfg(); if (!c.familyId) return;
      const ts = Date.now();
      saveCfg({ ...c, deleted: { ...(c.deleted || {}), [pid]: ts } });
      clearTimeout(timers[pid]);
      try {
        await signIn(); await pushDoc(pid, { deleted: true, updatedAt: ts });
        const c2 = cfg(); if (c2.deleted) { delete c2.deleted[pid]; saveCfg(c2); }
      } catch (e) { setStatus(explain(e)); }
    },
    // ---- 通信対戦の部屋（同じ家族の中だけ）----
    uid: () => (fb && fb.auth.currentUser ? fb.auth.currentUser.uid : null),
    // 部屋を作って、部屋コード（6文字）を返す。info = { name, maxGames, party(姿と属性だけ), ver }
    async createRoom(info) {
      const f = await sdk(), user = await signIn(), fid = cfg().familyId;
      if (!fid) throw new Error('not-connected');
      for (let i = 0; i < 6; i++) {
        let id = ''; const buf = new Uint32Array(6); crypto.getRandomValues(buf);
        for (const n of buf) id += ALPHABET[n % ALPHABET.length];
        const ref = f.F.doc(f.db, 'rooms', id);
        if ((await f.F.getDoc(ref)).exists()) continue;
        await f.F.setDoc(ref, {
          familyId: fid, hostUid: user.uid, hostName: info.name, guestUid: null, guestName: '', hostParty: info.party, guestParty: null,
          maxGames: info.maxGames, state: 'waiting', seed: String(Math.floor(Math.random() * 1e9)), ver: info.ver || '', createdAt: Date.now(),
        });
        return id;
      }
      throw new Error('room-id');
    },
    // 待っている部屋の一覧（自分の家族のもの。15分以内）。ルールで一覧が許可されていないと permission-denied
    async listRooms() {
      const f = await sdk(), user = await signIn(), fid = cfg().familyId;
      if (!fid) return [];
      const snap = await f.F.getDocs(f.F.query(f.F.collection(f.db, 'rooms'), f.F.where('familyId', '==', fid), f.F.where('state', '==', 'waiting')));
      const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
      return out.filter((r) => r.hostUid !== user.uid && Date.now() - (r.createdAt || 0) < 15 * 60 * 1000).sort((a, b) => b.createdAt - a.createdAt);
    },
    // 部屋に入る。info = { name, party, ver }。うまくいくと、部屋のデータを返す
    async joinRoom(id, info) {
      const f = await sdk(), user = await signIn();
      id = normalize(id);
      const ref = f.F.doc(f.db, 'rooms', id), snap = await f.F.getDoc(ref);
      if (!snap.exists()) throw new Error('not-found');
      const r = snap.data();
      if (r.familyId !== cfg().familyId) throw new Error('other-family');
      if (r.hostUid === user.uid) throw new Error('self');
      if (r.state !== 'waiting' || r.guestUid) throw new Error('full');
      if (r.ver && info.ver && r.ver !== info.ver) throw new Error('ver:' + r.ver);
      await f.F.updateDoc(ref, { guestUid: user.uid, guestName: info.name, guestParty: info.party, state: 'select' });
      return { id, ...r, guestUid: user.uid, guestName: info.name, guestParty: info.party, state: 'select' };
    },
    // 部屋の変化を見張る。cb(部屋のデータ または null)。見張りをやめる関数を返す
    watchRoom(id, cb) {
      let un = () => {}, stopped = false;
      sdk().then((f) => { if (!stopped) un = f.F.onSnapshot(f.F.doc(f.db, 'rooms', id), (s) => cb(s.exists() ? s.data() : null), () => cb(null)); });
      return () => { stopped = true; un(); };
    },
    async closeRoom(id, reason) {
      try { const f = await sdk(); await f.F.updateDoc(f.F.doc(f.db, 'rooms', id), { state: 'closed', closedBy: (fb && fb.auth.currentUser ? fb.auth.currentUser.uid : ''), reason: reason || '' }); } catch (e) { /* すでに閉じている／消えている */ }
    },
    async deleteRoom(id) { try { const f = await sdk(); await f.F.deleteDoc(f.F.doc(f.db, 'rooms', id)); } catch (e) { /* 無視 */ } },
    // 部屋の中のやりとり（選出・ターンの行動など）
    async setSub(id, sub, docId, data) { const f = await sdk(); await f.F.setDoc(f.F.doc(f.db, 'rooms', id, sub, docId), { ...JSON.parse(JSON.stringify(data)), at: Date.now() }); },
    // 相手のデータが書かれるのを待つ。{ promise, cancel }。promise は データ／（時間切れ）undefined／（取りやめ）null
    waitSub(id, sub, docId, opts) {
      let un = () => {}, timer = null, done = false, settle;
      const promise = new Promise((res) => { settle = (v) => { if (done) return; done = true; clearTimeout(timer); un(); res(v); }; });
      sdk().then((f) => {
        if (done) return;
        un = f.F.onSnapshot(f.F.doc(f.db, 'rooms', id, sub, docId), (s) => { if (s.exists()) settle(s.data()); }, () => settle(null));
      });
      if (opts && opts.timeoutMs) timer = setTimeout(() => settle(undefined), opts.timeoutMs);
      return { promise, cancel: () => settle(null) };
    },
    // この端末だけ切りはなす（クラウドのデータは、そのまま残る）
    leave() { saveCfg({}); root.Store.onChange = null; setStatus(''); },
    // 起動時：つながっていれば同期して、新しいデータを受け取ったら onPulledFn を呼ぶ
    async init(onPulledFn) {
      onPulled = onPulledFn;
      if (!cfg().familyId) return;
      attach();
      const run = async () => { try { const r = await syncAll(); if (r.imported && onPulled) onPulled(); } catch (e) { /* 状態は画面に出る */ } };
      await run();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastSyncAt > 30000) run(); });
    },
    explain,
  };
  root.Cloud = api;
})(window);
