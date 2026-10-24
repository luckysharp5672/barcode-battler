(function () {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rng = Math.random;
  const STATUS_JA = { poison: '毒', stun: '麻痺' };

  const slots = { char: { code: '', dec: null }, item: { code: '', dec: null } };
  let last = null; // 再戦用 { chDec, itDec }
  let cur = null;  // 現在の家族プロフィールID
  let dex = {};    // 現在のプロフィールの図鑑 { code: entry }

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
    setSlot('char', ''); setSlot('item', '');
  }
  $('profSel').onchange = async (e) => { await Store.setCurrent(e.target.value); await loadProfiles(); };
  $('btnNewProf').onclick = async () => {
    const name = (window.prompt('追加する家族のなまえ', '') || '').trim();
    if (name) { await Store.createProfile(name); await loadProfiles(); }
  };
  // 同じシール系統 = 先頭7桁が同じ（45と49は同じ扱い）。1系統につき戦士は1体だけ
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
      dex[d.code] = { code: d.code, idx: d.idx, name: d.name, attr: d.attr, kirakira: d.kirakira.key, limit: d.limit,
        xp: 0, level: 1, maxLv: BB.START_LIMIT, lots: [], wins: 0, losses: 0 };
      await Store.saveFighter(cur, dex[d.code]);
    } else if (st.type === 'lot') {
      st.entry.lots.push(s.code);
      st.entry.maxLv = BB.maxLevelOf(st.entry.limit, st.entry.lots.length);
      await Store.saveFighter(cur, st.entry);
    }
  }
  function statusText(st) {
    switch (st.type) {
      case 'new': return `🆕 新しい戦士として図鑑に登録されます（限界Lv${BB.START_LIMIT}）`;
      case 'known': return '';
      case 'lot': return `🎁 同じシールの別ロット！ ${st.entry.name} の限界Lv ${st.entry.maxLv} → ${BB.maxLevelOf(st.entry.limit, st.entry.lots.length + 1)}（対戦開始で確定）`;
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
      <div class="nm">🎁 ${d.name}</div><div class="small">${d.text}</div>${barSvg(d.code)}`;
  }

  // ---------- ホーム ----------
  function setSlot(kind, code) {
    const s = slots[kind];
    const cap = kind === 'char' ? 'Char' : 'Item';
    s.code = code.replace(/\D/g, '');
    $('in' + cap).value = s.code;
    s.dec = null;
    s.status = null;
    $('w' + cap).textContent = '';
    $('pv' + cap).innerHTML = '';
    if (kind === 'char') $('iChar').textContent = '';
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
    $('btnStart').disabled = !slots.char.dec || (slots.item.code && !slots.item.dec);
  }
  $('inChar').addEventListener('input', (e) => setSlot('char', e.target.value));
  $('inItem').addEventListener('input', (e) => setSlot('item', e.target.value));
  document.querySelectorAll('[data-rand]').forEach((b) => b.onclick = () => setSlot(b.dataset.rand, BB.randomCode(b.dataset.rand)));
  document.querySelectorAll('[data-clear]').forEach((b) => b.onclick = () => setSlot(b.dataset.clear, ''));
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

  // カメラスキャン（BarcodeDetector 対応ブラウザ + HTTPS/localhost が必要）
  let stream = null, scanning = false;
  async function openScan(kind) {
    $('scanMask').classList.add('on');
    $('scanMsg').textContent = '';
    if (!('BarcodeDetector' in window)) { $('scanMsg').textContent = 'このブラウザはバーコード読み取りに未対応です。数字を直接入力してください（Android Chromeなら使えます）'; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (e) { $('scanMsg').textContent = 'カメラを使えませんでした（HTTPS接続とカメラ許可が必要です）'; return; }
    const v = $('video');
    v.srcObject = stream; await v.play();
    const det = new BarcodeDetector({ formats: ['ean_13'] });
    scanning = true;
    while (scanning) {
      try {
        const r = await det.detect(v);
        if (r.length) { const raw = r[0].rawValue; closeScan(); setSlot(kind, raw); return; }
      } catch (e) { /* 読み取り失敗は無視して再試行 */ }
      await sleep(250);
    }
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
  // 攻撃タイミング：中央に近いほど 2 倍に近づく
  function timingMeter() {
    return new Promise((res) => {
      modal(`<h2 style="margin:0;font-size:16px;text-align:center">タイミングを合わせて！</h2>
        <div class="meter"><div class="sweet"></div><div class="mid"></div><div class="mk" id="mk"></div></div>
        <button class="pri" id="tapBtn" style="width:100%;font-size:20px">いまだ！</button>`);
      const t0 = performance.now(); let pos = 0, raf;
      const frame = (now) => {
        const p = ((now - t0) / 650) % 2; pos = p < 1 ? p : 2 - p;
        $('mk').style.left = pos * 100 + '%';
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      $('tapBtn').onclick = () => { cancelAnimationFrame(raf); closeModal(); res(1 + (1 - Math.abs(pos - 0.5) * 2)); };
    });
  }

  // ---------- 対戦 ----------
  let me, foe, logLines, turnCount = 0;
  function say(t) { logLines.push(t); if (logLines.length > 5) logLines.shift(); $('log').innerHTML = logLines.map((l) => `<div>${l}</div>`).join(''); }
  const cardOf = (side) => (side === 'me' ? $('meCard') : $('foeCard'));
  function fighterHtml(f, side) {
    const A = BB.ATTRS[f.attr], pct = Math.max(0, f.hp / f.maxHp * 100);
    const col = pct > 50 ? 'var(--hp)' : pct > 20 ? 'var(--hp2)' : 'var(--hp3)';
    const body = f.bodyAttr !== f.attr ? `（体:${BB.ATTRS[f.bodyAttr].name}）` : '';
    const atk = f.atkAttr !== f.attr ? `（攻:${BB.ATTRS[f.atkAttr].name}）` : '';
    const st = Object.keys(f.status).filter((k) => f.status[k] > 0).map((k) => STATUS_JA[k]).join('・');
    const it = f.item ? (f.item.effect.kind === 'consumable' && !f.consumable ? '' : `／🎁${f.item.name}`) : '';
    return `<div class="frow"><div class="stk"></div><div class="finfo">
      <div class="top"><span style="color:var(--${side})">${side === 'me' ? 'あなた' : 'てき'} ${f.name}</span><span>Lv${f.level}</span></div>
      <div class="hpwrap"><div class="hpbar" style="width:${pct}%;background:${col}"></div></div>
      <div class="small">HP ${f.hp}/${f.maxHp}${st ? ' ／ 💫' + st : ''}</div>
      <div class="small">${A.emoji}${A.name}${atk}${body} ／ 🌿${f.herbs} ／ ✨${f.spCd > 0 ? 'あと' + f.spCd : '使える'}${it}</div></div></div>`;
  }
  function render() {
    for (const [f, side] of [[foe, 'foe'], [me, 'me']]) {
      const card = cardOf(side);
      card.innerHTML = fighterHtml(f, side);
      card.querySelector('.stk').appendChild(f.canvas);
    }
  }
  async function flash(card, text, color) {
    card.classList.add('hit');
    const p = document.createElement('div'); p.className = 'pop'; p.style.color = color || '#fff'; p.textContent = text; card.appendChild(p);
    await sleep(700); card.classList.remove('hit'); p.remove();
  }

  // 敵のレベルは 1〜(自分のLv+2)（最低でも3まで）からランダム。敵のキラキラの限界は超えない
  function newFoe(myLv) {
    const ch = BB.decode(BB.randomCode('char'));
    const it = rng() < 0.5 ? BB.decode(BB.randomCode('item')) : null;
    return BB.makeFighter(ch, it, Math.min(ch.limit, 1 + Math.floor(rng() * Math.max(3, myLv + 2))));
  }

  async function startBattle(chDec, itDec) {
    last = { chDec, itDec };
    const myLv = levelOf(chDec.code);
    me = BB.makeFighter(chDec, itDec, myLv); foe = newFoe(myLv);
    [me.canvas, foe.canvas] = await Promise.all([makeSticker(me, 256), makeSticker(foe, 256)]);
    logLines = []; turnCount = 0;
    $('starLine').textContent = '相性：炎→風→土→雷→水→炎（有利×1.5／不利×0.5／同属性×0.75）';
    show('battle'); render();
    say(`${foe.name} が現れた！`);
    let turn = BB.initiative(me, rng) >= BB.initiative(foe, rng) ? 'me' : 'foe';
    say(turn === 'me' ? 'あなたの先攻！' : 'てきの先攻！');
    await sleep(900);
    while (me.hp > 0 && foe.hp > 0) {
      turnCount++;
      if (turn === 'me') await playerTurn(); else await foeTurn();
      render();
      turn = turn === 'me' ? 'foe' : 'me';
      await sleep(300);
    }
    await sleep(700);
    const win = me.hp > 0;
    $('resEmo').textContent = win ? '🏆' : '💀';
    $('resTitle').textContent = win ? 'しょうり！' : 'はいぼく…';
    const e = dex[chDec.code], oldLv = e.level, oldXp = e.xp;
    e.xp = Math.min(e.xp + (win ? 30 + 5 * foe.level : 10), BB.xpForLevel(e.maxLv));
    const gain = e.xp - oldXp;
    e.level = BB.levelFromXp(e.xp, e.maxLv); e[win ? 'wins' : 'losses']++;
    await Store.saveFighter(cur, e);
    const lvUp = e.level > oldLv ? `\n🎉 レベルアップ！ Lv${oldLv} → Lv${e.level}` : '';
    const limitMsg = e.maxLv < e.limit
      ? `Lv${e.level}（限界です。同じシールの別ロットのバーコードで限界Lv+${BB.LOT_STEP}。キラキラの上限は Lv${e.limit}）`
      : `Lv${e.level}（キラキラの最大 Lv${e.limit} です）`;
    $('resSub').style.whiteSpace = 'pre-line';
    $('resSub').textContent = `${win ? foe.name + ' を倒した' : foe.name + ' に倒された'}\n${e.level >= e.maxLv ? limitMsg : `経験値 +${gain}（Lv${e.level}  次まで ${BB.xpForLevel(e.level + 1) - e.xp}）`}${lvUp}`;
    show('result');
  }

  const effText = (m) => (m >= 1.5 ? '効果は抜群！' : m <= 0.5 ? '効果はいまひとつ…' : m < 1 ? 'あまり効かない…' : '');

  // 通常攻撃
  async function doAttack(att, def, side, timing) {
    if (!BB.rollHit(att, def, rng)) { say('しかし攻撃は外れた！'); await sleep(600); return; }
    const r = BB.calcDamage(att, def, timing, rng);
    r.dmg = Math.max(1, Math.round(r.dmg * BB.fatigue(Math.ceil(turnCount / 2))));
    def.hp = Math.max(0, def.hp - r.dmg);
    if (effText(r.mult)) say(effText(r.mult));
    say(r.crit ? `会心の一撃！ ${r.dmg} のダメージ！` : `${r.dmg} のダメージ！`);
    await flash(cardOf(side === 'me' ? 'foe' : 'me'), '-' + r.dmg, r.crit ? '#ffd700' : '#ff7b72');
    for (const k of BB.tryInflict(att, def, rng)) say(`${def.name} は${STATUS_JA[k]}になった！`);
  }
  // 特殊技（特殊能力値で攻撃。防御無視・必中。3ターンに1回）
  async function doSpecial(att, def, side, timing) {
    att.spCd = BB.SP_COOLDOWN;
    say(`${att.name} の特殊技！`);
    const r = BB.specialDamage(att, def, timing);
    r.dmg = Math.max(1, Math.round(r.dmg * BB.fatigue(Math.ceil(turnCount / 2))));
    def.hp = Math.max(0, def.hp - r.dmg);
    if (effText(r.mult)) say(effText(r.mult));
    say(`${r.dmg} のダメージ！`);
    await flash(cardOf(side === 'me' ? 'foe' : 'me'), '-' + r.dmg, '#a371f7');
  }
  async function herb(f, n, side) {
    f.herbs -= n;
    const v = BB.healAmount(f, n);
    f.hp += v;
    say(`薬草を${n}個使って ${v} 回復！`);
    await flash(cardOf(side), '+' + v, '#3fb950');
  }
  async function powerKey(f, side, timing) {
    f.herbs -= 1;
    const { amount } = BB.powerHeal(f, timing, rng);
    f.hp += amount;
    say(`パワーキー！ ${amount} 回復！`);
    await flash(cardOf(side), '+' + amount, '#3fb950');
  }
  async function useItem(f, side) {
    const name = f.item.name;
    const healed = BB.useConsumable(f);
    say(`${name} を使った！${healed ? ` ${healed} 回復！` : ''}`);
    await flash(cardOf(side), healed ? '+' + healed : name, '#3fb950');
  }

  // ターンの始め。毒のダメージ・麻痺の判定。true なら行動できない（または倒れた）
  async function beginTurn(f, side) {
    const t = BB.startTurn(f);
    if (t.poison) { say(`${f.name} は毒で ${t.poison} のダメージ！`); await flash(cardOf(side), '-' + t.poison, '#a371f7'); }
    if (f.hp <= 0) return true;
    if (t.skip) { say(`${f.name} は麻痺して動けない！`); await sleep(700); return true; }
    return false;
  }

  async function playerTurn() {
    if (await beginTurn(me, 'me')) return;
    render();
    for (;;) {
      const hurt = me.hp >= me.maxHp;
      const acts = [{ label: '⚔ たたかう', value: 'atk' },
        { label: `✨ 特殊技（${me.spCd > 0 ? 'あと' + me.spCd + 'ターン' : '防御無視・必中'}）`, value: 'sp', disabled: me.spCd > 0 }];
      if (me.herbs > 0) {
        acts.push({ label: `🌿 薬草 (残り${me.herbs})`, value: 'herb', disabled: hurt });
        acts.push({ label: '🔑 パワーキー (薬草-1)', value: 'power', disabled: hurt });
      }
      if (me.consumable) acts.push({ label: `🎁 ${me.item.name}を使う`, value: 'item' });
      const a = await choose('どうする？', acts);
      if (a === 'atk') { await doAttack(me, foe, 'me', await timingMeter()); return; }
      if (a === 'sp') { await doSpecial(me, foe, 'me', await timingMeter()); return; }
      if (a === 'power') { const t = await timingMeter(); await powerKey(me, 'me', 1 + (t - 1) * 0.4); return; }
      if (a === 'item') { await useItem(me, 'me'); return; }
      if (a === 'herb') {
        const opts = [];
        for (let n = 1; n <= me.herbs; n++) opts.push({ label: `${n}個使う（約${n * 20}%回復）`, value: n });
        opts.push({ label: '← 戻る', value: 0 });
        const n = await choose('薬草', opts);
        if (n) { await herb(me, n, 'me'); return; }
      }
    }
  }

  async function foeTurn() {
    say(`${foe.name} のターン`);
    await sleep(500);
    if (await beginTurn(foe, 'foe')) return;
    if (foe.consumable && foe.hp < foe.maxHp * 0.5 && rng() < 0.7) { await useItem(foe, 'foe'); return; }
    if (foe.hp < foe.maxHp * 0.35 && foe.herbs > 0 && rng() < 0.6) {
      if (rng() < 0.5) await powerKey(foe, 'foe', 1 + rng() * 0.4);
      else await herb(foe, Math.min(foe.herbs, 1 + Math.floor(rng() * 2)), 'foe');
      return;
    }
    if (foe.spCd === 0 && rng() < 0.6) { await doSpecial(foe, me, 'foe', 1 + rng() * 0.8); return; }
    await doAttack(foe, me, 'foe', 1 + rng() * 0.8);
  }

  // ---------- ボタン ----------
  $('btnStart').onclick = async () => {
    $('btnStart').disabled = true;
    await commitChar();
    startBattle(slots.char.dec, slots.item.dec);
  };
  $('btnAgain').onclick = () => startBattle(last.chDec, last.itDec);
  $('btnHome').onclick = () => { setSlot('char', slots.char.code); show('home'); };
  $('btnHelp').onclick = () => modal(`<h2 style="margin:0 0 8px;font-size:16px">あそびかた</h2>
    <p class="small" style="line-height:1.7">・バーコード（標準タイプのJAN。13桁）の先頭7桁から、戦士の「シール」が決まります。先頭が45・49の商品が戦士（45と49は同じ扱い）、9784の書籍がアイテムです。それ以外は使えません。<br>
    ・シールは3層：キャラ（③④）／キラキラ（⑤⑥＝限界レベル。ベーシック10・レア20・EX30・ハロウィン40・スーパーレア50・レジェンド60）／属性（⑦）。<br>
    ・属性の相性：炎→風→土→雷→水→炎が有利（×1.5）。不利×0.5、同じ属性×0.75。<br>
    ・限界レベルは最初Lv5。同じシールの別ロットのバーコードで+5ずつ、キラキラの限界まで上がります。<br>
    ・攻撃は<b>タイミングメーター</b>を中央で止めるほどダメージ最大2倍。特殊技は防御無視・必中で3ターンに1回。<br>
    ・薬草は3個。「薬草」は確実に回復、「パワーキー」は薬草1個で運とタイミング次第の大回復。<br>
    ・書籍のアイテムは武器・防具・アクセサリー（能力アップなど）か、使い切りの回復薬。<br>
    ・先にHPが0になった方の負けです。</p>
    <button class="pri" onclick="document.getElementById('modalMask').classList.remove('on')" style="width:100%">閉じる</button>`);

  loadProfiles();
})();
