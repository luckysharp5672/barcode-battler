(function () {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rng = Math.random;
  const STATUS_JA = { poison: '毒', stun: '麻痺' };

  const slots = { char: { code: '', dec: null }, item: { code: '', dec: null } };
  let cur = null;  // 現在の家族プロフィールID
  let dex = {};    // 現在のプロフィールの図鑑 { code: entry }
  let daily = {};  // 今日のランダムの記録 { char: {date, code}, item: {date, code} }
  // お金・持ち物・手に入れた書籍のコード・パーティ・お店（今日の購入/修行・持ち込み・見た目）
  let player = { money: 0, bag: {}, itemCodes: [], party: { members: [], items: {} }, shop: { date: '', bought: [] }, train: { date: '', xp: 0 }, carry: { herbs: 0, boost: false }, cosmetics: { titles: [], title: '', frames: [], frame: '' } };

  // ---------- シール画像（キラキラ → 属性エフェクト → キャラ の順に重ねる） ----------
  const imgCache = {};
  const loadImg = (src) => imgCache[src] || (imgCache[src] = new Promise((res) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src;
  }));
  async function makeSticker(dec, size = 384) {
    const c = document.createElement('canvas');
    c.width = c.height = size; c.className = 'sticker';
    const ctx = c.getContext('2d');
    if (dec.kind === 'item') {
      const im = await loadImg(`assets/items/${dec.itemId}.webp`);
      if (im) ctx.drawImage(im, 0, 0, size, size);
      return c;
    }
    const [bg, fx, ch] = await Promise.all([
      loadImg(`assets/kirakira/${dec.kirakira.key}.webp`),
      loadImg(`assets/effects/${BB.ATTRS[dec.attr].key}.png`),
      loadImg(`assets/chars/${String(dec.idx).padStart(2, '0')}.webp`),
    ]);
    if (bg) ctx.drawImage(bg, 0, 0, size, size);
    if (fx) ctx.drawImage(fx, 0, 0, size, size);
    if (ch) { const w = size * 470 / 512; ctx.drawImage(ch, (size - w) / 2, (size - w) / 2, w, w); }
    return c;
  }

  // ---------- 家族プロフィールと図鑑 ----------
  const levelOf = (code) => (dex[code] ? dex[code].level : 1);
  async function loadProfiles() {
    let list = await Store.listProfiles();
    if (!list.length) {
      // はじめての端末：家族コードで参加すれば、ほかの端末のプレイヤーを受け取れる
      if (window.Cloud && !Cloud.isConnected()) {
        const v = await choose('はじめまして！', [
          { label: '🆕 はじめて遊ぶ（なまえを入れる）', value: 'new' },
          { label: '🔑 家族コードで参加（ほかの端末のデータを使う）', value: 'join' }]);
        if (v === 'join') { await cloudJoin(true); list = await Store.listProfiles(); }
      }
      if (!list.length) {
        const name = (window.prompt('なまえを入力してください', '') || '').trim() || 'プレイヤー';
        await Store.createProfile(name); list = await Store.listProfiles();
      }
    }
    cur = (await Store.getCurrent()) || list[0].id;
    $('profSel').innerHTML = list.map((p) => `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>👤 ${p.name}</option>`).join('');
    dex = await Store.getDex(cur);
    daily = await Store.getDaily(cur);
    player = await Store.getPlayer(cur);
    updateRandButtons(); renderWallet(); applyLook();
    // 現在のルールで無効なデータは表示しない（保存データは消さない）。名前・限界は最新のデータに合わせる
    Object.keys(dex).forEach((c) => {
      const d = BB.decode(c);
      if (!d || d.kind !== 'char') { delete dex[c]; return; }
      const e = dex[c];
      Object.assign(e, { idx: d.idx, name: d.name, attr: d.attr, kirakira: d.kirakira.key, limit: d.limit });
      e.lots = e.lots || []; e.xp = e.xp || 0; e.wins = e.wins || 0; e.losses = e.losses || 0;
      e.maxLv = BB.maxLevelOf(d.limit, e.lots.length);
      e.level = Math.min(e.level || 1, e.maxLv);
    });
    // 45と49で同じ戦士になった重複は、経験値が多い方を残す
    const seen = {};
    Object.values(dex).forEach((e) => {
      const k = BB.identityKey(e.code), o = seen[k];
      if (!o) { seen[k] = e; return; }
      const keep = e.xp > o.xp ? e : o;
      delete dex[(keep === e ? o : e).code]; seen[k] = keep;
    });
    cleanParty();
    setSlot('char', ''); setSlot('item', '');
  }
  $('profSel').onchange = async (e) => { await Store.setCurrent(e.target.value); await loadProfiles(); };
  $('btnNewProf').onclick = async () => {
    const name = (window.prompt('追加する家族のなまえ', '') || '').trim();
    if (name) { await Store.createProfile(name); await loadProfiles(); }
  };
  // 同じシール = キャラ(⑤⑥)・キラキラ(⑦⑧)・属性(⑨)が同じ（45と49は同じ扱い、③④は見ない）。1つのシールにつき戦士は1体だけ
  const prefixOf = (code) => BB.identityKey(code);
  // バーコードの扱いを判定する（図鑑は変更しない）
  function lookup(code) {
    if (dex[code]) return { type: 'known', entry: dex[code] };
    const e = Object.values(dex).find((x) => prefixOf(x.code) === prefixOf(code));
    if (!e) return { type: 'new' };
    if (e.lots.includes(code)) return { type: 'lotUsed', entry: e };
    if (e.maxLv >= BB.MAX_LV) return { type: 'lotMax', entry: e };
    return { type: 'lot', entry: e };
  }
  // 確定：新規登録 or 別ロットで限界Lv+5（最大Lv60まで）
  async function commitChar() {
    const s = slots.char, st = s.status;
    if (st.type === 'new') {
      const d = s.dec;
      if (dex[d.code]) return;
      dex[d.code] = { code: d.code, idx: d.idx, name: d.name, attr: d.attr, kirakira: d.kirakira.key, limit: d.limit,
        xp: 0, level: 1, maxLv: d.limit, lots: [], wins: 0, losses: 0 };
      await Store.saveFighter(cur, dex[d.code]);
    } else if (st.type === 'lot') {
      if (st.entry.lots.includes(s.code)) return;
      st.entry.lots.push(s.code);
      st.entry.maxLv = BB.maxLevelOf(st.entry.limit, st.entry.lots.length);
      await Store.saveFighter(cur, st.entry);
    }
  }
  function statusText(st) {
    switch (st.type) {
      case 'new': return `🆕 新しい戦士です（入力を確定すると図鑑に登録されます。限界Lv${slots.char.dec ? slots.char.dec.limit : ''}）`;
      case 'known': return '';
      case 'lot': return `🎁 同じシールの別ロット！ ${st.entry.name} の限界Lv ${st.entry.maxLv} → ${BB.maxLevelOf(st.entry.limit, st.entry.lots.length + 1)}（入力を確定すると反映されます）`;
      case 'lotUsed': return `このバーコードは使用済みです。${st.entry.name} を呼び出しました`;
      case 'lotMax': return `${st.entry.name} はすでに最大の限界Lv${BB.MAX_LV}です`;
    }
  }

  // ---------- 表示部品 ----------
  function barSvg(code) {
    const bits = BB.barBits(code);
    let rects = '';
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') rects += `<rect x="${i}" y="0" width="1" height="40"/>`;
    return `<svg class="bar" viewBox="-6 -4 ${bits.length + 12} 48" preserveAspectRatio="none"><rect x="-6" y="-4" width="${bits.length + 12}" height="48" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }
  const statGrid = (s) => `<div class="stat"><div><b>${s.hp}</b>HP</div><div><b>${s.st}</b>ST</div><div><b>${s.df}</b>DF</div><div><b>${s.dx}</b>DX</div><div><b>${s.sp}</b>特殊</div></div>`;
  function previewHtml(d, cap, entry) {
    if (d.kind === 'char') {
      const A = BB.ATTRS[d.attr], lv = entry ? entry.level : 1, mx = entry ? entry.maxLv : d.limit;
      return `<div class="stkwrap" id="stk${cap}"></div>
        <div class="nm">${A.emoji} ${d.name} <span class="small">${d.role}</span></div>
        <span class="tag">${A.name}属性</span><span class="tag">✨${d.kirakira.name}</span><span class="tag">${d.type}</span>
        <div class="small" style="margin-top:6px">Lv${lv} / 限界Lv${mx}（${d.kirakira.name}は最初から限界Lv${d.limit}。別ロットで+5、最大Lv${BB.MAX_LV}）</div>
        ${statGrid(BB.statsAt(d, lv))}${barSvg(d.code)}`;
    }
    return `<div class="stkwrap" id="stk${cap}"></div>
      <div class="nm">🎁 ${d.name}</div><div class="small">${d.text}</div>${d.code ? barSvg(d.code) : '<div class="small">🎒 持ち物から（使うと1個へります）</div>'}`;
  }

  // ---------- ホーム ----------
  function setSlot(kind, code) {
    const s = slots[kind];
    const cap = kind === 'char' ? 'Char' : 'Item';
    s.code = code.replace(/\D/g, '');
    $('in' + cap).value = s.code;
    s.dec = null;
    s.status = null;
    s.bagId = null;
    $('w' + cap).textContent = '';
    $('pv' + cap).innerHTML = '';
    $('i' + cap).textContent = '';
    let preview = null;
    if (s.code.length === 13 && !BB.isValidJan(s.code)) {
      $('w' + cap).textContent = 'チェックデジット（末尾の数字）が合いません。JANコードではありません';
    } else if (s.code.length === 13 && !BB.prefixKind(s.code)) {
      $('w' + cap).textContent = '先頭が45・49の商品か、9784の書籍のバーコードだけ使えます';
    } else if (s.code.length === 13) {
      const d = BB.decode(s.code);
      const st = kind === 'char' ? lookup(s.code) : null;
      if (kind === 'char' && d.kind !== 'char') $('w' + cap).textContent = 'これは書籍（アイテム用）です。先頭が45か49の商品を入れてください';
      else if (kind === 'item' && d.kind !== 'item') $('w' + cap).textContent = 'これは商品（戦士用）です。先頭が9784の書籍を入れてください';
      else if (kind === 'char') {
        s.status = st;
        s.dec = st.entry ? BB.decode(st.entry.code) : d; // 既存の戦士がいればその戦士で戦う
        $('pv' + cap).innerHTML = previewHtml(s.dec, cap, st.entry);
        $('iChar').textContent = statusText(st);
        preview = s.dec;
      } else {
        s.dec = d;
        $('pv' + cap).innerHTML = previewHtml(d, cap);
        preview = d;
      }
    } else if (s.code.length > 0) $('w' + cap).textContent = `13桁のJANコードだけ使えます（いま${s.code.length}桁）`;
    if (preview) makeSticker(preview).then((c) => { const box = $('stk' + cap); if (box && s.dec === preview) box.appendChild(c); });
  }
  // 戦士を手に入れた（スキャン・ランダム・入力の確定）ときに、すぐ図鑑へ登録する／別ロットなら限界Lvを上げる
  async function acquire(kind, code) {
    setSlot(kind, code);
    const s = slots[kind];
    if (kind === 'item') { // 書籍：持ち物に入れる（同じバーコードは1回だけ）
      if (!s.dec) return;
      if (player.itemCodes.includes(code)) { $('iItem').textContent = 'このバーコードは、すでに使用済みです（持ち物に入っています）'; return; }
      player.itemCodes.push(code); player.bag[s.dec.itemId] = (player.bag[s.dec.itemId] || 0) + 1;
      await savePlayer();
      $('iItem').textContent = `🎁 ${s.dec.name} を持ち物に入れました！`;
      return;
    }
    if (kind !== 'char' || !s.status || (s.status.type !== 'new' && s.status.type !== 'lot')) return;
    const st = s.status, name = s.dec.name, oldMax = st.entry ? st.entry.maxLv : 0;
    await commitChar();
    const e = dex[s.dec.code] || st.entry;
    const msg = st.type === 'new' ? `🆕 ${name} を図鑑に登録しました！（限界Lv${e.maxLv}）`
      : `🎁 同じシールの別ロット！ ${name} の限界Lv ${oldMax} → ${e.maxLv}`;
    setSlot('char', s.code);
    $('iChar').textContent = msg;
  }
  $('inChar').addEventListener('input', (e) => setSlot('char', e.target.value));
  $('inChar').addEventListener('change', (e) => acquire('char', e.target.value));
  $('inItem').addEventListener('input', (e) => setSlot('item', e.target.value));
  $('inItem').addEventListener('change', (e) => acquire('item', e.target.value));
  // ランダムは、戦士・アイテムそれぞれ1日1回（端末の日付で切り替わる）。2回目以降は今日のコードを入れ直すだけ
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const usedToday = (kind) => !!(daily[kind] && daily[kind].date === today());
  function updateRandButtons() {
    document.querySelectorAll('[data-rand]').forEach((b) => { b.textContent = usedToday(b.dataset.rand) ? '🎲 今日は済' : '🎲 ランダム'; });
  }
  async function onRandom(kind) {
    const cap = kind === 'char' ? 'Char' : 'Item';
    let note;
    if (usedToday(kind)) {
      await acquire(kind, daily[kind].code);
      note = '🎲 ランダムは1日1回です。今日のコードを入れ直しました（次は明日）';
    } else {
      const code = BB.randomCode(kind);
      daily[kind] = { date: today(), code };
      await Store.setDaily(cur, kind, daily[kind]);
      updateRandButtons();
      await acquire(kind, code);
      note = '🎲 今日のランダム（1日1回）';
    }
    const el = $('i' + cap);
    el.textContent = el.textContent ? note + '　' + el.textContent : note;
  }
  document.querySelectorAll('[data-rand]').forEach((b) => b.onclick = () => onRandom(b.dataset.rand));
  // 持ち物：お金とアイテム
  const bagCount = () => Object.values(player.bag).reduce((a, b) => a + b, 0);
  function renderWallet() { $('wallet').textContent = `${titleText() ? '【' + titleText() + '】　' : ''}💰 ${player.money.toLocaleString()}　🎒 持ち物 ${bagCount()}個`; }
  async function savePlayer() { await Store.setPlayer(cur, player); renderWallet(); }
  async function openBag() {
    const ids = Object.keys(player.bag).filter((id) => player.bag[id] > 0);
    const opts = ids.length
      ? ids.map((id) => { const d = BB.itemById(id); return { label: `🎁 ${d.name} ×${player.bag[id]}<br><span class="small">${d.text}</span>`, value: 0, disabled: true }; })
      : [{ label: 'まだありません。書籍のバーコードを読み取るか、対戦に勝つと手に入ります', value: 0, disabled: true }];
    opts.push({ label: '← 戻る', value: 0 });
    await choose('持ち物（パーティ編成で持たせられます）', opts);
  }
  document.querySelectorAll('[data-bag]').forEach((b) => b.onclick = openBag);
  document.querySelectorAll('[data-lib]').forEach((b) => b.onclick = openLib);
  document.querySelectorAll('[data-scan]').forEach((b) => b.onclick = () => openScan(b.dataset.scan));

  // 図鑑
  function openLib() {
    const l = Object.values(dex).sort((a, b) => b.level - a.level || b.xp - a.xp);
    $('libList').innerHTML = l.length ? '' : '<p class="small">まだ戦士がいません。バーコードを読み取ると図鑑に載ります</p>';
    l.forEach((e) => {
      const b = document.createElement('button');
      b.textContent = `${BB.ATTRS[e.attr].emoji} ${e.name}  Lv${e.level}/${e.maxLv}  ${e.wins}勝${e.losses}敗  (${e.code})`;
      b.onclick = () => { setSlot('char', e.code); $('libMask').classList.remove('on'); };
      $('libList').appendChild(b);
    });
    $('libMask').classList.add('on');
  }
  $('libClose').onclick = () => $('libMask').classList.remove('on');

  // カメラスキャン。ブラウザの BarcodeDetector（Android Chrome など）があればそれを使い、
  // 無ければ同梱の ZXing（vendor/zxing-library.min.js）で読み取る（PCのChrome・iPhoneなど）。HTTPS/localhost が必要
  let stream = null, scanning = false, zxLoading = null;
  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    return zxLoading || (zxLoading = new Promise((res, rej) => {
      const t = document.createElement('script');
      t.src = 'vendor/zxing-library.min.js';
      t.onload = res; t.onerror = () => { zxLoading = null; rej(new Error('zxing')); };
      document.head.appendChild(t);
    }));
  }
  async function useDetector(kind, v) {
    const det = new BarcodeDetector({ formats: ['ean_13'] });
    scanning = true;
    while (scanning) {
      try {
        const r = await det.detect(v);
        if (r.length) { const raw = r[0].rawValue; closeScan(); acquire(kind, raw); return; }
      } catch (e) { /* 読み取り失敗は無視して再試行 */ }
      await sleep(250);
    }
  }
  async function useZXing(kind, v) {
    $('scanMsg').textContent = '読み取りの準備中…';
    try { await loadZXing(); } catch (e) { $('scanMsg').textContent = '読み取りの部品を読み込めませんでした。数字を直接入力してください'; return; }
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    scanning = true;
    $('scanMsg').textContent = 'バーコードを枠いっぱいに、明るい場所で写してください';
    while (scanning) {
      if (v.videoWidth) {
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        try {
          const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(cv)));
          const raw = reader.decode(bmp).getText();
          closeScan(); acquire(kind, raw); return;
        } catch (e) { /* このコマには見つからない。次のコマへ */ }
      }
      await sleep(150);
    }
  }
  async function openScan(kind) {
    $('scanMask').classList.add('on');
    $('scanMsg').textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (e) { $('scanMsg').textContent = 'カメラを使えませんでした（HTTPS接続とカメラ許可が必要です）'; return; }
    const v = $('video');
    v.srcObject = stream; await v.play();
    if ('BarcodeDetector' in window) await useDetector(kind, v); else await useZXing(kind, v);
  }
  function closeScan() {
    scanning = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $('scanMask').classList.remove('on');
  }
  $('scanClose').onclick = closeScan;

  // ---------- 画面切替 ----------
  function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id)); window.scrollTo(0, 0); }

  // ---------- モーダル ----------
  function modal(html) { $('modalBody').innerHTML = html; $('modalMask').classList.add('on'); }
  function closeModal() { $('modalMask').classList.remove('on'); }
  function choose(title, options) {
    return new Promise((res) => {
      modal(`<h2 style="margin:0 0 8px;font-size:16px">${title}</h2><div class="lib" id="choices"></div>`);
      options.forEach((o) => {
        const b = document.createElement('button');
        b.innerHTML = o.label; b.disabled = !!o.disabled;
        b.onclick = () => { closeModal(); res(o.value); };
        $('choices').appendChild(b);
      });
    });
  }
  // ---------- パーティ編成（最大6体。同じキャラ1体まで、同じアイテムは1体まで） ----------
  const PARTY_MAX = 6, PICK = 3, PICK_SECONDS = 60;
  const partyCodes = () => player.party.members.filter((c) => dex[c]);
  const heldBy = (id) => partyCodes().find((c) => player.party.items[c] === id);
  const itemLabel = (id) => (id ? BB.itemById(id).name : 'なし');
  function cleanParty() {
    const p = player.party;
    p.members = p.members.filter((c) => dex[c]);
    const seen = new Set();
    p.members = p.members.filter((c) => { const k = dex[c].idx; if (seen.has(k)) return false; seen.add(k); return true; });
    const used = new Set();
    for (const c of Object.keys(p.items)) {
      const id = p.items[c];
      if (!p.members.includes(c) || !(player.bag[id] > 0) || used.has(id)) delete p.items[c]; else used.add(id);
    }
  }
  function memberRow(e, inParty, idxs) {
    const row = document.createElement('div'); row.className = 'prow';
    const th = document.createElement('div'); th.className = 'pth'; row.appendChild(th);
    makeSticker(BB.decode(e.code), 128).then((c) => th.appendChild(c));
    const A = BB.ATTRS[e.attr];
    const info = document.createElement('div'); info.className = 'pinfo';
    info.innerHTML = `<div><b>${A.emoji} ${e.name}</b> Lv${e.level}/${e.maxLv}</div><div class="small">${e.wins}勝${e.losses}敗${inParty ? ` ／ 🎁 ${itemLabel(player.party.items[e.code])}` : ''}</div>`;
    row.appendChild(info);
    const btns = document.createElement('div'); btns.className = 'pbtns'; row.appendChild(btns);
    const mk = (label, fn, dis) => { const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis; b.onclick = fn; btns.appendChild(b); };
    if (inParty) {
      mk('📋 詳細', () => showDetailModal(e.code));
      mk('🎁 アイテム', () => pickPartyItem(e.code));
      mk('外す', async () => { player.party.members = player.party.members.filter((c) => c !== e.code); delete player.party.items[e.code]; await savePlayer(); renderParty(); });
    } else {
      const dup = idxs.has(e.idx), full = partyCodes().length >= PARTY_MAX;
      mk('📋 詳細', () => showDetailModal(e.code));
      mk(dup ? '同じキャラがいる' : full ? '満員' : '追加', async () => { player.party.members.push(e.code); await savePlayer(); renderParty(); }, dup || full);
    }
    return row;
  }
  function renderParty() {
    cleanParty();
    const box = $('partyBox'); box.innerHTML = '';
    const codes = partyCodes(), idxs = new Set(codes.map((c) => dex[c].idx));
    box.insertAdjacentHTML('beforeend', `<h2 class="small">パーティ（${codes.length}/${PARTY_MAX}）${codes.length < PICK ? ' ／ 対戦には3体以上必要です' : codes.length < PARTY_MAX ? ' ／ 6体そろうと公式の形です' : ''}</h2>`);
    if (!codes.length) box.insertAdjacentHTML('beforeend', '<p class="small">まだ誰もいません。下の図鑑から追加してください</p>');
    codes.forEach((c) => box.appendChild(memberRow(dex[c], true, idxs)));
    box.insertAdjacentHTML('beforeend', '<h2 class="small" style="margin-top:14px">図鑑から追加</h2>');
    const rest = Object.values(dex).filter((e) => !codes.includes(e.code)).sort((a, b) => b.level - a.level || b.xp - a.xp);
    if (!rest.length) box.insertAdjacentHTML('beforeend', '<p class="small">図鑑に、ほかの戦士がいません。バーコードを読み取って戦士を増やしましょう</p>');
    rest.forEach((e) => box.appendChild(memberRow(e, false, idxs)));
  }
  async function pickPartyItem(code) {
    const ids = Object.keys(player.bag).filter((id) => player.bag[id] > 0 && (!heldBy(id) || heldBy(id) === code));
    const opts = [{ label: 'なし（外す）', value: '-' }].concat(ids.map((id) => { const d = BB.itemById(id); return { label: `🎁 ${d.name}${player.bag[id] > 1 ? ' ×' + player.bag[id] : ''}<br><span class="small">${d.text}</span>`, value: id }; }));
    opts.push({ label: '← 戻る', value: 0 });
    const id = await choose(`${dex[code].name} に持たせるアイテム`, opts);
    if (!id) return;
    if (id === '-') delete player.party.items[code]; else player.party.items[code] = id;
    await savePlayer(); renderParty();
  }
  function openParty() { renderParty(); show('party'); }
  $('btnParty').onclick = openParty;
  $('btnPartyBack').onclick = () => show('home');

  // ---------- キャラのステータス・能力の参照（選ぶときに見る） ----------
  const ATTR_COLORS = ['#6fd6a5', '#c9a15a', '#58a6ff', '#ff7b72', '#f0b429']; // 風・土・水・炎・雷
  const HINT_KEY = 'bb-hint';
  let hintOn = true;
  try { hintOn = localStorage.getItem(HINT_KEY) !== '0'; } catch (e) { /* 保存できなくても動く */ }
  const STAT_NAMES = [['hp', 'HP'], ['st', 'ST'], ['df', 'DF'], ['dx', 'DX'], ['sp', '特殊']];
  const canvasCache = {};

  function detailHtml(f, foeAttrs) {
    const A = BB.ATTRS[f.attr];
    const sts = { hp: f.maxHp / BB.HP_SCALE, st: f.st, df: f.df, dx: f.dx, sp: f.sp };
    const bars = STAT_NAMES.map(([k, n]) => `<div class="dbar"><span class="dn">${n}</span><div class="dtrack"><div style="width:${Math.min(100, sts[k] / 3)}%"></div></div><b>${sts[k]}</b></div>`).join('');
    const skills = Battle.SKILL_ORDER.filter((id) => id !== 'item' || f.consumable).map((id) => {
      const sk = Battle.SKILLS[id];
      const extra = id === 'special' ? `（威力の目安 ${Math.round(f.sp * 2.2 + 5)}）` : (id === 'attack' || id === 'quick') ? `（STが基準。ST ${f.st}）` : '';
      return `<div class="dsk"><b>${sk.name}</b>${sk.pri ? ` <span class="tag">優先度${sk.pri > 0 ? '+' : ''}${sk.pri}</span>` : ''}<div class="small">${sk.desc}${extra}</div></div>`;
    }).join('');
    // 経験値：次のレベルまでの進み具合（図鑑にいる戦士だけ。相手のCPUには出さない）
    let xpRow = '';
    const de = dex[f.code];
    if (de) {
      const capped = de.level >= de.maxLv;
      const base = BB.xpForLevel(de.level), need = BB.xpForLevel(de.level + 1) - base;
      const into = capped ? need : de.xp - base, pct = capped ? 100 : Math.round(into / need * 100);
      const note = capped ? (de.maxLv < BB.MAX_LV ? `限界Lv${de.maxLv}に到達（別ロットで限界+${BB.LOT_STEP}）` : `最大Lv${BB.MAX_LV}に到達`) : `Lv${de.level + 1}まで あと ${need - into}（${into}/${need}）`;
      xpRow = `<div class="dbar"><span class="dn">経験</span><div class="dtrack xp"><div style="width:${pct}%"></div></div><b>${capped ? 'MAX' : pct + '%'}</b></div><div class="small">経験値 ${de.xp}　${note}</div>`;
    }
    const item = f.item ? `<div class="small" style="margin-top:6px">🎁 <b>${f.item.name}</b>：${f.item.text}</div>` : '<div class="small" style="margin-top:6px">🎁 アイテムなし</div>';
    const atk = f.atkAttr !== f.attr ? `／攻撃の属性は${BB.ATTRS[f.atkAttr].name}` : '', body = f.bodyAttr !== f.attr ? `／体の属性は${BB.ATTRS[f.bodyAttr].name}` : '';
    let aff = '';
    if (hintOn && foeAttrs) {
      const adv = foeAttrs.filter((a) => BB.affinity(f.atkAttr, a) > 1).length, dis = foeAttrs.filter((a) => BB.affinity(a, f.bodyAttr) > 1).length;
      aff = `<div class="small" style="margin-top:6px">🔎 相手の6体に対して：こちらの攻撃が有利 <b>${adv}</b>体／相手の攻撃が有利 <b>${dis}</b>体</div>`;
    }
    return `<div class="dhead"><div class="dstk"></div><div><div class="nm">${A.emoji} ${f.name}</div>
      <div class="small">${f.role}　${f.type}</div><div class="small">${A.name}属性${atk}${body}　✨${f.kirakira.name}</div>
      <div class="small">Lv${f.level} / 限界Lv${dex[f.code] ? dex[f.code].maxLv : f.limit}</div></div></div>
      ${bars}${xpRow}<div class="small">体力 ${f.maxHp}（HP × ${BB.HP_SCALE}）</div>${item}${aff}<h3>スキル</h3>${skills}`;
  }
  function fillDetail(box, f, foeAttrs) {
    box.innerHTML = detailHtml(f, foeAttrs);
    const tok = box._tok = (box._tok || 0) + 1; // 速く切りかえたとき、古い画像があとから入らないようにする
    makeSticker(f, 192).then((c) => { const t = box.querySelector('.dstk'); if (t && box._tok === tok) { t.innerHTML = ''; t.appendChild(c); } });
  }
  function showDetailModal(code) {
    const id = player.party.items[code];
    const f = BB.makeFighter(BB.decode(code), id ? BB.itemById(id) : null, dex[code].level);
    modal('<div id="dmBox"></div><button class="pri" style="width:100%;margin-top:10px" onclick="document.getElementById(\'modalMask\').classList.remove(\'on\')">閉じる</button>');
    fillDetail($('dmBox'), f);
  }

  // ---------- 見せ合い・選出（制限時間つき） ----------
  let myParty = [], foeParty = [], picked = [], pickTimer = null, focusMine = 0, foeFocus = null, match = null;
  let actx = null;
  function beep(freq = 880, dur = 0.08) { // 残り時間の合図（鳴らせない環境では何もしない）
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq; g.gain.value = 0.05; o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + dur);
    } catch (e) { /* 音が出なくても遊べる */ }
  }
  function memberFighter(code) {
    const id = player.party.items[code];
    let item = id ? BB.itemById(id) : null;
    if (item && item.effect.kind === 'consumable' && match && match.usedMine.includes(id)) item = null; // 3本勝負：使い切りは使ったまま
    const f = BB.makeFighter(BB.decode(code), item, dex[code].level);
    if (canvasCache[code]) f.canvas = canvasCache[code];
    return f;
  }
  function foeFresh(f) {
    let it = f.item;
    if (it && it.effect.kind === 'consumable' && match.usedFoe.includes(it.itemId)) it = null;
    const n = BB.makeFighter(f, it, f.level);
    n.canvas = f.canvas;
    return n;
  }
  function hintFor(f) {
    if (!hintOn) return '';
    if (foeFocus !== null) {
      const a = foeParty[foeFocus].attr, mine = BB.affinity(f.atkAttr, a), theirs = BB.affinity(a, f.bodyAttr);
      const [tag, cls] = mine > 1 && theirs <= 1 ? ['◎ 有利', 'adv'] : theirs > 1 && mine <= 1 ? ['▼ 不利', 'dis'] : mine > 1 && theirs > 1 ? ['△ 撃ち合い', 'even'] : ['－ 互角', 'even'];
      return `<div class="hint ${cls}">${tag}</div>`;
    }
    const adv = foeParty.filter((p) => BB.affinity(f.atkAttr, p.attr) > 1).length, dis = foeParty.filter((p) => BB.affinity(p.attr, f.bodyAttr) > 1).length;
    return `<div class="hint even">有利${adv}／不利${dis}</div>`;
  }
  function pcard(f, { onClick, hidden, extra = '' } = {}) {
    const A = BB.ATTRS[f.attr];
    const el = document.createElement('div'); el.className = 'pcard';
    const th = document.createElement('div'); th.className = 'pth'; th.appendChild(f.canvas); el.appendChild(th);
    el.insertAdjacentHTML('beforeend', hidden
      ? `<div>${A.emoji} ${A.name}属性</div>`
      : `<div>${A.emoji} ${f.name}</div><div class="small">Lv${f.level}${f.item ? ' ／ 🎁' + f.item.name : ''}</div>`);
    if (extra) el.insertAdjacentHTML('beforeend', extra);
    if (onClick) el.onclick = onClick;
    return el;
  }
  const ORDER_LABELS = ['先発', '控え①', '控え②'];
  function movePick(at, dir) {
    const to = at + dir;
    if (to < 0 || to >= picked.length) return;
    [picked[at], picked[to]] = [picked[to], picked[at]];
    renderPick();
  }
  function renderAttrBar() {
    const c = [0, 0, 0, 0, 0]; foeParty.forEach((f) => c[f.attr]++);
    const bar = BB.ATTRS.map((A, i) => (c[i] ? `<i style="width:${c[i] / foeParty.length * 100}%;background:${ATTR_COLORS[i]}"></i>` : '')).join('');
    const label = BB.ATTRS.map((A, i) => (c[i] ? `${A.emoji}${A.name}×${c[i]}` : '')).filter(Boolean).join('　');
    $('attrBar').innerHTML = `<div class="abar">${bar}</div><div class="alabel">あいて：${label}</div>`;
  }
  function renderPick() {
    $('btnHint').textContent = `🔎 相性ヒント：${hintOn ? 'オン' : 'オフ'}`;
    renderAttrBar();
    $('pvFoe').innerHTML = ''; $('pvMine').innerHTML = '';
    foeParty.forEach((f, i) => {
      const marks = match ? match.foeUsedGames.map((g, k) => (g.includes(i) ? `<span class="gm">G${k + 1}</span>` : '')).join('') : '';
      const el = pcard(f, { hidden: true, onClick: hintOn ? () => { foeFocus = foeFocus === i ? null : i; renderPick(); } : null });
      if (hintOn && foeFocus === i) el.classList.add('foc');
      if (marks) el.insertAdjacentHTML('afterbegin', `<span style="position:absolute;right:4px;top:4px;display:flex;gap:2px">${marks}</span>`);
      $('pvFoe').appendChild(el);
    });
    const afs = foeParty.map((f) => f.attr);
    myParty.forEach((f, i) => {
      const at = picked.indexOf(i);
      const el = pcard(f, { onClick: () => { focusMine = i; renderPick(); }, extra: hintFor(f) });
      if (focusMine === i) el.classList.add('foc');
      const tg = document.createElement('button'); tg.className = 'tg';
      tg.textContent = at >= 0 ? '選出中（外す）' : '選ぶ';
      tg.onclick = (ev) => {
        ev.stopPropagation();
        const k = picked.indexOf(i);
        if (k >= 0) picked.splice(k, 1); else if (picked.length < PICK) picked.push(i);
        focusMine = i; renderPick();
      };
      el.appendChild(tg);
      if (at >= 0) { el.classList.add('sel'); el.insertAdjacentHTML('afterbegin', `<span class="pk">${at + 1}</span>`); }
      $('pvMine').appendChild(el);
    });
    fillDetail($('detailBox'), myParty[focusMine], afs);
    // 先発と控えの順番（▲▼で入れかえる）
    const box = $('pickOrder'); box.innerHTML = '';
    for (let k = 0; k < PICK; k++) {
      const f = picked[k] !== undefined ? myParty[picked[k]] : null;
      const row = document.createElement('div'); row.className = 'orow';
      row.innerHTML = `<span class="lb">${ORDER_LABELS[k]}</span><span class="nm2">${f ? `${BB.ATTRS[f.attr].emoji} ${f.name} <span class="small">Lv${f.level}</span>` : '<span class="small">（まだ選んでいません）</span>'}</span>`;
      if (f) {
        const up = document.createElement('button'); up.textContent = '▲'; up.disabled = k === 0; up.onclick = () => movePick(k, -1);
        const dn = document.createElement('button'); dn.textContent = '▼'; dn.disabled = k === picked.length - 1; dn.onclick = () => movePick(k, 1);
        row.appendChild(up); row.appendChild(dn);
      }
      box.appendChild(row);
    }
    $('btnPick').disabled = picked.length !== PICK;
  }
  $('btnHint').onclick = () => {
    hintOn = !hintOn; foeFocus = null;
    try { localStorage.setItem(HINT_KEY, hintOn ? '1' : '0'); } catch (e) { /* 保存できなくても動く */ }
    renderPick();
  };

  // 試合の開始（games=1 でシングル、3 で3本勝負）
  async function startMatch(games) {
    const codes = partyCodes();
    if (codes.length < PICK) {
      const v = await choose('パーティが足りません', [
        { label: `対戦には${PICK}体以上必要です（いま${codes.length}体）`, value: 0, disabled: true },
        { label: '👥 パーティ編成へ', value: 1 }, { label: '← 戻る', value: 0 }]);
      if (v) openParty();
      return;
    }
    match = { maxGames: games, game: 0, wins: [0, 0], codes, usedMine: [], usedFoe: [], foeUsedGames: [], played: new Set(), foeBase: [],
      herbs: 3 + player.carry.herbs, boost: player.carry.boost, carryBack: { herbs: player.carry.herbs, boost: player.carry.boost } };
    match.carryText = [player.carry.herbs ? `薬草+${player.carry.herbs}` : '', player.carry.boost ? '経験値×2' : ''].filter(Boolean).join('・');
    if (player.carry.herbs || player.carry.boost) { player.carry = { herbs: 0, boost: false }; await savePlayer(); } // 持ち込みは、試合を始めると使われる
    const mine0 = codes.map((c) => BB.makeFighter(BB.decode(c), null, dex[c].level));
    const avg = Math.round(mine0.reduce((a, f) => a + f.level, 0) / mine0.length);
    match.foeBase = Battle.generateCpuParty(avg, rng, PARTY_MAX);
    await Promise.all(match.foeBase.map(async (f) => { f.canvas = await makeSticker(f, 160); }));
    await Promise.all(codes.map(async (c, i) => { canvasCache[c] = await makeSticker(mine0[i], 160); }));
    await nextGame();
  }
  async function nextGame() {
    match.game++;
    myParty = match.codes.map(memberFighter);
    foeParty = match.foeBase.map(foeFresh);
    picked = []; focusMine = 0; foeFocus = null;
    $('gameNo').textContent = (match.maxGames > 1 ? `（第${match.game}試合／先に2勝）` : '') + (match.carryText ? `（持ち込み：${match.carryText}）` : '');
    $('matchHist').textContent = match.foeUsedGames.length ? '　印G＝前の試合で出てきた' : '';
    renderPick(); show('preview');
    startPickTimer();
  }
  function startPickTimer() {
    let left = PICK_SECONDS;
    const decideAt = 6 + rng() * 35; // CPUの「決定ずみ」になるまでの秒数（見た目のための演出）
    const ring = $('ring');
    const tick = () => {
      $('pickTimer').textContent = Math.max(0, left);
      ring.style.setProperty('--p', Math.max(0, left) / PICK_SECONDS * 100);
      ring.classList.toggle('warn', left <= 10);
      $('foeState').textContent = PICK_SECONDS - left >= decideAt ? 'あいて：決定ずみ ✓' : 'あいて：選出中…';
      if (left <= 10 && left > 0) beep(left <= 3 ? 1320 : 880);
    };
    clearInterval(pickTimer); tick();
    pickTimer = setInterval(() => {
      left--; tick();
      if (left <= 0) { // 時間切れ：レベルの高い順に自動で選ぶ
        const rest = myParty.map((f, i) => i).filter((i) => !picked.includes(i)).sort((a, b) => myParty[b].level - myParty[a].level);
        while (picked.length < PICK) picked.push(rest.shift());
        confirmPick();
      }
    }, 1000);
  }

  // 公開演出：カードがめくれて、先発だけが表になる（相手の控えは「？」のまま）
  function revealSelections(mineList, foeList) {
    return new Promise((res) => {
      const build = (box, list, bench) => {
        box.innerHTML = '';
        list.forEach((f, k) => {
          const el = document.createElement('div'); el.className = 'flip' + (k > 0 && !bench ? ' hid' : '');
          el.innerHTML = '<div><div class="bk">⚪</div><div class="fr"></div></div>';
          const c = document.createElement('canvas'); c.width = c.height = 160;
          c.getContext('2d').drawImage(f.canvas, 0, 0, 160, 160);
          el.querySelector('.fr').appendChild(c);
          if (k > 0 && !bench) el.insertAdjacentHTML('beforeend', '<span class="qq">？</span>');
          if (k === 0) el.insertAdjacentHTML('beforeend', '<span class="qq">先発</span>');
          box.appendChild(el);
        });
      };
      build($('rvFoe'), foeList, false); build($('rvMine'), mineList, true);
      $('revealMask').classList.add('on');
      setTimeout(() => { $('rvFoe').firstChild.classList.add('on'); $('rvMine').querySelectorAll('.flip').forEach((e) => e.classList.add('on')); }, 700);
      setTimeout(() => { $('revealMask').classList.remove('on'); res(); }, 2300);
    });
  }
  async function confirmPick() {
    clearInterval(pickTimer);
    const foeSel = Battle.cpuSelect(foeParty, myParty, PICK);
    const mineList = picked.map((i) => myParty[i]), foeList = foeSel.map((i) => foeParty[i]);
    await revealSelections(mineList, foeList);
    const winner = await runBattle(mineList, foeList);
    await afterGame(winner, foeSel);
  }
  $('btnPick').onclick = confirmPick;
  // 「もどる」：見せ合い・選出をやめてホームへ。1試合目なら、持ち込み（薬草・ブースト）は使っていないので返す
  async function backFromPick() {
    if (match && match.game > 1) {
      const ok = await choose('3本勝負をやめますか？', [
        { label: 'ここまでの結果は消えて、経験値もお金ももらえません。', value: 0, disabled: true },
        { label: 'やめてホームへ', value: 1 }, { label: 'つづける', value: 0 }]);
      if (!ok) return;
    }
    clearInterval(pickTimer);
    if (match && match.game <= 1 && (match.carryBack.herbs || match.carryBack.boost)) { player.carry = { ...match.carryBack }; await savePlayer(); }
    match = null; renderWallet(); show('home');
  }
  document.querySelectorAll('[data-pickback]').forEach((b) => { b.onclick = backFromPick; });
  $('btnBattle').onclick = () => startMatch(1);
  $('btnBo3').onclick = () => startMatch(3);
  $('btnNext').onclick = nextGame;

  // ---------- 対戦（同時入力ターン制） ----------
  let st = null, view = null, logLines = [];
  function say(t) { logLines.push(t); if (logLines.length > 6) logLines.shift(); $('log').innerHTML = logLines.map((l) => `<div>${l}</div>`).join(''); }
  const cardOfSide = (s) => (s === 0 ? $('meCard') : $('foeCard'));
  const sideName = (s) => (s === 0 ? 'あなた' : 'てき');
  function cardHtml(s) {
    const side = st.sides[s], idx = view.active[s], f = side.party[idx], hp = view.hp[s][idx];
    const A = BB.ATTRS[f.attr], pct = Math.max(0, hp / f.maxHp * 100);
    const col = pct > 50 ? 'var(--hp)' : pct > 20 ? 'var(--hp2)' : 'var(--hp3)';
    const stt = Object.keys(f.status).filter((k) => f.status[k] > 0).map((k) => STATUS_JA[k]).join('・');
    const atk = f.atkAttr !== f.attr ? `（攻:${BB.ATTRS[f.atkAttr].name}）` : '', body = f.bodyAttr !== f.attr ? `（体:${BB.ATTRS[f.bodyAttr].name}）` : '';
    // 控えのボール：自分は属性色・名前・HP%、相手は場に出てくるまで「？」
    const chips = side.party.map((m, i) => {
      const known = s === 0 || view.seen[s].has(i);
      const dead = view.hp[s][i] <= 0, p = Math.ceil(Math.max(0, view.hp[s][i]) / m.maxHp * 100);
      const dot = known ? `<span class="dot" style="background:${ATTR_COLORS[m.attr]}"></span>` : '<span class="dot" style="background:#555"></span>';
      return `<span class="chip ${i === idx ? 'on' : ''} ${dead ? 'dead' : ''}">${dot}${known ? m.name : '？'}${s === 0 && !dead ? ` ${p}%` : ''}</span>`;
    }).join('');
    const hpText = s === 0 ? `HP ${hp}/${f.maxHp}` : `HP ${Math.ceil(pct)}%`;
    const detail = s === 0
      ? `${A.emoji}${A.name}${atk}${body} ／ 🌿${view.herbs[s]} ／ ✨${f.spCd > 0 ? 'あと' + f.spCd : '使える'}${f.item && (f.item.effect.kind !== 'consumable' || f.consumable) ? '／🎁' + f.item.name : ''}`
      : `${A.emoji}${A.name}属性`;
    const hist = s === 1 && view.hist[1].length ? `<div class="small">あいての直近：${view.hist[1].slice(-3).join('・')}</div>` : '';
    return `<div class="frow"><div class="stk"></div><div class="finfo">
      <div class="top"><span style="color:var(--${s === 0 ? 'me' : 'foe'})">${sideName(s)}${s === 0 && titleText() ? '【' + titleText() + '】' : ''} ${f.name}</span><span>Lv${f.level}</span></div>
      <div class="hpwrap"><div class="hpbar" style="width:${pct}%;background:${col}"></div></div>
      <div class="small">${hpText}${stt ? ' ／ 💫' + stt : ''}</div>
      <div class="small">${detail}</div>${hist}
      <div class="chips">${chips}</div></div></div>`;
  }
  function renderBattle() {
    for (const s of [0, 1]) {
      const card = cardOfSide(s);
      card.innerHTML = cardHtml(s);
      card.querySelector('.stk').appendChild(st.sides[s].party[view.active[s]].canvas);
    }
  }
  async function flashSide(s, text, color) {
    const card = cardOfSide(s);
    card.classList.add('hit');
    const p = document.createElement('div'); p.className = 'pop'; p.style.color = color || '#fff'; p.textContent = text; card.appendChild(p);
    await sleep(650); card.classList.remove('hit'); p.remove();
  }
  const effText = (m) => (m >= 1.5 ? '効果は抜群！' : m <= 0.5 ? '効果はいまひとつ…' : m < 1 ? 'あまり効かない…' : '');
  async function playEvents(events) {
    for (const e of events) {
      switch (e.t) {
        case 'order': { // 行動順のタイムライン：交代 → 優先度の高いスキル → DX
          $('timeline').innerHTML = e.list.map((x, i) => `<span class="tl ${x.s === 0 ? 'me' : 'foe'}" style="animation-delay:${i * 0.25}s">${i + 1}. ${sideName(x.s)}：${x.label}${x.kind === 'skill' ? ` <em>優先度${x.pri > 0 ? '+' : ''}${x.pri}・DX${x.dx}</em>` : ' <em>先に交代</em>'}</span>`).join('');
          e.list.forEach((x) => view.hist[x.s].push(x.label));
          renderBattle(); await sleep(500 + e.list.length * 350); break;
        }
        case 'switch':
          say(`${sideName(e.s)}は ${e.from ? e.from + ' を戻して ' : ''}${e.to} を出した！`);
          view.active[e.s] = e.idx; view.seen[e.s].add(e.idx); renderBattle(); await sleep(700); break;
        case 'use': say(`${e.who} の ${e.skill}！`); await sleep(450); break;
        case 'miss': say('しかし攻撃は外れた！'); await sleep(500); break;
        case 'msg': say(e.text); await sleep(600); break;
        case 'dmg':
          view.hp[e.s][e.idx] = e.hp;
          if (effText(e.mult)) say(effText(e.mult));
          say(e.crit ? `会心の一撃！ ${e.dmg} のダメージ！` : `${e.dmg} のダメージ！`);
          renderBattle(); await flashSide(e.s, '-' + e.dmg, e.crit ? '#ffd700' : '#ff7b72'); break;
        case 'heal':
          view.hp[e.s][e.idx] = e.hp; if (e.herbs !== undefined) view.herbs[e.s] = e.herbs;
          say(e.item ? `${e.item} を使った！${e.amount ? ` ${e.amount} 回復！` : ''}` : `${e.amount} 回復！`);
          renderBattle(); await flashSide(e.s, '+' + e.amount, '#3fb950'); break;
        case 'status': say(`${e.name} は${STATUS_JA[e.status]}になった！`); renderBattle(); await sleep(600); break;
        case 'poison':
          view.hp[e.s][e.idx] = e.hp; say(`${e.name} は毒で ${e.dmg} のダメージ！`);
          renderBattle(); await flashSide(e.s, '-' + e.dmg, '#a371f7'); break;
        case 'faint': say(`${e.name} は たおれた！`); renderBattle(); await sleep(800); break;
      }
    }
  }

  // 自分の行動を決める（スキル／交代）
  async function pickBench(title, canCancel) {
    const side = st.sides[0];
    const opts = Battle.benchAlive(side).map((i) => {
      const f = side.party[i];
      return { label: `${BB.ATTRS[f.attr].emoji} ${f.name} Lv${f.level}　HP ${view.hp[0][i]}/${f.maxHp}`, value: i };
    });
    if (canCancel) opts.push({ label: '← 戻る', value: -1 });
    const v = await choose(title, opts);
    return v >= 0 ? v : null;
  }
  async function chooseAction() {
    for (;;) {
      const f = Battle.actOf(st, 0);
      const top = await choose(`${f.name} はどうする？`, [
        { label: '⚔ スキル（このキャラで継続）', value: 'skill' },
        { label: '🔄 交代（スキルより先に行われます）', value: 'switch', disabled: !Battle.benchAlive(st.sides[0]).length }]);
      if (top === 'skill') {
        const opts = Battle.availableSkills(st, 0).map((s) => ({
          label: `<b>${s.name}</b>${s.pri ? ` <span class="tag">優先度${s.pri > 0 ? '+' : ''}${s.pri}</span>` : ''}<br><span class="small">${s.off ? '✕ ' + s.off : s.desc}</span>`,
          value: s.id, disabled: !!s.off,
        }));
        opts.push({ label: '← 戻る', value: 0 });
        const id = await choose('スキル', opts);
        if (id) return { type: 'skill', skill: id };
      } else if (top === 'switch') {
        const to = await pickBench('だれと交代する？', true);
        if (to !== null) return { type: 'switch', to };
      }
    }
  }

  // 1試合の対戦。勝者（0=自分 1=相手 -1=引き分け）を返す
  async function runBattle(mineList, foeList) {
    st = Battle.createBattle(Battle.createSide('あなた', mineList, match.herbs), Battle.createSide('てき', foeList));
    view = { hp: st.sides.map((sd) => sd.party.map((f) => f.hp)), active: [0, 0], herbs: [match.herbs, 3], seen: [new Set([0]), new Set([0])], hist: [[], []] };
    logLines = []; $('timeline').innerHTML = ''; $('log').innerHTML = '';
    $('starLine').textContent = '相性：炎→風→土→雷→水→炎（有利×1.5／不利×0.5／同属性×0.75）';
    show('battle'); renderBattle();
    say(`${foeList[0].name} が勝負をしかけてきた！`); await sleep(700);
    while (!st.over) {
      $('timeline').innerHTML = '';
      const mine = await chooseAction();            // 同時入力：相手の行動は見えない
      const foeAct = Battle.cpuAction(st, 1, rng);
      await playEvents(Battle.resolveTurn(st, [mine, foeAct], rng));
      for (const s of Battle.needReplace(st)) {      // たおれたあとは、次に出すキャラを選ぶ
        let to = null;
        if (s === 0) { while (to === null) to = await pickBench('次に出すキャラを選んでください', false); } else to = Battle.cpuReplace(st, 1);
        await playEvents([Battle.replaceActive(st, s, to)]);
      }
      await sleep(250);
    }
    await sleep(500);
    return st.winner;
  }

  // 相手のパーティの公開（出した・出さなかった）
  function renderFoeReveal(box) {
    box.innerHTML = '';
    match.foeBase.forEach((f, i) => {
      const games = match.foeUsedGames.map((g, k) => (g.includes(i) ? `G${k + 1}` : '')).filter(Boolean);
      const el = pcard(f, { extra: `<div class="small" style="color:${games.length ? 'var(--acc)' : 'var(--dim)'}">${games.length ? '出た ' + games.join('・') : '出番なし'}</div>` });
      box.appendChild(el);
    });
  }
  // 1試合が終わったあと：3本勝負なら次の試合へ、そうでなければ結果へ
  async function afterGame(winner, foeSel) {
    match.foeUsedGames.push(foeSel);
    picked.forEach((i) => match.played.add(match.codes[i]));
    match.usedMine.push(...st.sides[0].usedItems); match.usedFoe.push(...st.sides[1].usedItems);
    if (winner === 0) match.wins[0]++; else if (winner === 1) match.wins[1]++;
    const need = match.maxGames === 1 ? 1 : 2;
    if (match.wins[0] >= need || match.wins[1] >= need || match.game >= match.maxGames) { await finishMatch(); return; }
    $('btEmo').textContent = winner === 0 ? '🏆' : winner === 1 ? '💀' : '🤝';
    $('btTitle').textContent = `第${match.game}試合 ${winner === 0 ? 'しょうり！' : winner === 1 ? 'はいぼく…' : 'ひきわけ'}`;
    $('btSub').textContent = `ここまで ${match.wins[0]}勝 ${match.wins[1]}敗（先に2勝で勝ち）`;
    renderFoeReveal($('btFoe'));
    show('between');
  }

  // 結果：出場した戦士に経験値、お金、まれにアイテム
  async function finishMatch() {
    const win = match.wins[0] > match.wins[1], draw = match.wins[0] === match.wins[1];
    $('resEmo').textContent = win ? '🏆' : draw ? '🤝' : '💀';
    $('resTitle').textContent = win ? 'しょうり！' : draw ? 'ひきわけ' : 'はいぼく…';
    const avgFoe = Math.round(match.foeBase.reduce((a, f) => a + f.level, 0) / match.foeBase.length);
    $('resSub').textContent = match.maxGames > 1 ? `3本勝負：${match.wins[0]}勝 ${match.wins[1]}敗` : (win ? 'てきのパーティを全員たおした' : draw ? 'どちらも全員が戦えなくなった' : 'パーティが全員たおされた');
    const members = [];
    for (const code of match.played) {
      const e = dex[code], oldLv = e.level, oldXp = e.xp;
      e.xp = Math.min(e.xp + (win ? 30 + 5 * avgFoe : 10) * (match.boost ? 2 : 1), BB.xpForLevel(e.maxLv));
      const gain = e.xp - oldXp;
      e.level = BB.levelFromXp(e.xp, e.maxLv); e[win ? 'wins' : 'losses']++;
      await Store.saveFighter(cur, e);
      members.push({ name: e.name, oldLv, e, gain });
    }
    const gold = BB.rewardMoney(win, avgFoe, rng);
    player.money += gold;
    for (const id of match.usedMine) { // 使い切りのアイテムは、持ち物からへる
      player.bag[id] = (player.bag[id] || 1) - 1; if (player.bag[id] <= 0) delete player.bag[id];
      for (const c of Object.keys(player.party.items)) if (player.party.items[c] === id) delete player.party.items[c];
    }
    const dropId = BB.rollDrop(win, rng);
    if (dropId) player.bag[dropId] = (player.bag[dropId] || 0) + 1;
    await savePlayer();
    show('result');
    renderRewards({ members, gold, boost: match.boost, drop: dropId ? BB.itemById(dropId) : null });
    $('foeRevealTitle').style.display = 'block';
    renderFoeReveal($('foeReveal'));
  }

  // 報酬画面：経験値 → お金 → アイテム の順に、ひとつずつ現れる
  function renderRewards(r) {
    const box = $('rewards'); box.innerHTML = '';
    let delay = 0.2;
    const add = (html, cls = '') => {
      const el = document.createElement('div');
      el.className = 'reward ' + cls; el.style.setProperty('--d', delay + 's'); delay += 0.5;
      el.innerHTML = html; box.appendChild(el); return el;
    };
    const rows = r.members.map((m) => {
      const e = m.e, capped = e.level >= e.maxLv;
      const base = BB.xpForLevel(e.level), need = BB.xpForLevel(e.level + 1) - base;
      const pct = capped ? 100 : Math.round((e.xp - base) / need * 100);
      const note = !capped ? `あと ${need - (e.xp - base)}`
        : (e.maxLv < BB.MAX_LV ? `限界です（別ロットで限界Lv+${BB.LOT_STEP}。最大 Lv${BB.MAX_LV}）` : `最大 Lv${BB.MAX_LV}`);
      return `<div style="margin-bottom:8px"><div class="rt">${m.name} <b>+${m.gain}</b> <span class="small">Lv${e.level}　${note}</span></div>
        <div class="xpbar"><div style="width:${pct}%"></div></div>${e.level > m.oldLv ? `<div class="lvup">🎉 レベルアップ！ Lv${m.oldLv} → Lv${e.level}</div>` : ''}</div>`;
    }).join('');
    add(`<div class="ic">⭐</div><div class="rb"><div class="rt" style="margin-bottom:6px">経験値${r.boost ? ' <span class="tag">ブースト×2</span>' : ''}</div>${rows}</div>`);
    add(`<div class="ic">💰</div><div class="rb"><div class="rt">お金 <b>+${r.gold.toLocaleString()}</b></div><div class="small">所持金 ${player.money.toLocaleString()}</div></div>`);
    if (r.drop) {
      const el = add(`<div class="rimg"></div><div class="rb"><div class="rt">🎁 アイテムを手に入れた！</div><div class="rn">${r.drop.name}</div>
        <div class="small">${r.drop.text}</div><div class="small">🎒 持ち物に入りました（${player.bag[r.drop.itemId]}個）</div></div>`, 'drop');
      makeSticker(r.drop, 192).then((c) => el.querySelector('.rimg').appendChild(c));
    } else {
      add('<div class="ic">🎁</div><div class="rb"><div class="rt">アイテム</div><div class="small">今回はなし（まれに手に入ります）</div></div>', 'none');
    }
  }

  // ---------- お店（今日の品・売る・修行・持ち込み・見た目） ----------
  const TRAIN_DAILY_XP = 600, XP_PRICE = 2;               // 修行：1日600XPまで、1XP=2円
  const CARRY_HERB_PRICE = 120, CARRY_HERB_MAX = 2, BOOST_PRICE = 250;
  const TITLES = [
    { id: 'hunter', name: 'バーコードハンター', price: 300 }, { id: 'collector', name: 'シールコレクター', price: 500 },
    { id: 'reader', name: '読み合いの達人', price: 1000 }, { id: 'master', name: '属性マスター', price: 1500 },
    { id: 'legend', name: '伝説の戦士', price: 3000 },
  ];
  const FRAMES = [
    { id: 'gold', name: 'ゴールドの枠', price: 600 }, { id: 'ice', name: 'こおりの枠', price: 900 },
    { id: 'flame', name: 'ほのおの枠', price: 900 }, { id: 'rainbow', name: 'レインボーの枠', price: 2000 },
  ];
  const SHOP_TABS = [['buy', '🛒 今日の品'], ['sell', '💱 売る'], ['train', '🏋 修行'], ['carry', '🎒 持ち込み'], ['look', '✨ 見た目']];
  let shopTab = 'buy';
  const yen = (n) => `💰${n.toLocaleString()}`;
  function ensureDaily() {
    const t = today();
    if (player.shop.date !== t) player.shop = { date: t, bought: [] };
    if (player.train.date !== t) player.train = { date: t, xp: 0 };
  }
  function applyLook() { document.body.dataset.frame = player.cosmetics.frame || ''; }
  const shopMsg = (t) => { $('shopMsg').textContent = t; };
  function openShop() { ensureDaily(); shopTab = 'buy'; shopMsg(''); renderShop(); show('shop'); }
  function renderShop() {
    ensureDaily();
    $('shopWallet').textContent = `所持金 ${yen(player.money)}　🎒 持ち物 ${bagCount()}個`;
    const tabs = $('shopTabs'); tabs.innerHTML = '';
    SHOP_TABS.forEach(([id, label]) => {
      const b = document.createElement('button'); b.textContent = label; if (id === shopTab) b.className = 'on';
      b.onclick = () => { shopTab = id; shopMsg(''); renderShop(); };
      tabs.appendChild(b);
    });
    const box = $('shopBox'); box.innerHTML = '';
    ({ buy: shopBuy, sell: shopSell, train: shopTrain, carry: shopCarry, look: shopLook })[shopTab](box);
  }
  // 1行のカード：サムネイル（任意）・説明・ボタン
  function srow(box, { thumb, html, buttons }) {
    const row = document.createElement('div'); row.className = 'srow';
    if (thumb) { const th = document.createElement('div'); th.className = 'pth'; row.appendChild(th); thumb(th); }
    const info = document.createElement('div'); info.className = 'pinfo'; info.style.flex = '1'; info.innerHTML = html; row.appendChild(info);
    const bs = document.createElement('div'); bs.className = 'pbtns'; row.appendChild(bs);
    buttons.forEach(([label, fn, dis]) => { const b = document.createElement('button'); b.textContent = label; b.disabled = !!dis; b.onclick = fn; bs.appendChild(b); });
    box.appendChild(row); return row;
  }
  const itemThumb = (id) => (th) => makeSticker(BB.itemById(id), 128).then((c) => th.appendChild(c));
  async function pay(cost) { player.money -= cost; await savePlayer(); }

  // 🛒 今日の品：毎日かわる3つ（家族ごと）。同じ品は1日1個
  function shopBuy(box) {
    box.insertAdjacentHTML('beforeend', '<p class="small">品ぞろえは毎日かわります。同じ品は1日1個まで。</p>');
    BB.shopStock(`${today()}-${cur}`, 3).forEach((id) => {
      const d = BB.itemById(id), price = BB.itemPrice(id), got = player.shop.bought.includes(id);
      srow(box, {
        thumb: itemThumb(id), html: `<b>${d.name}</b><div class="small">${d.text}</div><div>${yen(price)}${got ? '　<span class="tag">売り切れ</span>' : ''}</div>`,
        buttons: [[got ? '買った' : '買う', async () => {
          if (player.money < price) return;
          player.bag[id] = (player.bag[id] || 0) + 1; player.shop.bought.push(id); await pay(price);
          shopMsg(`🛒 ${d.name} を買いました（-${price}）`); renderShop();
        }, got || player.money < price]],
      });
    });
  }
  // 💱 売る：持ち物を買値の半分で（パーティが持たせている分は、1個のこす）
  function shopSell(box) {
    const ids = Object.keys(player.bag).filter((id) => player.bag[id] > 0);
    box.insertAdjacentHTML('beforeend', '<p class="small">持ち物を、買値の半分で売れます。パーティに持たせているアイテムは、1個のこります。</p>');
    if (!ids.length) { box.insertAdjacentHTML('beforeend', '<p class="small">持ち物がありません。</p>'); return; }
    ids.forEach((id) => {
      const d = BB.itemById(id), price = BB.sellPrice(id), sellable = player.bag[id] - (heldBy(id) ? 1 : 0);
      srow(box, {
        thumb: itemThumb(id), html: `<b>${d.name}</b> ×${player.bag[id]}<div class="small">${d.text}</div><div>売値 ${yen(price)}${heldBy(id) ? '　<span class="tag">持たせ中</span>' : ''}</div>`,
        buttons: [['1個売る', async () => {
          player.bag[id]--; if (player.bag[id] <= 0) delete player.bag[id];
          player.money += price; await savePlayer(); shopMsg(`💱 ${d.name} を売りました（+${price}）`); renderShop();
        }, sellable <= 0]],
      });
    });
  }
  // 🏋 修行：お金で経験値を買う（1日600XPまで。限界レベルは超えない）
  function shopTrain(box) {
    const remain = TRAIN_DAILY_XP - player.train.xp;
    box.insertAdjacentHTML('beforeend', `<p class="small">1XP＝${XP_PRICE}円。今日の修行ののこり <b>${remain}</b> / ${TRAIN_DAILY_XP} XP（日付が変わると戻ります）。限界レベルを超えては上がりません。</p>`);
    const list = Object.values(dex).sort((a, b) => b.level - a.level || b.xp - a.xp);
    if (!list.length) box.insertAdjacentHTML('beforeend', '<p class="small">図鑑に戦士がいません。</p>');
    list.forEach((e) => {
      const capXp = BB.xpForLevel(e.maxLv), base = BB.xpForLevel(e.level), need = BB.xpForLevel(e.level + 1) - base;
      const pct = e.level >= e.maxLv ? 100 : Math.round((e.xp - base) / need * 100);
      const A = BB.ATTRS[e.attr];
      const gainOf = (req) => Math.max(0, Math.min(req, capXp - e.xp, remain));
      const btn = (req) => {
        const g = gainOf(req), cost = g * XP_PRICE;
        return [g > 0 ? `+${g}XP ${cost}円` : '+' + req + 'XP', async () => {
          const old = e.level; e.xp += g; e.level = BB.levelFromXp(e.xp, e.maxLv); player.train.xp += g;
          await Store.saveFighter(cur, e); await pay(cost);
          shopMsg(`🏋 ${e.name} の経験値 +${g}${e.level > old ? `　🎉 レベルアップ！ Lv${old} → Lv${e.level}` : ''}`); renderShop();
        }, g <= 0 || player.money < cost];
      };
      srow(box, {
        thumb: (th) => makeSticker(BB.decode(e.code), 128).then((c) => th.appendChild(c)),
        html: `<b>${A.emoji} ${e.name}</b> Lv${e.level}/${e.maxLv}<div class="mini"><div style="width:${pct}%"></div></div><div class="small">${e.level >= e.maxLv ? '限界です' : `経験値 ${e.xp}（Lv${e.level + 1}まで あと ${need - (e.xp - base)}）`}</div>`,
        buttons: [btn(50), btn(200)],
      });
    });
  }
  // 🎒 持ち込み：次の試合だけ有効（試合を始めると使われる）
  function shopCarry(box) {
    box.insertAdjacentHTML('beforeend', '<p class="small">買った分は、<b>次の試合だけ</b>有効です（試合を始めると使われます。3本勝負なら、その3試合ぶん）。</p>');
    const c = player.carry;
    srow(box, {
      html: `<b>🌿 薬草 +1</b><div class="small">薬草が3個→4個（最大+${CARRY_HERB_MAX}まで）。いま +${c.herbs}</div><div>${yen(CARRY_HERB_PRICE)}</div>`,
      buttons: [['買う', async () => { c.herbs++; await pay(CARRY_HERB_PRICE); shopMsg('🌿 薬草を持ち込みます（次の試合）'); renderShop(); }, c.herbs >= CARRY_HERB_MAX || player.money < CARRY_HERB_PRICE]],
    });
    srow(box, {
      html: `<b>⏫ 経験値ブースト</b><div class="small">次の試合で、出場したキャラの経験値が×2${c.boost ? '　<span class="tag">予約中</span>' : ''}</div><div>${yen(BOOST_PRICE)}</div>`,
      buttons: [[c.boost ? '予約ずみ' : '買う', async () => { c.boost = true; await pay(BOOST_PRICE); shopMsg('⏫ 次の試合で経験値が2倍になります'); renderShop(); }, c.boost || player.money < BOOST_PRICE]],
    });
  }
  // ✨ 見た目：称号（名前の横）とシールの枠（自分のキャラだけ）。強さには関係しません
  function shopLook(box) {
    const cs = player.cosmetics;
    box.insertAdjacentHTML('beforeend', '<p class="small">見た目だけで、強さには関係しません。称号は、ホームと対戦中の名前の横に出ます。枠は、自分のキャラのシールに付きます。</p><h2 class="small">称号</h2>');
    const item = (list, ownedKey, curKey, kind) => list.forEach((x) => {
      const owned = cs[ownedKey].includes(x.id), on = cs[curKey] === x.id;
      srow(box, {
        html: `<b>${kind === 'title' ? '【' + x.name + '】' : x.name}</b>${on ? '　<span class="tag">つけている</span>' : ''}<div>${owned ? '持っている' : yen(x.price)}</div>`,
        buttons: [[owned ? (on ? 'はずす' : 'つける') : '買う', async () => {
          if (!owned) { cs[ownedKey].push(x.id); await pay(x.price); }
          cs[curKey] = on ? '' : x.id; await savePlayer(); applyLook(); renderShop();
        }, !owned && player.money < x.price]],
      });
    });
    item(TITLES, 'titles', 'title', 'title');
    box.insertAdjacentHTML('beforeend', '<h2 class="small" style="margin-top:12px">シールの枠</h2>');
    item(FRAMES, 'frames', 'frame', 'frame');
  }
  const titleText = () => { const t = TITLES.find((x) => x.id === player.cosmetics.title); return t ? t.name : ''; };
  $('btnShop').onclick = openShop;
  $('btnShopBack').onclick = () => { renderWallet(); show('home'); };

  // ---------- 家族クラウド ----------
  function renderCloud() {
    const box = $('cloudBtns'); box.innerHTML = '';
    if (!window.Cloud) { $('cloudState').textContent = 'クラウドは使えません（この端末にだけ保存されます）'; return; }
    const mkb = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; box.appendChild(b); };
    if (Cloud.isConnected()) {
      $('cloudState').innerHTML = `☁ 接続中　家族コード：<b>${Cloud.familyCode()}</b><br>${Cloud.status() || ''}`;
      mkb('🔄 今すぐ同期', cloudSync); mkb('📋 コードをコピー', cloudCopy); mkb('切断', cloudLeave);
    } else {
      $('cloudState').textContent = '未接続（いまは、この端末にだけ保存されています）';
      mkb('🆕 新しい家族を作る', cloudCreate); mkb('🔑 家族コードで参加', () => cloudJoin(false));
    }
  }
  const cloudMsg = (title, lines) => choose(title, [{ label: lines, value: 0, disabled: true }, { label: 'とじる', value: 0 }]);
  async function cloudCreate() {
    const ok = await choose('新しい家族を作る', [
      { label: 'この端末のプレイヤー（図鑑・お金・パーティ）が、クラウドに保存されます。家族コードが作られます。', value: 0, disabled: true },
      { label: '✅ 作る', value: 1 }, { label: 'やめる', value: 0 }]);
    if (!ok) return;
    try {
      const r = await Cloud.createFamily();
      renderCloud();
      await cloudMsg('家族コードができました', `<b style="font-size:20px">${r.code}</b><br><span class="small">ほかの端末で「🔑 家族コードで参加」に入れると、同じデータで遊べます。<b>家族以外には教えないでください。</b>メモしておくと安心です。</span>`);
    } catch (e) { await cloudMsg('作れませんでした', Cloud.explain(e)); }
  }
  async function cloudJoin(fromWelcome) {
    const code = (window.prompt('家族コード（12文字。例：k7m2-x9qa-4tzp）を入力してください', '') || '').trim();
    if (!code) return;
    try {
      const r = await Cloud.joinFamily(code);
      if (!fromWelcome) await loadProfiles();
      renderCloud();
      await cloudMsg('参加しました', `家族コード ${r.code} につながりました。<br><span class="small">プレイヤーを ${r.imported}人ぶん受け取り、${r.pushed}人ぶん送りました。</span>`);
    } catch (e) {
      const m = String(e.message);
      await cloudMsg('参加できませんでした', m === 'bad-code' ? '家族コードは12文字です。もう一度、入力してください。' : m === 'not-found' ? 'その家族コードの家族が見つかりません。コードを確かめてください。' : Cloud.explain(e));
    }
  }
  async function cloudSync() {
    try { const r = await Cloud.syncNow(); if (r.imported) await loadProfiles(); } catch (e) { /* 状態は画面に出る */ }
    renderCloud();
  }
  async function cloudCopy() {
    const code = Cloud.familyCode();
    try { await navigator.clipboard.writeText(code); await cloudMsg('コピーしました', code); } catch (e) { await cloudMsg('家族コード', `<b style="font-size:20px">${code}</b>`); }
  }
  async function cloudLeave() {
    const ok = await choose('切断しますか？', [
      { label: 'この端末だけ、家族クラウドとのつながりを切ります。クラウドのデータは、そのまま残ります（コードを入れれば、また参加できます）。', value: 0, disabled: true },
      { label: '切断する', value: 1 }, { label: 'やめる', value: 0 }]);
    if (ok) { Cloud.leave(); renderCloud(); }
  }

  // ---------- ボタン ----------
  $('btnAgain').onclick = () => startMatch(match ? match.maxGames : 1);
  $('btnHome').onclick = () => { renderWallet(); show('home'); };
  $('btnHelp').onclick = () => modal(`<h2 style="margin:0 0 8px;font-size:16px">あそびかた</h2>
    <p class="small" style="line-height:1.7">・バーコード（標準タイプのJAN。13桁）から、戦士の「シール」が決まります。先頭が45・49の商品が戦士（①②。45と49は同じ）、9784の書籍がアイテムです。それ以外は使えません。<br>
    ・戦士は、スキャン・ランダム・数字入力のあと、その場で図鑑に登録されます。シールは3層：キャラ（⑤⑥）／キラキラ（⑦⑧＝限界レベル。ベーシック10・レア20・EX30・ハロウィン40・スーパーレア50・レジェンド60）／属性（⑨）。③④は使いません。<br>
    ・限界レベルは、キラキラで最初から決まります（ベーシック10・レア20・EX30・ハロウィン40・スーパーレア50・レジェンド60）。同じシールの別ロットのバーコードで、さらに+5ずつ（最大Lv60）。<br>
    ・「👥 パーティ編成」で最大6体を選びます（同じキャラは1体まで）。持たせるアイテムも決めます（同じアイテムは1体まで）。<br>
    ・対戦は「⚔ シングル（1本）」か「🏆 3本勝負（同じ6体で最大3試合、先に2勝）」。相手のパーティと見せ合い、制限時間60秒で戦う3体と、先発・控えの順番を決めます。見えるのは相手の6体の姿と属性だけです。<br>
    ・選ぶときは、カードをタップするとステータス・スキル・アイテムの詳細が出ます。「🔎 相性ヒント」をオンにすると、相手のカードをタップして、自分の6体の有利・不利を確かめられます。<br>
    ・3本勝負では、前の試合で相手が出したキャラに「G」の印が付きます。試合のあとに、相手のパーティが公開されます。<br>
    ・毎ターン、自分と相手が<b>同時に</b>スキルか交代を決め、一斉に処理されます。順番は <b>交代 → 優先度の高いスキル → DXの高い順</b> です。<br>
    ・スキル：たたかう／クイック（優先度+1）／特殊技（防御無視・必中、3ターンに1回）／ガード（優先度+3、連続不可）／薬草／パワーキー／アイテム。<br>
    ・属性の相性：炎→風→土→雷→水→炎が有利（×1.5）。不利×0.5、同じ属性×0.75。<br>
    ・戦いのあとに、経験値（参加した3体）・お金・まれにアイテム（勝ち12%／負け3%）がもらえます。<br>
    ・「ランダム」は、戦士・アイテムそれぞれ1日1回だけです。<br>
    ・「☁ 家族クラウド」：家族コードで、端末をまたいで図鑑・お金・パーティを共有できます（コードは家族以外に教えないでください）。<br>
    ・「🏪 お店」：毎日かわる3つの品を買う／持ち物を売る／お金で経験値を買う「修行」（1日600XPまで）／次の試合だけの「持ち込み」（薬草+1・経験値×2）／称号とシールの枠（見た目だけ）。<br>
    ・書籍のアイテムは、手に入れると持ち物に入ります（同じバーコードは1回だけ）。使い切りの回復薬は、使うと持ち物からへります。</p>
    <button class="pri" onclick="document.getElementById('modalMask').classList.remove('on')" style="width:100%">閉じる</button>`);

  if (window.Cloud) Cloud.onStatus = renderCloud;
  renderCloud();   // まず表示する（このあとの読み込みで何かあっても、家族クラウドのボタンは出す）
  loadProfiles().then(() => {
    renderCloud();
    if (window.Cloud) Cloud.init(() => loadProfiles());   // つながっていれば、起動時に同期（新しいデータがあれば取り込む）
  }).catch((e) => { renderCloud(); if (window.__showErr) __showErr('読み込み：' + (e && (e.message || e))); });
})();
