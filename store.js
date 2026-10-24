// 保存層：家族プロフィールと図鑑。localStorage 実装。
// すべて Promise を返すので、後で Firebase などクラウド実装に差し替えても画面側は変えなくてよい。
(function (root) {
  const KEY = 'bb-v3';
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { profiles: {}, current: null }; } catch (e) { return { profiles: {}, current: null }; }
  }
  function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 保存できなくても遊べる */ } }

  root.Store = {
    async listProfiles() { const d = read(); return Object.entries(d.profiles).map(([id, p]) => ({ id, name: p.name })); },
    async createProfile(name) {
      const d = read(), id = 'p' + Date.now().toString(36);
      d.profiles[id] = { name, dex: {} }; d.current = id; write(d); return id;
    },
    async getCurrent() { const d = read(); return d.profiles[d.current] ? d.current : null; },
    async setCurrent(id) { const d = read(); if (d.profiles[id]) { d.current = id; write(d); } },
    async getDex(pid) { const p = read().profiles[pid]; return p ? p.dex : {}; },
    async saveFighter(pid, entry) {
      const d = read(); if (!d.profiles[pid]) return;
      d.profiles[pid].dex[entry.code] = entry; write(d);
    },
    // お金と持ち物（バーコードなしで使えるアイテム）{ money, bag: { アイテムID: 個数 } }
    async getPlayer(pid) { const p = read().profiles[pid]; return { money: (p && p.money) || 0, bag: (p && p.bag) || {} }; },
    async setPlayer(pid, pl) {
      const d = read(); if (!d.profiles[pid]) return;
      d.profiles[pid].money = pl.money; d.profiles[pid].bag = pl.bag; write(d);
    },
    // 今日のランダム（戦士・アイテムそれぞれ1日1回）の記録 { char: {date, code}, item: {date, code} }
    async getDaily(pid) { const p = read().profiles[pid]; return p && p.daily ? p.daily : {}; },
    async setDaily(pid, kind, entry) {
      const d = read(); if (!d.profiles[pid]) return;
      d.profiles[pid].daily = { ...(d.profiles[pid].daily || {}), [kind]: entry }; write(d);
    },
  };
})(window);
