// 会社の対応表：JANコードの先頭（事業者コード7桁か9桁）→ 会社名・証券コード・業種。
// 家にある商品を読み取り、Verified by GS1（ブラウザ）で調べた結果を、手で登録していく。
// 端末の登録（localStorage）が、同梱の companies.json（配布用の対応表）より優先される。
// 登録した内容は「書き出し」で JSON にして、companies.json にまとめる。
(function (root) {
  const KEY = 'bb2-companies';
  const LENS = [9, 7];                       // 長い方から前方一致（9桁の事業者コード → 7桁）
  // 業種：編成ボーナス（業種をばらけさせる）に使うので、数を絞った固定のリスト
  const SECTORS = ['食品', '飲料', 'お菓子', '日用品・化粧品', '医薬品・健康', '電機・ゲーム', '自動車・乗り物', '文具・おもちゃ', '小売・サービス', 'その他'];
  let seed = {}, prices = {}, pricesUpdated = '';

  const readLocal = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const writeLocal = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); return true; } catch (e) { return false; } };

  const api = {
    SECTORS,
    // 配布用の対応表を読み込む（無くてもよい）
    async loadSeed() {
      try { const r = await fetch('companies.json?v=' + Date.now()); if (r.ok) seed = (await r.json()).companies || {}; } catch (e) { seed = {}; }
      api.syncToServer();
    },
    // 開発用サーバー（tools/serve.py）で動かしているとき：画面で登録した会社を companies.json に書いてもらう。サーバーが無ければ何もしない
    async syncToServer() {
      const loc = readLocal(), diff = {};
      Object.entries(loc).forEach(([p, v]) => { const s = seed[p]; if (!s || s.name !== v.name || (s.ticker || '') !== (v.ticker || '') || s.sector !== v.sector) diff[p] = { name: v.name, ticker: v.ticker || '', sector: v.sector }; });
      if (!Object.keys(diff).length) return false;
      try {
        const r = await fetch('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diff) });
        if (!r.ok) return false;
        Object.assign(seed, diff); return true;
      } catch (e) { return false; }
    },
    // 株価をいますぐ取得して読み込む（開発用サーバーのときだけ動く）。成功したら true
    async fetchPricesNow(tickers) {
      try {
        const r = await fetch('/api/fetch-prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
        if (!r.ok) return false;
        await api.loadPrices(); return true;
      } catch (e) { return false; }
    },
    // 株価（prices.json。tools/fetch_prices.py が作る）。無くてもよい
    async loadPrices() {
      try { const r = await fetch('prices.json?v=' + Date.now()); if (r.ok) { const j = await r.json(); prices = j.prices || {}; pricesUpdated = j.updated || ''; } } catch (e) { prices = {}; }
    },
    price(ticker) { return ticker && prices[ticker] ? prices[ticker] : null; },
    pricesUpdated() { return pricesUpdated; },
    // 株価による補正（%）。前日比→攻撃・防御（±10%）、1か月の変化→素早さ（±5%）、配当利回り→やくそうの回復（+0〜10%）。
    // 会社が分かっていなければ null。上場していない・株価データが無い会社は、補正0（業種だけ数える）
    boostFor(jan) {
      const c = api.lookup(jan); if (!c) return null;
      const p = api.price(c.ticker), cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const b = { company: c.name, sector: c.sector, ticker: c.ticker || '', st: 0, df: 0, dx: 0, herb: 0, changePct: null };
      if (p) { b.st = b.df = Math.round(cl(p.changePct, -10, 10) * 10) / 10; b.dx = Math.round(cl(p.trend1mPct * 0.5, -5, 5) * 10) / 10; b.herb = Math.round(cl(p.divYieldPct * 2, 0, 10) * 10) / 10; b.changePct = p.changePct; }
      return b;
    },
    // 選出した戦士の業種が、すべて ちがうとき +5%（全能力）。会社が分からない戦士がいると、なし
    sectorBonus(boosts) {
      if (boosts.length < 2 || boosts.some((b) => !b)) return 0;
      return new Set(boosts.map((b) => b.sector)).size === boosts.length ? 5 : 0;
    },
    // JANコード（13桁）から会社を引く。見つからなければ null。{ prefix, name, ticker, sector, from }
    lookup(jan) {
      const loc = readLocal();
      for (const n of LENS) {
        const p = String(jan).slice(0, n);
        if (loc[p]) return { prefix: p, ...loc[p], from: 'local' };
        if (seed[p]) return { prefix: p, ...seed[p], from: 'seed' };
      }
      return null;
    },
    // 登録する。prefixLen は 7 か 9。ticker は4桁の証券コード（上場していなければ空）
    save(jan, prefixLen, info) {
      const p = String(jan).slice(0, prefixLen), d = readLocal();
      d[p] = { name: info.name.trim(), ticker: info.ticker || '', sector: info.sector || 'その他', at: Date.now() };
      return writeLocal(d) ? p : null;
    },
    // 読み取り・入力したJANコードの記録（新しい順。同じコードは1件にまとめる。最大500件）
    logScan(jan) {
      try {
        const k = 'bb2-scanlog'; let a = JSON.parse(localStorage.getItem(k)) || [];
        a = a.filter((x) => x.jan !== jan); a.unshift({ jan, at: Date.now() });
        localStorage.setItem(k, JSON.stringify(a.slice(0, 500)));
      } catch (e) { /* 記録できなくても遊べる */ }
    },
    scans() { try { return JSON.parse(localStorage.getItem('bb2-scanlog')) || []; } catch (e) { return []; } },
    remove(prefix) { const d = readLocal(); delete d[prefix]; writeLocal(d); },
    // 端末で登録した会社の一覧（新しい順）
    list() { return Object.entries(readLocal()).map(([prefix, v]) => ({ prefix, ...v })).sort((a, b) => (b.at || 0) - (a.at || 0)); },
    // companies.json に貼りつける形で書き出す（seed と端末の登録をまとめる）
    exportJson() {
      const all = { ...seed }; const loc = readLocal();
      Object.keys(loc).forEach((p) => { all[p] = { name: loc[p].name, ticker: loc[p].ticker, sector: loc[p].sector }; });
      return JSON.stringify({ companies: all }, null, 1);
    },
    // 書き出したJSONを取り込む（別の端末の登録を足す）。足した件数を返す
    importJson(text) {
      const obj = JSON.parse(text).companies || {}; const d = readLocal(); let n = 0;
      Object.entries(obj).forEach(([p, v]) => { if (/^\d{7}$|^\d{9}$/.test(p) && v && v.name && !d[p]) { d[p] = { name: String(v.name), ticker: String(v.ticker || ''), sector: v.sector || 'その他', at: Date.now() }; n++; } });
      writeLocal(d); return n;
    },
  };
  root.Company = api;
})(window);
