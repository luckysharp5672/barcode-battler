// 保存層：家族プロフィールと図鑑。localStorage 実装（端末に保存）。
// すべて Promise を返す。クラウド（cloud.js）は、Store.onChange で「変わった」ことを受け取って送り、
// exportProfile / importProfile で受け取ったデータを取り込む。
(function (root) {
  const KEY = 'bb-v3';
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { profiles: {}, current: null }; } catch (e) { return { profiles: {}, current: null }; }
  }
  function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 保存できなくても遊べる */ } }
  // 変更を記録する：更新時刻を付けて、クラウドへ知らせる（最後に変えた方が新しい）
  function commit(d, pid) {
    if (d.profiles[pid]) d.profiles[pid].updatedAt = Date.now();
    write(d);
    try { if (root.Store.onChange) root.Store.onChange(pid); } catch (e) { /* 通知に失敗しても保存は済んでいる */ }
  }

  root.Store = {
    onChange: null,
    async listProfiles() { const d = read(); return Object.entries(d.profiles).map(([id, p]) => ({ id, name: p.name })); },
    async createProfile(name) {
      const d = read(), id = 'p' + Date.now().toString(36);
      d.profiles[id] = { name, dex: {} }; d.current = id; commit(d, id); return id;
    },
    // ユーザーを削除する（端末の保存から消す）。いま選んでいるユーザーなら、残りの先頭に切りかえる
    async deleteProfile(pid) {
      const d = read(); if (!d.profiles[pid]) return;
      delete d.profiles[pid];
      if (d.current === pid) d.current = Object.keys(d.profiles)[0] || null;
      write(d);
    },
    async getCurrent() { const d = read(); return d.profiles[d.current] ? d.current : null; },
    async setCurrent(id) { const d = read(); if (d.profiles[id]) { d.current = id; write(d); } },
    async getDex(pid) { const p = read().profiles[pid]; return p && p.dex ? p.dex : {}; },
    async saveFighter(pid, entry) {
      const d = read(); if (!d.profiles[pid]) return;
      if (!d.profiles[pid].dex) d.profiles[pid].dex = {};
      d.profiles[pid].dex[entry.code] = entry; commit(d, pid);
    },
    // お金・持ち物・手に入れた書籍のコード・パーティ
    //   { money, bag: { アイテムID: 個数 }, itemCodes: [書籍のバーコード], party: { members: [戦士のコード], items: { 戦士のコード: アイテムID } } }
    async getPlayer(pid) {
      const p = read().profiles[pid] || {};
      return {
        money: p.money || 0, bag: p.bag || {}, itemCodes: p.itemCodes || [], party: { members: (p.party && p.party.members) || [], items: (p.party && p.party.items) || {} },
        shop: p.shop || { date: '', bought: [] },                       // 今日買った品
        train: p.train || { date: '', xp: 0 },                          // 今日の修行の合計
        carry: p.carry || { herbs: 0, boost: false },                   // 次の試合への持ち込み
        xp2: p.xp2 || '',                                               // 「きょう1日 経験値2倍」が有効な日付
        cosmetics: p.cosmetics || { titles: [], title: '', frames: [], frame: '' },
      };
    },
    async setPlayer(pid, pl) {
      const d = read(); if (!d.profiles[pid]) return;
      Object.assign(d.profiles[pid], { money: pl.money, bag: pl.bag, itemCodes: pl.itemCodes, party: pl.party, shop: pl.shop, train: pl.train, carry: pl.carry, xp2: pl.xp2 || '', cosmetics: pl.cosmetics });
      commit(d, pid);
    },
    // 今日のランダム（戦士・アイテムそれぞれ1日1回）の記録 { char: {date, code}, item: {date, code} }
    async getDaily(pid) { const p = read().profiles[pid]; return p && p.daily ? p.daily : {}; },
    async setDaily(pid, kind, entry) {
      const d = read(); if (!d.profiles[pid]) return;
      d.profiles[pid].daily = { ...(d.profiles[pid].daily || {}), [kind]: entry }; commit(d, pid);
    },

    // ---- クラウド同期用 ----
    async exportProfiles() { const d = read(); return JSON.parse(JSON.stringify(d.profiles)); },
    async exportProfile(pid) { const p = read().profiles[pid]; return p ? JSON.parse(JSON.stringify(p)) : null; },
    // クラウドから受け取ったプレイヤーを取り込む（更新時刻はそのまま。通知はしない）
    async importProfile(pid, obj) {
      const d = read(); d.profiles[pid] = obj; if (!d.current) d.current = pid; write(d);
    },
  };
})(window);
