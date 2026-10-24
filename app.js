(function () {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rng = Math.random;
  const STATUS_JA = { poison: '毒', stun: '麻痺' };

  const slots = { char: { code: '', dec: null }, item: { code: '', dec: null } };
  let cur = null;  // 現在の家族プロフィールID
  let dex = {};    // 現在のプロフィールの図鑑 { code: entry }
  let daily = {};  // 今日のランダムの記録 { char: {date, code}, item: {date, code} }
  let player = { money: 0, bag: {}, itemCodes: [], party: { members: [], items: {} } }; // お金・持ち物・手に入れた書籍のコード・パーティ

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
      const name = (window.prompt('なまえを入力してください', '') || '').trim() || 'プレイヤー';
      await Store.createProfile(name); list = await Store.listProfiles();
    }
    cur = (await Store.getCurrent()) || list[0].id;
    $('profSel').innerHTML = list.map((p) => `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>👤 ${p.name}</option>`).join('');
    dex = await Store.getDex(cur);
    daily = await Store.getDaily(cur);
    player = await Store.getPlayer(cur);
    updateRandButtons(); renderWallet();
    // 現在のルールで無効なデータは表示しない（保存データは消さない）。名前・限界は最新のデータに合わせる
    Object.keys(dex).forEach((c) => {
      const d = BB.decode(c);
      if (!d || d.kind !== 'char') { delete dex[c]; return; }
      const e = dex[c];
      Object.assign(e, { idx: d.idx, name: d.name, attr: d.attr, kirakira: d.kirakira.key, limit: d.limit });
      e.lots = e.lots || [];
      e.maxLv = BB.maxLevelOf(d.limit, e.lots.length);
      e.level = Math.min(e.level, e.maxLv);
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
    if (e.maxLv >= e.limit) return { type: 'lotMax', entry: e };
    return { type: 'lot', entry: e };
  }
  // 「対戦開始」で確定：新規登録 or 別ロットで限界Lv+5（キラキラの限界まで）
  async function commitChar() {
    const s = slots.char, st = s.status;
    if (st.type === 'new') {
      const d = s.dec;
      if (dex[d.code]) return;
      dex[d.code] = { code: d.code, idx: d.idx, name: d.name, attr: d.attr, kirakira: d.kirakira.key, limit: d.limit,
        xp: 0, level: 1, maxLv: BB.START_LIMIT, lots: [], wins: 0, losses: 0 };
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
      case 'new': return `🆕 新しい戦士です（入力を確定すると図鑑に登録されます。限界Lv${BB.START_LIMIT}）`;
      case 'known': return '';
      case 'lot': return `🎁 同じシールの別ロット！ ${st.entry.name} の限界Lv ${st.entry.maxLv} → ${BB.maxLevelOf(st.entry.limit, st.entry.lots.length + 1)}（入力を確定すると反映されます）`;
      case 'lotUsed': return `このバーコードは使用済みです。${st.entry.name} を呼び出しました`;
      case 'lotMax': return `${st.entry.name} はすでにキラキラの限界Lv${st.entry.limit}です`;
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
      const A = BB.ATTRS[d.attr], lv = entry ? entry.level : 1, mx = entry ? entry.maxLv : BB.START_LIMIT;
      return `<div class="stkwrap" id="stk${cap}"></div>
        <div class="nm">${A.emoji} ${d.name} <span class="small">${d.role}</span></div>
        <span class="tag">${A.name}属性</span><span class="tag">✨${d.kirakira.name}</span><span class="tag">${d.type}</span>
        <div class="small" style="margin-top:6px">Lv${lv} / 限界Lv${mx}（キラキラの上限 Lv${d.limit}）</div>
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
    const msg = st.type === 'new' ? `🆕 ${name} を図鑑に登録しました！（限界Lv${BB.START_LIMIT}）`
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
  function renderWallet() { $('wallet').textContent = `💰 ${player.money.toLocaleString()}　🎒 持ち物 ${bagCount()}個`; }
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
      mk('🎁 アイテム', () => pickPartyItem(e.code));
      mk('外す', async () => { player.party.members = player.party.members.filter((c) => c !== e.code); delete player.party.items[e.code]; await savePlayer(); renderParty(); });
    } else {
      const dup = idxs.has(e.idx), full = partyCodes().length >= PARTY_MAX;
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

  // ---------- 見せ合い・選出（制限時間つき） ----------
  let myParty = [], foeParty = [], picked = [], pickTimer = null;
  function memberFighter(code) {
    const id = player.party.items[code];
    return BB.makeFighter(BB.decode(code), id ? BB.itemById(id) : null, dex[code].level);
  }
  // hidden=true（相手の6体）は、姿（シール）と属性だけ。名前・レベル・アイテム・スキルは見せない
  function pcard(f, onClick, hidden) {
    const A = BB.ATTRS[f.attr];
    const el = document.createElement('div'); el.className = 'pcard';
    const th = document.createElement('div'); th.className = 'pth'; th.appendChild(f.canvas); el.appendChild(th);
    el.insertAdjacentHTML('beforeend', hidden
      ? `<div>${A.emoji} ${A.name}属性</div>`
      : `<div>${A.emoji} ${f.name}</div><div class="small">Lv${f.level}${f.item ? ' ／ 🎁' + f.item.name : ''}</div>`);
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
  function renderPick() {
    $('pvFoe').innerHTML = ''; $('pvMine').innerHTML = '';
    foeParty.forEach((f) => $('pvFoe').appendChild(pcard(f, null, true)));
    myParty.forEach((f, i) => {
      const el = pcard(f, () => {
        const at = picked.indexOf(i);
        if (at >= 0) picked.splice(at, 1); else if (picked.length < PICK) picked.push(i);
        renderPick();
      });
      const at = picked.indexOf(i);
      if (at >= 0) { el.classList.add('sel'); el.insertAdjacentHTML('afterbegin', `<span class="pk">${at + 1}</span>`); }
      $('pvMine').appendChild(el);
    });
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
  async function startSingle() {
    const codes = partyCodes();
    if (codes.length < PICK) {
      const v = await choose('パーティが足りません', [
        { label: `対戦には${PICK}体以上必要です（いま${codes.length}体）`, value: 0, disabled: true },
        { label: '👥 パーティ編成へ', value: 1 }, { label: '← 戻る', value: 0 }]);
      if (v) openParty();
      return;
    }
    myParty = codes.map(memberFighter);
    const avg = Math.round(myParty.reduce((a, f) => a + f.level, 0) / myParty.length);
    foeParty = Battle.generateCpuParty(avg, rng, PARTY_MAX);
    await Promise.all([...myParty, ...foeParty].map(async (f) => { f.canvas = await makeSticker(f, 160); }));
    picked = [];
    renderPick(); show('preview');
    let left = PICK_SECONDS;
    $('pickTimer').textContent = left;
    clearInterval(pickTimer);
    pickTimer = setInterval(() => {
      left--; $('pickTimer').textContent = Math.max(0, left);
      if (left <= 0) { // 時間切れ：レベルの高い順に自動で選ぶ
        const rest = myParty.map((f, i) => i).filter((i) => !picked.includes(i)).sort((a, b) => myParty[b].level - myParty[a].level);
        while (picked.length < PICK) picked.push(rest.shift());
        confirmPick();
      }
    }, 1000);
  }
  function confirmPick() {
    clearInterval(pickTimer);
    const foeSel = Battle.cpuSelect(foeParty, myParty, PICK);
    runBattle(picked.map((i) => myParty[i]), foeSel.map((i) => foeParty[i]));
  }
  $('btnPick').onclick = confirmPick;
  $('btnBattle').onclick = startSingle;

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
    const chips = side.party.map((m, i) => {
      const known = s === 0 || view.seen[s].has(i);   // 相手の控えは、場に出てくるまで「？」
      return `<span class="chip ${i === idx ? 'on' : ''} ${view.hp[s][i] <= 0 ? 'dead' : ''}">${known ? m.name : '？'}</span>`;
    }).join('');
    const hpText = s === 0 ? `HP ${hp}/${f.maxHp}` : `HP ${Math.ceil(pct)}%`;                  // 相手のHPは%だけ
    const detail = s === 0
      ? `${A.emoji}${A.name}${atk}${body} ／ 🌿${view.herbs[s]} ／ ✨${f.spCd > 0 ? 'あと' + f.spCd : '使える'}${f.item && (f.item.effect.kind !== 'consumable' || f.consumable) ? '／🎁' + f.item.name : ''}`
      : `${A.emoji}${A.name}属性`;                                                             // 相手の装備・スキルの状態は非公開
    return `<div class="frow"><div class="stk"></div><div class="finfo">
      <div class="top"><span style="color:var(--${s === 0 ? 'me' : 'foe'})">${sideName(s)} ${f.name}</span><span>Lv${f.level}</span></div>
      <div class="hpwrap"><div class="hpbar" style="width:${pct}%;background:${col}"></div></div>
      <div class="small">${hpText}${stt ? ' ／ 💫' + stt : ''}</div>
      <div class="small">${detail}</div>
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
        { label: '⚔ スキル', value: 'skill' },
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

  async function runBattle(mineList, foeList) {
    st = Battle.createBattle(Battle.createSide('あなた', mineList), Battle.createSide('てき', foeList));
    view = { hp: st.sides.map((sd) => sd.party.map((f) => f.hp)), active: [0, 0], herbs: [3, 3], seen: [new Set([0]), new Set([0])] };
    logLines = [];
    $('starLine').textContent = '相性：炎→風→土→雷→水→炎（有利×1.5／不利×0.5／同属性×0.75）　交代 → 優先度の高いスキル → DXの高い順';
    show('battle'); renderBattle();
    say(`${foeList[0].name} が勝負をしかけてきた！`); await sleep(700);
    while (!st.over) {
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
    await finishBattle();
  }

  // 結果：参加した3体に経験値、お金、まれにアイテム
  async function finishBattle() {
    const win = st.winner === 0, draw = st.winner === -1;
    $('resEmo').textContent = win ? '🏆' : draw ? '🤝' : '💀';
    $('resTitle').textContent = win ? 'しょうり！' : draw ? 'ひきわけ' : 'はいぼく…';
    const foeList = st.sides[1].party, mineList = st.sides[0].party;
    const avgFoe = Math.round(foeList.reduce((a, f) => a + f.level, 0) / foeList.length);
    $('resSub').textContent = win ? 'てきのパーティを全員たおした' : draw ? 'どちらも全員が戦えなくなった' : 'パーティが全員たおされた';
    const members = [];
    for (const f of mineList) {
      const e = dex[f.code], oldLv = e.level, oldXp = e.xp;
      e.xp = Math.min(e.xp + (win ? 30 + 5 * avgFoe : 10), BB.xpForLevel(e.maxLv));
      const gain = e.xp - oldXp;
      e.level = BB.levelFromXp(e.xp, e.maxLv); e[win ? 'wins' : 'losses']++;
      await Store.saveFighter(cur, e);
      members.push({ name: f.name, oldLv, e, gain });
    }
    const gold = BB.rewardMoney(win, avgFoe, rng);
    player.money += gold;
    for (const id of st.sides[0].usedItems) { // 使い切りのアイテムは、持ち物からへる
      player.bag[id] = (player.bag[id] || 1) - 1; if (player.bag[id] <= 0) delete player.bag[id];
      for (const c of Object.keys(player.party.items)) if (player.party.items[c] === id) delete player.party.items[c];
    }
    const dropId = BB.rollDrop(win, rng);
    if (dropId) player.bag[dropId] = (player.bag[dropId] || 0) + 1;
    await savePlayer();
    show('result');
    renderRewards({ members, gold, drop: dropId ? BB.itemById(dropId) : null });
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
        : (e.maxLv < e.limit ? `限界です（別ロットで限界Lv+${BB.LOT_STEP}。上限 Lv${e.limit}）` : `最大 Lv${e.limit}`);
      return `<div style="margin-bottom:8px"><div class="rt">${m.name} <b>+${m.gain}</b> <span class="small">Lv${e.level}　${note}</span></div>
        <div class="xpbar"><div style="width:${pct}%"></div></div>${e.level > m.oldLv ? `<div class="lvup">🎉 レベルアップ！ Lv${m.oldLv} → Lv${e.level}</div>` : ''}</div>`;
    }).join('');
    add(`<div class="ic">⭐</div><div class="rb"><div class="rt" style="margin-bottom:6px">経験値</div>${rows}</div>`);
    add(`<div class="ic">💰</div><div class="rb"><div class="rt">お金 <b>+${r.gold.toLocaleString()}</b></div><div class="small">所持金 ${player.money.toLocaleString()}</div></div>`);
    if (r.drop) {
      const el = add(`<div class="rimg"></div><div class="rb"><div class="rt">🎁 アイテムを手に入れた！</div><div class="rn">${r.drop.name}</div>
        <div class="small">${r.drop.text}</div><div class="small">🎒 持ち物に入りました（${player.bag[r.drop.itemId]}個）</div></div>`, 'drop');
      makeSticker(r.drop, 192).then((c) => el.querySelector('.rimg').appendChild(c));
    } else {
      add('<div class="ic">🎁</div><div class="rb"><div class="rt">アイテム</div><div class="small">今回はなし（まれに手に入ります）</div></div>', 'none');
    }
  }

  // ---------- ボタン ----------
  $('btnAgain').onclick = startSingle;
  $('btnHome').onclick = () => { renderWallet(); show('home'); };
  $('btnHelp').onclick = () => modal(`<h2 style="margin:0 0 8px;font-size:16px">あそびかた</h2>
    <p class="small" style="line-height:1.7">・バーコード（標準タイプのJAN。13桁）から、戦士の「シール」が決まります。先頭が45・49の商品が戦士（①②。45と49は同じ）、9784の書籍がアイテムです。それ以外は使えません。<br>
    ・戦士は、スキャン・ランダム・数字入力のあと、その場で図鑑に登録されます。シールは3層：キャラ（⑤⑥）／キラキラ（⑦⑧＝限界レベル。ベーシック10・レア20・EX30・ハロウィン40・スーパーレア50・レジェンド60）／属性（⑨）。③④は使いません。<br>
    ・限界レベルは最初Lv5。同じシールの別ロットのバーコードで+5ずつ、キラキラの限界まで上がります。<br>
    ・「👥 パーティ編成」で最大6体を選びます（同じキャラは1体まで）。持たせるアイテムも決めます（同じアイテムは1体まで）。<br>
    ・対戦は「⚔ シングルバトル」：相手のパーティと見せ合い、制限時間内に戦う3体を選びます。<br>
    ・毎ターン、自分と相手が<b>同時に</b>スキルか交代を決め、一斉に処理されます。順番は <b>交代 → 優先度の高いスキル → DXの高い順</b> です。<br>
    ・スキル：たたかう／クイック（優先度+1）／特殊技（防御無視・必中、3ターンに1回）／ガード（優先度+3、連続不可）／薬草／パワーキー／アイテム。<br>
    ・属性の相性：炎→風→土→雷→水→炎が有利（×1.5）。不利×0.5、同じ属性×0.75。<br>
    ・戦いのあとに、経験値（参加した3体）・お金・まれにアイテム（勝ち12%／負け3%）がもらえます。<br>
    ・「ランダム」は、戦士・アイテムそれぞれ1日1回だけです。<br>
    ・書籍のアイテムは、手に入れると持ち物に入ります（同じバーコードは1回だけ）。使い切りの回復薬は、使うと持ち物からへります。</p>
    <button class="pri" onclick="document.getElementById('modalMask').classList.remove('on')" style="width:100%">閉じる</button>`);

  loadProfiles();
})();
