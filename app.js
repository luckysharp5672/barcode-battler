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
  let player = { money: 0, bag: {}, itemCodes: [], party: { members: [], items: {} }, shop: { date: '', bought: [] }, train: { date: '', xp: 0 }, carry: { herbs: 0, boost: false }, xp2: '', stageClear: 0, cosmetics: { titles: [], title: '', frames: [], frame: '' } };

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
      loadImg(dec.idx >= 100 && BB.COLLAB.chars[dec.idx - 100] ? BB.COLLAB.chars[dec.idx - 100].img : `assets/chars/${String(dec.idx).padStart(2, '0')}.webp`),
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
      // はじめての端末：家族コードで参加すれば、ほかの端末のユーザーを受け取れる
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
      if (e.bonus === undefined) e.bonus = e.lots.length;       // 限界レベルを上げた回数（1回で+10）
      e.maxLv = BB.maxLevelOf(d.limit, e.bonus);
      e.level = Math.min(e.level || 1, e.maxLv);
    });
    // 45と49で同じ戦士になった重複は、経験値が多い方を残す
    const seen = {};
    Object.values(dex).forEach((e) => {
      const k = BB.identityKey(e.code), o = seen[k];
      if (!o) { seen[k] = e; return; }
      // 同じキャラ・同じ属性が2体いたら、上位のキラキラ（同じなら経験値の多い方）を残す
      const better = (BB.kkRank(e.kirakira) - BB.kkRank(o.kirakira)) || (e.xp - o.xp);
      const keep = better > 0 ? e : o, drop = keep === e ? o : e;
      keep.lots = [...new Set([...keep.lots, ...drop.lots, drop.code])]; keep.bonus = (keep.bonus || 0) + (drop.bonus || 0);
      keep.maxLv = BB.maxLevelOf(keep.limit, keep.bonus); keep.level = Math.min(Math.max(keep.level, drop.level), keep.maxLv); keep.xp = Math.max(keep.xp, drop.xp);
      delete dex[drop.code]; seen[k] = keep; Store.removeFighter(cur, drop.code); Store.saveFighter(cur, keep);
    });
    cleanParty();
    setSlot('char', ''); setSlot('item', '');
  }
  $('profSel').onchange = async (e) => { await Store.setCurrent(e.target.value); await loadProfiles(); };
  $('btnNewProf').onclick = async () => {
    const name = (window.prompt('追加するユーザーのなまえ', '') || '').trim();
    if (name) { await Store.createProfile(name); await loadProfiles(); }
  };
  // ユーザーの削除：このユーザーのデータをすべて消す（家族クラウドにつないでいれば、ほかの端末からも消える）
  $('btnDelProf').onclick = async () => {
    const me = (await Store.listProfiles()).find((p) => p.id === cur);
    if (!me) return;
    const linked = window.Cloud && Cloud.isConnected();
    const ok = await choose(`ユーザー「${me.name}」を削除しますか？`, [
      { label: `戦士 ${Object.keys(dex).length}体・お金 ${player.money.toLocaleString()}・持ち物 ${bagCount()}個など、このユーザーのデータが、すべて消えます。${linked ? '<br><b>家族クラウドにつないでいるので、ほかの端末からも消えます。</b>' : ''}<br>元には戻せません。`, value: 0, disabled: true },
      { label: '🗑 削除する（元に戻せません）', value: 1 }, { label: 'やめる', value: 0 }]);
    if (!ok) return;
    if (linked) await Cloud.deletePlayer(cur);
    await Store.deleteProfile(cur);
    await loadProfiles();
    renderCloud();
  };
  // 同じシール = キャラ(⑤⑥)・キラキラ(⑦⑧)・属性(⑨)が同じ（45と49は同じ扱い、③④は見ない）。1つのシールにつき戦士は1体だけ
  const prefixOf = (code) => BB.identityKey(code);
  // バーコードの扱いを判定する（図鑑は変更しない）
  function lookup(code, collab) {
    const key = collab ? 'c' + code : code;            // コラボは別の枠（同じバーコードを、通常とコラボで1回ずつ使える）
    if (dex[key]) return { type: 'known', entry: dex[key] };
    const e = Object.values(dex).find((x) => prefixOf(x.code) === prefixOf(key));
    if (!e) return { type: 'new' };
    if (e.lots.includes(key)) return { type: 'lotUsed', entry: e };
    const nd = BB.decode(key);
    if (nd && nd.kirakira.rank > BB.kkRank(e.kirakira)) return { type: 'upgrade', entry: e };   // 上位のキラキラ：上書き
    if (e.maxLv >= BB.MAX_LV) return { type: 'lotMax', entry: e };
    return { type: 'lot', entry: e };                                                          // 同等か下位：限界Lv+10
  }
  // 確定：新規登録 / 上位のキラキラなら上書き / 同等・下位なら限界Lv+10（最大Lv99まで）
  async function commitChar() {
    const s = slots.char, st = s.status;
    if (st.type === 'new') {
      const d = s.dec;
      if (dex[d.code]) return;
      dex[d.code] = { code: d.code, idx: d.idx, name: d.name, attr: d.attr, kirakira: d.kirakira.key, limit: d.limit,
        xp: BB.xpForLevel(d.kirakira.startLv), level: d.kirakira.startLv, maxLv: d.limit, lots: [], bonus: 0, wins: 0, losses: 0 };
      if (d.collab) dex[d.code].collab = true;
      await Store.saveFighter(cur, dex[d.code]);
    } else if (st.type === 'lot') {
      const key = s.collab ? 'c' + s.code : s.code, E = st.entry;
      if (E.lots.includes(key)) return;
      if (E.bonus === undefined) E.bonus = E.lots.length;
      E.lots.push(key); E.bonus++;
      E.maxLv = BB.maxLevelOf(E.limit, E.bonus);
      await Store.saveFighter(cur, E);
    } else if (st.type === 'upgrade') {
      // 上位のキラキラに上書き：バーコードが新しいものに変わる。レベル・経験値・勝敗・限界アップの回数は引きつぐ
      const d = s.dec, E = st.entry, old = E.code;
      if (E.bonus === undefined) E.bonus = E.lots.length;
      delete dex[old]; await Store.removeFighter(cur, old);
      E.lots = [...new Set([...E.lots, old])];
      Object.assign(E, { code: d.code, kirakira: d.kirakira.key, limit: d.limit });
      E.maxLv = BB.maxLevelOf(d.limit, E.bonus);
      E.xp = Math.max(E.xp, BB.xpForLevel(d.kirakira.startLv)); E.level = Math.min(Math.max(E.level, d.kirakira.startLv), E.maxLv);
      dex[d.code] = E;
      const p = player.party;
      p.members = p.members.map((c) => (c === old ? d.code : c));
      if (p.items[old]) { p.items[d.code] = p.items[old]; delete p.items[old]; }
      await Store.saveFighter(cur, E); await savePlayer();
    }
  }
  // 表示用：漢字のアイテム名をひらがなに（子ども向け）
  const ITEM_KANA = {"木の剣": "きのつるぎ", "鉄の剣": "てつのつるぎ", "鋼の剣": "はがねのつるぎ", "ミスリルの剣": "ミスリルのつるぎ", "炎の剣": "ほのおのつるぎ", "紅蓮の大剣": "ぐれんのたいけん", "水の刃": "みずのやいば", "聖剣": "せいけん", "影の刃": "かげのやいば", "樫の杖": "かしのつえ", "魔術師の杖": "まじゅつしのつえ", "賢者の杖": "けんじゃのつえ", "短弓": "たんきゅう", "長弓": "ちょうきゅう", "疾風の弓": "はやてのゆみ", "暴風の長弓": "ぼうふうのちょうきゅう", "潮騒の槍": "しおさいのやり", "雷の槍": "かみなりのやり", "大地のハンマー": "だいちのハンマー", "巨岩の大槌": "きょがんのおおづち", "麻痺のハンマー": "まひのハンマー", "紫電のダガー": "しでんのダガー", "毒のダガー": "どくのダガー", "鬼神の戦斧": "きしんのいくさおの", "革の鎧": "かわのよろい", "鎖かたびら": "くさりかたびら", "板金の鎧": "ばんきんのよろい", "竜鱗の鎧": "りゅうりんのよろい", "魔道士のローブ": "まどうしのローブ", "聖なるローブ": "せいなるローブ", "聖なるマント": "せいなるマント", "清めの鎖鎧": "きよめのくさりよろい", "炎の鎧": "ほのおのよろい", "灼熱の鎧": "しゃくねつのよろい", "水の鎧": "みずのよろい", "潮の鎧": "しおのよろい", "岩の鎧": "いわのよろい", "巨岩の鎧": "きょがんのよろい", "雷の鎧": "かみなりのよろい", "紫電の鎧": "しでんのよろい", "風の鎧": "かぜのよろい", "嵐の鎧": "あらしのよろい", "疾風の指輪": "はやてのゆびわ", "力の腕輪": "ちからのうでわ", "鍛錬の腕輪": "たんれんのうでわ", "守りの護符": "まもりのごふ", "賢者の耳飾り": "けんじゃのみみかざり", "跳躍のブーツ": "ちょうやくのブーツ", "生命のお守り": "せいめいのおまもり", "勇者の紋章": "ゆうしゃのもんしょう", "毒消しの護符": "どくけしのごふ", "目覚ましの護符": "めざましのごふ", "鉄の意志": "てつのいし", "五属性の指輪": "ごぞくせいのゆびわ", "炎の指輪": "ほのおのゆびわ", "水の指輪": "みずのゆびわ", "岩の指輪": "いわのゆびわ", "雷の指輪": "かみなりのゆびわ", "風の指輪": "かぜのゆびわ", "完全なる護り": "かんぜんなるまもり", "守護核": "しゅごかく", "万能薬": "ばんのうやく"};
  const kanaItem = (n) => ITEM_KANA[n] || n;
  const ATTR_JA = ['かぜ', 'つち', 'みず', 'ほのお', 'かみなり'];
  const TYPE_JA = (t) => String(t).replace(/特殊能力/g, 'とくしゅ').replace(/攻撃/g, 'こうげき').replace(/防御/g, 'ぼうぎょ').replace(/速度/g, 'すばやさ').replace(/体力/g, 'たいりょく').replace(/特化型/g, 'とっか').replace(/型/g, 'タイプ');
  function statusText(st) {
    switch (st.type) {
      case 'new': return `🆕 あたらしいキャラです（げんかいLv${slots.char.dec ? slots.char.dec.limit : ''}）`;
      case 'known': return '';
      case 'lot': return `🎁 おなじキャラ・おなじぞくせい！ ${st.entry.name} の げんかいLv ${st.entry.maxLv} → ${BB.maxLevelOf(st.entry.limit, (st.entry.bonus || 0) + 1)}`;
      case 'upgrade': return `✨ うえのキラキラです！ ${st.entry.name} が ${slots.char.dec ? slots.char.dec.kirakira.name : ''} に なります`;
      case 'lotUsed': return `このバーコードは しようずみです。${st.entry.name} を よびだしました`;
      case 'lotMax': return `${st.entry.name} は もう いちばんうえの げんかいLv${BB.MAX_LV}です`;
    }
  }

  // ---------- 表示部品 ----------
  function barSvg(code) {
    const bits = BB.barBits(code);
    let rects = '';
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') rects += `<rect x="${i}" y="0" width="1" height="40"/>`;
    return `<svg class="bar" viewBox="-6 -4 ${bits.length + 12} 48" preserveAspectRatio="none"><rect x="-6" y="-4" width="${bits.length + 12}" height="48" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }
  const statGrid = (s) => `<div class="stat"><div><b>${s.hp}</b>❤️</div><div><b>${s.st}</b>⚔️</div><div><b>${s.df}</b>🛡️</div><div><b>${s.dx}</b>👟</div><div><b>${s.sp}</b>✨</div></div>`;
  function previewHtml(d, cap, entry) {
    if (d.kind === 'char') {
      const A = BB.ATTRS[d.attr], lv = entry ? entry.level : 1, mx = entry ? entry.maxLv : d.limit;
      return `<div class="stkwrap" id="stk${cap}"></div>
        <div class="nm">${A.emoji} ${d.name}</div>
        <span class="tag">${ATTR_JA[d.attr]}ぞくせい</span><span class="tag">✨${d.kirakira.name}</span><span class="tag">${TYPE_JA(d.type)}</span>
        <div class="small" style="margin-top:6px">Lv${lv} / げんかいLv${mx}（${d.kirakira.name}：Lv${d.kirakira.startLv}から）</div>
        ${statGrid(BB.statsAt(d, lv))}${barSvg(d.code)}`;
    }
    return `<div class="stkwrap" id="stk${cap}"></div>
      <div class="nm">🎁 ${kanaItem(d.name)}</div><div class="small">${d.text}</div>${d.code ? barSvg(d.code) : '<div class="small">🎒 もちものから（つかうと1こへります）</div>'}`;
  }

  // ---------- ホーム ----------
  function setSlot(kind, code, collab) {
    const s = slots[kind];
    const cap = kind === 'char' ? 'Char' : 'Item';
    s.code = code.replace(/\D/g, ''); s.collab = !!collab;
    $('in' + cap).value = s.code;
    s.dec = null;
    s.status = null;
    s.bagId = null;
    $('w' + cap).textContent = '';
    $('pv' + cap).innerHTML = '';
    $('i' + cap).textContent = '';
    let preview = null;
    if (s.code.length === 13 && !BB.isValidJan(s.code)) {
      $('w' + cap).textContent = 'さいごの数字（チェックデジット）が あいません。JANコードではありません';
    } else if (s.code.length === 13 && !BB.prefixKind(s.code)) {
      $('w' + cap).textContent = 'さいしょが45・49の しょうひんか、9784の ほんの バーコードだけ つかえます';
    } else if (s.code.length === 13) {
      const d = BB.decode(s.code, kind === 'char' && collab);
      const st = kind === 'char' ? lookup(s.code, collab) : null;
      if (kind === 'char' && d.kind !== 'char') $('w' + cap).textContent = 'これは ほん（アイテムよう）です。さいしょが45か49の しょうひんを いれてください';
      else if (kind === 'item' && d.kind !== 'item') $('w' + cap).textContent = 'これは しょうひん（キャラよう）です。さいしょが9784の ほんを いれてください';
      else if (kind === 'char') {
        s.status = st;
        s.dec = st.entry && st.type !== 'upgrade' ? BB.decode(st.entry.code) : d; // 既存の戦士がいればその戦士で戦う
        $('pv' + cap).innerHTML = previewHtml(s.dec, cap, st.entry);
        $('iChar').textContent = statusText(st);
        preview = s.dec;
      } else {
        s.dec = d;
        $('pv' + cap).innerHTML = previewHtml(d, cap);
        preview = d;
      }
    } else if (s.code.length > 0) $('w' + cap).textContent = `13けたのJANコードだけ つかえます（いま${s.code.length}けた）`;
    if (preview) makeSticker(preview).then((c) => { const box = $('stk' + cap); if (box && s.dec === preview) box.appendChild(c); });
  }
  // 戦士を手に入れた（スキャン・ランダム・入力の確定）ときに、すぐ図鑑へ登録する／別ロットなら限界Lvを上げる
  async function acquire(kind, code, collab) {
    setSlot(kind, code, collab);
    const s = slots[kind];
    if (kind === 'item') { // 書籍：持ち物に入れる（同じバーコードは1回だけ）
      if (!s.dec) return;
      if (player.itemCodes.includes(code)) { $('iItem').textContent = 'このバーコードは、もう つかっています（うったあとでも つかえません）'; return; }
      player.itemCodes.push(code); player.bag[s.dec.itemId] = (player.bag[s.dec.itemId] || 0) + 1;
      await savePlayer();
      $('iItem').textContent = `🎁 ${kanaItem(s.dec.name)} を もちものに いれました！`;
      return;
    }
    if (kind !== 'char' || !s.status || !['new', 'lot', 'upgrade'].includes(s.status.type)) return;
    const st = s.status, name = s.dec.name, oldMax = st.entry ? st.entry.maxLv : 0;
    await commitChar();
    const e = dex[s.dec.code] || st.entry;
    const msg = st.type === 'new' ? `🆕 ${name} を ずかんに とうろくしました！（Lv${e.level}から・げんかいLv${e.maxLv}）`
      : st.type === 'upgrade' ? `✨ ${name} が ${s.dec.kirakira.name} に なりました！（Lv${e.level}・げんかいLv${oldMax} → ${e.maxLv}）`
      : `🎁 おなじキャラ・おなじぞくせい！ ${name} の げんかいLv ${oldMax} → ${e.maxLv}`;
    setSlot('char', s.code, collab);
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
    document.querySelectorAll('[data-rand]').forEach((b) => { b.textContent = usedToday(b.dataset.rand) ? '🎲 きょうは おわり' : '🎲 ランダム'; });
  }
  async function onRandom(kind) {
    const cap = kind === 'char' ? 'Char' : 'Item';
    let note;
    if (usedToday(kind)) {
      await acquire(kind, daily[kind].code);
      note = '🎲 ランダムは 1日1かいです。きょうの コードを いれなおしました（つぎは あした）';
    } else {
      const code = BB.randomCode(kind);
      daily[kind] = { date: today(), code };
      await Store.setDaily(cur, kind, daily[kind]);
      updateRandButtons();
      await acquire(kind, code);
      note = '🎲 きょうの ランダム（1日1かい）';
    }
    const el = $('i' + cap);
    el.textContent = el.textContent ? note + '　' + el.textContent : note;
  }
  document.querySelectorAll('[data-rand]').forEach((b) => b.onclick = () => onRandom(b.dataset.rand));
  // 持ち物：お金とアイテム
  const bagCount = () => Object.values(player.bag).reduce((a, b) => a + b, 0);
  function renderWallet() { $('wallet').textContent = `${titleText() ? '【' + titleText() + '】　' : ''}💰 ${player.money.toLocaleString()}　🎒 もちもの ${bagCount()}こ`; }
  async function savePlayer() { await Store.setPlayer(cur, player); renderWallet(); }
  async function openBag() {
    const ids = Object.keys(player.bag).filter((id) => player.bag[id] > 0);
    const opts = ids.length
      ? ids.map((id) => { const d = BB.itemById(id); return { label: `🎁 ${d.name} ×${player.bag[id]}<br><span class="small">${d.text}</span>`, value: 0, disabled: true }; })
      : [{ label: 'まだありません。書籍のバーコードを読み取るか、対戦に勝つと手に入ります', value: 0, disabled: true }];
    opts.push({ label: '← もどる', value: 0 });
    await choose('持ち物（パーティ編成で持たせられます）', opts);
  }
  document.querySelectorAll('[data-bag]').forEach((b) => b.onclick = openBag);
  document.querySelectorAll('[data-lib]').forEach((b) => b.onclick = openLib);
  document.querySelectorAll('[data-scan]').forEach((b) => b.onclick = () => openScan(b.dataset.scan));
  // ---- コラボスキャン：合言葉で開く「コラボキャラ」。読み取りのルールは、通常のスキャンと同じ ----
  async function ensureCollab() {
    if (BB.COLLAB.ready) return true;
    const pass = (window.prompt('コラボの合言葉を入れてください（家族に聞いてね）', '') || '').trim();
    if (!pass) return false;
    const r = await Collab.unlock(pass);
    if (r === 'ok') { await loadProfiles(); return true; }
    await choose('コラボを開けませんでした', [{ label: r === 'wrong' ? '合言葉がちがいます' : r === 'missing' ? 'コラボのデータが、まだ置かれていません' : 'この端末・ブラウザでは、コラボを読み込めませんでした（HTTPSが必要です）', value: 0, disabled: true }, { label: 'とじる', value: 0 }]);
    return false;
  }
  $('btnCollab').onclick = async () => { if (await ensureCollab()) openScan('char', true); };

  // 図鑑
  function openLib() {
    const l = Object.values(dex).sort((a, b) => b.level - a.level || b.xp - a.xp);
    $('libList').innerHTML = l.length ? '' : '<p class="small">まだ戦士がいません。バーコードを読み取ると図鑑に載ります</p>';
    l.forEach((e) => {
      const b = document.createElement('button');
      b.textContent = `${BB.ATTRS[e.attr].emoji} ${e.name}  Lv${e.level}/${e.maxLv}  ${e.wins}勝${e.losses}敗  (${e.code.replace(/^c/, "🌟")})`;
      b.onclick = () => { setSlot('char', e.code, e.code[0] === 'c'); $('libMask').classList.remove('on'); };
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
  // 読み取りの方針：BarcodeDetector と ZXing の両方を使い、映像の「中央の帯」→「全体」…と、毎回ちがう切り出しで試す。
  // カメラは高解像度・連続ピント。ライト・ズーム（対応端末のみ）と、写真から読み取る方法も用意している
  let detector = null, track = null, scanKind = 'char', scanCollab = false;
  function makeReader() {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const reader = new ZXing.MultiFormatReader(); reader.setHints(hints); return reader;
  }
  // 画像（video / img）の一部（割合 rx,ry,rw,rh）を切り出して読む。大きすぎれば縮める。rot なら90度回して読む
  async function decodeRegion(src, sw0, sh0, rx, ry, rw, rh, reader, cv, ctx, rot) {
    const sx = rx * sw0, sy = ry * sh0, sw = rw * sw0, sh = rh * sh0;
    const k = Math.min(1, 1400 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    if (rot) { cv.width = h; cv.height = w; ctx.setTransform(0, 1, -1, 0, h, 0); } else { cv.width = w; cv.height = h; ctx.setTransform(1, 0, 0, 1, 0, 0); }
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    if (detector) {
      try { const r = await detector.detect(cv); if (r.length) return r[0].rawValue; } catch (e) { /* 次へ */ }
    }
    if (reader) {
      try {
        const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(cv)));
        return reader.decode(bmp).getText();
      } catch (e) { /* 見つからない */ }
    }
    return null;
  }
  // 切り出しの候補：中央の帯（横長）→ 全体 → 中央の大きめの帯 → 縦向きのバーコード用（回転）→ 中央
  const REGIONS = [[0.04, 0.3, 0.92, 0.4, false], [0, 0, 1, 1, false], [0.02, 0.18, 0.96, 0.64, false], [0.3, 0.04, 0.4, 0.92, true], [0.18, 0.2, 0.64, 0.6, false]];
  async function scanLoop(kind, v) {
    $('scanMsg').textContent = '読み取りの準備中…';
    let reader = null;
    try { await loadZXing(); reader = makeReader(); } catch (e) {
      if (!detector) { $('scanMsg').textContent = '読み取りの部品を読み込めませんでした。数字を直接入力するか「写真で読む」を使ってください'; return; }
    }
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
    scanning = true; let n = 0, since = Date.now();
    $('scanMsg').textContent = 'バーコードを赤い線にあわせて、ゆっくり近づけたり離したりしてください';
    while (scanning) {
      if (v.videoWidth) {
        const [rx, ry, rw, rh, rot] = REGIONS[n % REGIONS.length]; n++;
        const raw = await decodeRegion(v, v.videoWidth, v.videoHeight, rx, ry, rw, rh, reader, cv, ctx, rot);
        if (raw && scanning) { closeScan(); acquire(kind, raw, scanCollab); return; }
        if (Date.now() - since > 12000) { since = Date.now(); $('scanMsg').textContent = 'うまく読めないときは：明るくする／ライトをつける／少し離す（10〜20cm）／下の「写真で読む」をためす'; }
      }
      await sleep(60);
    }
  }
  async function readPhoto(file, kind) {
    $('scanMsg').textContent = '写真を読んでいます…';
    try {
      await loadZXing().catch(() => {});
      const reader = window.ZXing ? makeReader() : null;
      if (!detector && 'BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['ean_13'] }); } catch (e) { detector = null; } }
      const img = new Image(), url = URL.createObjectURL(file);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
      const W = img.naturalWidth, H = img.naturalHeight;
      const tries = [[0, 0, 1, 1, false], [0.04, 0.3, 0.92, 0.4, false], [0.02, 0.18, 0.96, 0.64, false], [0, 0, 1, 1, true], [0.3, 0.04, 0.4, 0.92, true], [0.1, 0.1, 0.8, 0.8, false], [0, 0.25, 1, 0.5, false], [0, 0.4, 1, 0.3, false]];
      for (const [rx, ry, rw, rh, rot] of tries) {
        const raw = await decodeRegion(img, W, H, rx, ry, rw, rh, reader, cv, ctx, rot);
        if (raw) { URL.revokeObjectURL(url); closeScan(); acquire(kind, raw, scanCollab); return; }
      }
      URL.revokeObjectURL(url);
      $('scanMsg').textContent = '写真から読み取れませんでした。バーコード全体が大きく写り、ピントが合うように撮りなおしてください';
    } catch (e) { $('scanMsg').textContent = '写真を読めませんでした。数字を直接入力してください'; }
  }
  async function openScan(kind, collab) {
    scanKind = kind; scanCollab = !!collab;
    $('scanMask').classList.add('on');
    $('scanMsg').textContent = ''; $('scanTools').style.display = 'none'; $('scanInput').value = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) { $('scanMsg').textContent = 'カメラを使えませんでした（HTTPS接続とカメラ許可が必要です）。「写真で読む」か、数字の入力は使えます'; return; }
    const v = $('video');
    v.srcObject = stream; await v.play();
    track = stream.getVideoTracks()[0];
    // 連続ピント・ライト・ズームに対応していれば使う
    try {
      const cap = track.getCapabilities ? track.getCapabilities() : {};
      if (cap.focusMode && cap.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      $('btnTorch').style.display = cap.torch ? '' : 'none';
      $('btnZoom').style.display = cap.zoom ? '' : 'none';
      $('scanTools').style.display = (cap.torch || cap.zoom) ? '' : 'none';
    } catch (e) { /* 対応していない端末は、そのまま */ }
    detector = null;
    if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['ean_13'] }); } catch (e) { detector = null; } }
    await scanLoop(kind, v);
  }
  let torchOn = false, zoomStep = 0;
  $('btnTorch').onclick = async () => {
    if (!track) return; torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('btnTorch').textContent = torchOn ? '🔦 ライト：オン' : '🔦 ライト'; } catch (e) { torchOn = false; }
  };
  $('btnZoom').onclick = async () => {
    if (!track) return;
    try {
      const z = track.getCapabilities().zoom; zoomStep = (zoomStep + 1) % 3;
      await track.applyConstraints({ advanced: [{ zoom: z.min + (z.max - z.min) * [0, 0.25, 0.5][zoomStep] }] });
      $('btnZoom').textContent = '🔍 ズーム ' + ['×1', '×2', '×3'][zoomStep];
    } catch (e) { /* 非対応 */ }
  };
  $('scanFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) readPhoto(f, scanKind); };
  function closeScan() {
    scanning = false; torchOn = false; zoomStep = 0; track = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $('btnTorch').textContent = '🔦 ライト'; $('btnZoom').textContent = '🔍 ズーム';
    $('scanMask').classList.remove('on');
  }
  $('scanClose').onclick = closeScan;
  // JANコードを数字で直接入力（スキャン画面の中）。通常のスキャンもコラボも、いま開いている画面の種類で登録する
  async function submitScanInput() {
    const v = $('scanInput').value.replace(/\D/g, '');
    if (v.length !== 13) { $('scanMsg').textContent = `13けたの数字を入れてください（いま${v.length}けた）`; return; }
    if (!BB.isValidJan(v)) { $('scanMsg').textContent = '末尾の数字（チェックデジット）が合いません。JANコードではありません'; return; }
    const k = BB.prefixKind(v);
    if (scanKind === 'char' && k !== 'char') { $('scanMsg').textContent = '戦士には、先頭が45か49の商品のバーコードを入れてください'; return; }
    if (scanKind === 'item' && k !== 'item') { $('scanMsg').textContent = 'アイテムには、先頭が9784の書籍のバーコードを入れてください'; return; }
    const kind = scanKind, collab = scanCollab;
    closeScan(); await acquire(kind, v, collab);
  }
  $('scanGo').onclick = submitScanInput;
  $('scanInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitScanInput(); } });

  // ---------- 画面切替 ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id)); window.scrollTo(0, 0);
    document.body.classList.toggle('inbattle', id === 'battle' || id === 'battle2');   // 戦闘中は、ステータスを固定して、選択ウィンドウは下に置く
  }

  // ---------- モーダル ----------
  function modal(html) {
    $('modalBody').innerHTML = html; $('modalMask').classList.add('on');
  }
  function closeModal() { $('modalMask').classList.remove('on'); }
  let activeChoose = null, turnExpired = false;
  function choose(title, options, cfg = {}) {
    return new Promise((res, rej) => {
      if (turnExpired) { rej(new Error('timeout')); return; }   // 通信対戦：入力の時間が切れたあとは、開かない
      activeChoose = { rej };
      modal(`<div class="mhead"><h2>${title}</h2>${cfg.back ? '<button class="mback" id="mBack">もどる</button>' : ''}</div><div class="lib${cfg.grid ? ' grid3' : ''}" id="choices"></div>`);
      options.forEach((o) => {
        const b = document.createElement('button');
        b.innerHTML = o.label; b.disabled = !!o.disabled;
        b.onclick = () => { activeChoose = null; closeModal(); res(o.value); };
        $('choices').appendChild(b);
      });
      if (cfg.back) $('mBack').onclick = () => { activeChoose = null; closeModal(); res(cfg.back.value); };
    });
  }
  // 開いている選択を、時間切れ（'timeout'）や取りやめ（'aborted'）でとじる
  function cancelChoose(reason) {
    if (!activeChoose) return;
    const c = activeChoose; activeChoose = null; closeModal(); c.rej(new Error(reason || 'timeout'));
  }
  // ---------- パーティ編成（最大6体。同じキャラ1体まで、同じアイテムは1体まで） ----------
  const PARTY_MAX = 6, PICK_SECONDS = 60;
  let PICK = 3;                       // 選出の数：ふつうは3体、マルチは4体
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
  // パーティ編成の枠の中に出す、小さなステータスバー
  // 装備ありの能力（hp,st,df,dx,sp）と、装備による増減
  function statsWithItem(e, itemId) {
    const f = (item) => { const m = BB.makeFighter(BB.decode(e.code), item, e.level); return { hp: m.maxHp / BB.HP_SCALE, st: m.st, df: m.df, dx: m.dx, sp: m.sp }; };
    const base = f(null), cur = itemId ? f(BB.itemById(itemId)) : base;
    const sum = (o) => Object.values(o).reduce((s, y) => s + Math.round(y), 0);
    return { base, cur, total: sum(base), delta: sum(cur) - sum(base) };
  }
  // バー：横いっぱい＝333。0〜333 青 → 334〜666 黄 → 667〜999 赤（色が変わるたびに、前の色の上にかさねる）
  function miniBars(e, itemId) {
    const { base, cur } = statsWithItem(e, itemId);
    const COL = ['#58a6ff', '#f0b429', '#f85149'];
    return '<div class="mbars">' + STAT_NAMES.map(([k, n]) => {
      const v = Math.round(cur[k]), b = Math.round(base[k]), d = v - b;
      const tier = Math.min(2, Math.max(0, Math.ceil(v / 333) - 1));
      const w = Math.min(100, (v - tier * 333) / 333 * 100);
      const dt = d ? `<em class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '＋' : '－'}${Math.abs(d)}</em>` : '';
      return `<div class="mb"><span>${n}</span><i style="${tier ? 'background:' + COL[tier - 1] : ''}"><u style="width:${w}%;background:${COL[tier]}"></u></i><b>${b}${dt}</b></div>`;
    }).join('') + '</div>';
  }
  function memberRow(e, inParty, idxs) {
    const row = document.createElement('div'); row.className = 'prow';
    const th = document.createElement('div'); th.className = 'pth'; row.appendChild(th);
    makeSticker(BB.decode(e.code), 128).then((c) => th.appendChild(c));
    const A = BB.ATTRS[e.attr];
    const info = document.createElement('div'); info.className = 'pinfo';
    info.innerHTML = `<div><b>${A.emoji} ${e.name}</b> Lv${e.level}/${e.maxLv}</div><div class="small">${e.wins}勝${e.losses}敗${inParty ? ` ／ 🎁 ${itemLabel(player.party.items[e.code])}` : ''}</div>${miniBars(e, inParty ? player.party.items[e.code] : null)}`;
    row.insertAdjacentHTML('afterbegin', (() => { const t = statsWithItem(e, inParty ? player.party.items[e.code] : null); return `<span class="tot">合計${t.total}${t.delta ? `<em class="${t.delta > 0 ? 'up' : 'dn'}">${t.delta > 0 ? '＋' : '－'}${Math.abs(t.delta)}</em>` : ''}</span>`; })());
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
    opts.push({ label: '← もどる', value: 0 });
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
  // 属性の相性の輪：矢印の「元」が「先」に有利（炎→風→土→雷→水→炎）。戦闘前・戦闘中に小さく置く。タップで大きく見る
  const RING_ORDER = [3, 0, 1, 4, 2];
  function attrRingSvg(size) {
    const c = size / 2, R = size * 0.36, r = size * 0.13, fs = Math.round(size * 0.17);
    const pt = (i) => { const t = -Math.PI / 2 + i * 2 * Math.PI / 5; return [c + R * Math.cos(t), c + R * Math.sin(t)]; };
    let s = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="ra${size}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${Math.max(4, size / 22)}" markerHeight="${Math.max(4, size / 22)}" orient="auto"><path d="M0,0L10,5L0,10z" fill="#e6edf3"/></marker></defs>`;
    for (let i = 0; i < 5; i++) {
      const [x1, y1] = pt(i), [x2, y2] = pt((i + 1) % 5), d = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / d, uy = (y2 - y1) / d;
      s += `<line x1="${x1 + ux * (r + 1)}" y1="${y1 + uy * (r + 1)}" x2="${x2 - ux * (r + 3)}" y2="${y2 - uy * (r + 3)}" stroke="#e6edf3" stroke-width="${Math.max(1.2, size / 60)}" marker-end="url(#ra${size})"/>`;
    }
    RING_ORDER.forEach((a, i) => {
      const [x, y] = pt(i);
      s += `<circle cx="${x}" cy="${y}" r="${r}" fill="#161b22" stroke="${ATTR_COLORS[a]}" stroke-width="${Math.max(1.5, size / 50)}"/><text x="${x}" y="${y}" font-size="${fs}" text-anchor="middle" dominant-baseline="central">${BB.ATTRS[a].emoji}</text>`;
    });
    return s + '</svg>';
  }
  function mountAttrRings() {
    document.querySelectorAll('[data-attrring]').forEach((el) => {
      el.innerHTML = attrRingSvg(+el.dataset.attrring || 76);
      el.onclick = () => modal(`<h3 style="margin:0 0 6px">属性の相性</h3><div style="display:flex;justify-content:center">${attrRingSvg(240)}</div>
        <p class="small" style="margin:8px 0">矢印の <b>元</b> の属性のこうげきは、<b>先</b> の属性に強い（×1.5）。逆向きは弱い（×0.5）。同じ属性どうしは ×0.75。</p>
        <p class="small" style="margin:0 0 8px">${RING_ORDER.map((a) => BB.ATTRS[a].emoji + BB.ATTRS[a].name).join(' → ')} → ${BB.ATTRS[RING_ORDER[0]].emoji}${BB.ATTRS[RING_ORDER[0]].name}</p>
        <button class="pri" style="width:100%" onclick="document.getElementById('modalMask').classList.remove('on')">閉じる</button>`);
    });
  }
  const STAT_NAMES = [['hp', '❤️'], ['st', '⚔️'], ['df', '🛡️'], ['dx', '👟'], ['sp', '✨']];
  const canvasCache = {};

  mountAttrRings();
  function detailHtml(f, foeAttrs, opts = {}) {
    const A = BB.ATTRS[f.attr];
    const sts = { hp: f.maxHp / BB.HP_SCALE, st: f.st, df: f.df, dx: f.dx, sp: f.sp };
    const bars = STAT_NAMES.map(([k, n]) => `<div class="dbar"><span class="dn">${n}</span><div class="dtrack"><div style="width:${Math.min(100, sts[k] / 3)}%"></div></div><b>${sts[k]}</b></div>`).join('');
    // 経験値：次のレベルまでの進み具合（図鑑にいる戦士だけ。相手のCPUには出さない）
    let xpRow = '';
    const de = dex[f.code];
    if (de) {
      const capped = de.level >= de.maxLv;
      const base = BB.xpForLevel(de.level), need = BB.xpForLevel(de.level + 1) - base;
      const into = capped ? need : de.xp - base, pct = capped ? 100 : Math.round(into / need * 100);
      const note = capped ? (de.maxLv < BB.MAX_LV ? `限界Lv${de.maxLv}に到達（同じキャラ・属性のバーコードで限界+${BB.LOT_STEP}）` : `最大Lv${BB.MAX_LV}に到達`) : `Lv${de.level + 1}まで あと ${need - into}（${into}/${need}）`;
      xpRow = `<div class="dbar"><span class="dn t">経験</span><div class="dtrack xp"><div style="width:${pct}%"></div></div><b>${capped ? 'MAX' : pct + '%'}</b></div><div class="small">経験値 ${de.xp}　${note}</div>`;
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
      ${opts.noBars ? '' : bars + `<div class="small">体力 ${f.maxHp}（❤️ × ${BB.HP_SCALE}）</div>`}${xpRow}${item}${aff}${opts.story ? storyHtml(f) : ''}`;
  }
  // キャラの「とくちょう」と「ものがたり」（stories.js）
  function storyHtml(f) {
    const s = f.idx >= 100 ? ((BB.COLLAB.chars[f.idx - 100] || {}).story || null) : ((typeof BB_STORIES !== 'undefined' ? BB_STORIES : {})[String(f.idx).padStart(2, '0')] || null);
    return s ? `<h3>とくちょう</h3><p class="story">${s[0]}</p><h3>ものがたり</h3><p class="story">${s[1]}</p>` : '';
  }
  function fillDetail(box, f, foeAttrs, opts) {
    box.innerHTML = detailHtml(f, foeAttrs, opts);
    const tok = box._tok = (box._tok || 0) + 1; // 速く切りかえたとき、古い画像があとから入らないようにする
    makeSticker(f, 192).then((c) => { const t = box.querySelector('.dstk'); if (t && box._tok === tok) { t.innerHTML = ''; t.appendChild(c); } });
  }
  function showDetailModal(code) {
    const id = player.party.items[code];
    const f = BB.makeFighter(BB.decode(code), id ? BB.itemById(id) : null, dex[code].level);
    modal('<div id="dmBox"></div><button class="pri" style="width:100%;margin-top:10px" onclick="document.getElementById(\'modalMask\').classList.remove(\'on\')">閉じる</button>');
    fillDetail($('dmBox'), f, null, { noBars: true, story: true });
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
      : `<div>${A.emoji} ${f.name}</div><div class="small">${f.level == null ? 'Lv？' : 'Lv' + f.level}${f.item ? ' ／ 🎁' + f.item.name : ''}</div>`);
    if (extra) el.insertAdjacentHTML('beforeend', extra);
    if (onClick) el.onclick = onClick;
    return el;
  }
  const orderLabels = () => (PICK === 4 ? ['先発①', '先発②', '控え①', '控え②'] : ['先発', '控え①', '控え②']);
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
      row.innerHTML = `<span class="lb">${orderLabels()[k]}</span><span class="nm2">${f ? `${BB.ATTRS[f.attr].emoji} ${f.name} <span class="small">Lv${f.level}</span>` : '<span class="small">（まだ選んでいません）</span>'}</span>`;
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

  // CPUの強さ：国名のステージ10段階。CPUのパーティの平均レベルとアイテムの持たせ方が上がる
  const STAGES = [
    { flag: '🇯🇵', name: '日本', lv: 2, item: 0.1 }, { flag: '🇰🇷', name: '韓国', lv: 5, item: 0.2 }, { flag: '🇨🇳', name: '中国', lv: 9, item: 0.3 },
    { flag: '🇮🇳', name: 'インド', lv: 14, item: 0.4 }, { flag: '🇬🇧', name: 'イギリス', lv: 20, item: 0.5 }, { flag: '🇫🇷', name: 'フランス', lv: 27, item: 0.6 },
    { flag: '🇩🇪', name: 'ドイツ', lv: 34, item: 0.7 }, { flag: '🇧🇷', name: 'ブラジル', lv: 42, item: 0.8 }, { flag: '🇷🇺', name: 'ロシア', lv: 50, item: 0.9 },
    { flag: '🇺🇸', name: 'アメリカ', lv: 58, item: 1 },
  ];
  const STAGE_KEY = 'bb-stage';
  async function pickStage(games) {
    let last = 1;
    try { last = Math.min(10, Math.max(1, +localStorage.getItem(STAGE_KEY) || 1)); } catch (e) { /* 保存できなくても動く */ }
    const open = Math.min(STAGES.length, (player.stageClear || 0) + 1);   // クリアした次のステージまで遊べる
    last = Math.min(last, open);
    const v = await choose(`${games > 1 ? '🏆 3かい' : '⚔ シングル'}：ステージ（CPUの強さ）をえらぶ`, [
      { label: 'CPUのパーティの平均レベルの目安です。<b>勝つとクリア</b>で、次のステージが開きます（シングルでも3本勝負でも）。数が大きいほど強く、もらえる経験値・お金も多くなります。', value: 0, disabled: true },
      ...STAGES.map((s, i) => {
        const n = i + 1, done = n <= player.stageClear, locked = n > open;
        return { label: locked ? `🔒 <b>${n}. ？？？</b>　<span class="small">${STAGES[i - 1].name}をクリアすると開きます</span>`
          : `${s.flag} <b>${n}. ${s.name}</b>　<span class="small">強さ Lv${s.lv}ごろ ${'★'.repeat(Math.ceil(n / 2))}${done ? '　✅クリア' : '　🆕'}${n === last && n > 1 ? '　（前回）' : ''}</span>`, value: n, disabled: locked };
      }),
      { label: '← もどる', value: -1 }]);
    if (v <= 0) return 0;
    try { localStorage.setItem(STAGE_KEY, String(v)); } catch (e) { /* 保存できなくても動く */ }
    return v;
  }
  // 試合の開始（games=1 でシングル、3 で3本勝負）
  async function startMatch(games, multi = false) {
    PICK = multi ? 4 : 3;
    const stageNo = await pickStage(games);
    if (!stageNo) return;
    const stage = STAGES[stageNo - 1];
    const codes = partyCodes();
    if (codes.length < PICK) {
      const v = await choose('パーティが足りません', [
        { label: `対戦には${PICK}体以上必要です（いま${codes.length}体）`, value: 0, disabled: true },
        { label: '👥 パーティ編成へ', value: 1 }, { label: '← もどる', value: 0 }]);
      if (v) openParty();
      return;
    }
    match = { stage, multi, maxGames: games, game: 0, wins: [0, 0], codes, usedMine: [], usedFoe: [], foeUsedGames: [], played: new Set(), foeBase: [],
      herbs: 3 + player.carry.herbs, boost: player.carry.boost, carryBack: { herbs: player.carry.herbs, boost: player.carry.boost } };
    match.carryText = [player.carry.herbs ? `薬草+${player.carry.herbs}` : '', player.carry.boost ? '経験値×2' : ''].filter(Boolean).join('・');
    if (player.carry.herbs || player.carry.boost) { player.carry = { herbs: 0, boost: false }; await savePlayer(); } // 持ち込みは、試合を始めると使われる
    const mine0 = codes.map((c) => BB.makeFighter(BB.decode(c), null, dex[c].level));
    match.foeBase = Battle.generateCpuParty(stage.lv, rng, PARTY_MAX, stage.item);
    await Promise.all(match.foeBase.map(async (f) => { f.canvas = await makeSticker(f, 160); }));
    await Promise.all(codes.map(async (c, i) => { canvasCache[c] = await makeSticker(mine0[i], 160); }));
    await nextGame();
  }
  async function nextGame() {
    if (pvp) return nextPvpGame();
    match.game++;
    myParty = match.codes.map(memberFighter);
    foeParty = match.foeBase.map(foeFresh);
    picked = []; focusMine = 0; foeFocus = null;
    $('btnPick').textContent = `この${PICK}体${match.multi ? '' : '・この順番で'}決定`;
    $('gameNo').textContent = (match.multi ? '（👥 マルチ：場に2体）' : '') + (match.stage ? `（${match.stage.flag} ${match.stage.name}）` : '') + (match.maxGames > 1 ? `（第${match.game}試合／先に2勝）` : '') + (match.carryText ? `（持ち込み：${match.carryText}）` : '');
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
      $('foeState').textContent = (pvp ? pvp.oppDecided : PICK_SECONDS - left >= decideAt) ? 'あいて：決定ずみ ✓' : 'あいて：選出中…';
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
  function revealSelections(mineList, foeList, lead = 1) {
    return new Promise((res) => {
      const build = (box, list, bench) => {
        box.innerHTML = '';
        list.forEach((f, k) => {
          const el = document.createElement('div'); el.className = 'flip' + (k >= lead && !bench ? ' hid' : '');
          el.innerHTML = '<div><div class="bk">⚪</div><div class="fr"></div></div>';
          const c = document.createElement('canvas'); c.width = c.height = 160;
          c.getContext('2d').drawImage(f.canvas, 0, 0, 160, 160);
          el.querySelector('.fr').appendChild(c);
          if (k >= lead && !bench) el.insertAdjacentHTML('beforeend', '<span class="qq">？</span>');
          if (k < lead) el.insertAdjacentHTML('beforeend', '<span class="qq">先発</span>');
          box.appendChild(el);
        });
      };
      build($('rvFoe'), foeList, false); build($('rvMine'), mineList, true);
      $('revealMask').classList.add('on');
      setTimeout(() => { $('rvFoe').querySelectorAll('.flip:not(.hid)').forEach((e) => e.classList.add('on')); $('rvMine').querySelectorAll('.flip').forEach((e) => e.classList.add('on')); }, 700);
      setTimeout(() => { $('revealMask').classList.remove('on'); res(); }, 2300);
    });
  }
  async function confirmPick() {
    if (pvp) return pvpGuard(confirmPickPvp);
    clearInterval(pickTimer);
    const foeSel = Battle.cpuSelect(foeParty, myParty, PICK);
    const mineList = picked.map((i) => myParty[i]), foeList = foeSel.map((i) => foeParty[i]);
    await revealSelections(mineList, foeList, match.multi ? 2 : 1);
    const winner = await (match.multi ? runMultiBattle(mineList, foeList) : runBattle(mineList, foeList));
    if (winner === 'giveup') { await giveUpMatch(); return; }
    await afterGame(winner, foeSel);
  }
  $('btnPick').onclick = confirmPick;
  // 「もどる」：見せ合い・選出をやめてホームへ。1試合目なら、持ち込み（薬草・ブースト）は使っていないので返す
  async function backFromPick() {
    if (pvp) {
      const ok = await choose('対戦をやめますか？', [
        { label: 'あいてには、「退出しました」と伝わります。', value: 0, disabled: true },
        { label: 'やめてホームへ', value: 1 }, { label: 'つづける', value: 0 }]);
      if (ok) await leavePvp('left');
      return;
    }
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
  $('btnMulti').onclick = () => startMatch(1, true);
  $('btnNext').onclick = nextGame;

  // ---------- 対戦（同時入力ターン制） ----------
  let st = null, view = null, logLines = [], mySide = 0, pvp = null; // mySide：内部の並びで、自分が 0 か 1 か（通信対戦のゲストは 1）
  function say(t) { logLines.push(t); if (logLines.length > 6) logLines.shift(); $('log').innerHTML = logLines.map((l) => `<div>${l}</div>`).join(''); }
  const cardOfSide = (s) => (s === mySide ? $('meCard') : $('foeCard'));
  const sideName = (s) => (s === mySide ? 'あなた' : (pvp ? pvp.oppName : 'てき'));
  function cardHtml(s) {
    const mine = s === mySide;
    const side = st.sides[s], idx = view.active[s], f = side.party[idx], hp = view.hp[s][idx];
    const A = BB.ATTRS[f.attr], pct = Math.max(0, hp / f.maxHp * 100);
    const col = pct > 50 ? 'var(--hp)' : pct > 20 ? 'var(--hp2)' : 'var(--hp3)';
    const stt = Object.keys(f.status).filter((k) => f.status[k] > 0).map((k) => STATUS_JA[k]).join('・');
    const atk = f.atkAttr !== f.attr ? `（攻:${BB.ATTRS[f.atkAttr].name}）` : '', body = f.bodyAttr !== f.attr ? `（体:${BB.ATTRS[f.bodyAttr].name}）` : '';
    // 控えのボール：自分は属性色・名前・HP%、相手は場に出てくるまで「？」
    const chips = side.party.map((m, i) => {
      const known = mine || view.seen[s].has(i);
      const dead = view.hp[s][i] <= 0, p = Math.ceil(Math.max(0, view.hp[s][i]) / m.maxHp * 100);
      const dot = known ? `<span class="dot" style="background:${ATTR_COLORS[m.attr]}"></span>` : '<span class="dot" style="background:#555"></span>';
      return `<span class="chip ${i === idx ? 'on' : ''} ${dead ? 'dead' : ''}">${dot}${known ? m.name : '？'}${mine && !dead ? ` ${p}%` : ''}</span>`;
    }).join('');
    const hpText = mine ? `❤️ ${hp}/${f.maxHp}` : `❤️ ${Math.ceil(pct)}%`;
    const detail = mine
      ? `${A.emoji}${A.name}${atk}${body} ／ 🌿${view.herbs[s]} ／ ✨${f.spCd > 0 ? 'あと' + f.spCd : '使える'}${f.item && (f.item.effect.kind !== 'consumable' || f.consumable) ? '／🎁' + f.item.name : ''}`
      : `${A.emoji}${A.name}属性`;
    const hist = !mine && view.hist[s].length ? `<div class="small">あいての直近：${view.hist[s].slice(-3).join('・')}</div>` : '';
    return `<div class="frow"><div class="stk"></div><div class="finfo">
      <div class="top"><span style="color:var(--${mine ? 'me' : 'foe'})">${sideName(s)}${mine && titleText() ? '【' + titleText() + '】' : ''} ${f.name}</span><span>Lv${f.level}</span></div>
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
          $('timeline').innerHTML = e.list.map((x, i) => `<span class="tl ${x.s === mySide ? 'me' : 'foe'}" style="animation-delay:${i * 0.25}s">${i + 1}. ${sideName(x.s)}：${x.label}${x.kind === 'skill' ? ` <em>優先度${x.pri > 0 ? '+' : ''}${x.pri}・👟${x.dx}</em>` : ' <em>先に交代</em>'}</span>`).join('');
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
    const side = st.sides[mySide];
    const opts = Battle.benchAlive(side).map((i) => {
      const f = side.party[i];
      return { label: `${BB.ATTRS[f.attr].emoji} ${f.name} Lv${f.level}　❤️ ${view.hp[mySide][i]}/${f.maxHp}`, value: i };
    });
    if (canCancel) opts.push({ label: '← もどる', value: -1 });
    opts.push({ label: '🏳 あきらめる', value: -2 });
    const v = await choose(title, opts);
    if (v === -2) return (await confirmGiveUp()) ? 'giveup' : null;
    return v >= 0 ? v : null;
  }
  async function confirmGiveUp() {
    const ok = await choose('あきらめますか？', [
      { label: (pvp ? 'あいての勝ちになります。' : '') + (match && match.maxGames > 1 ? '3本勝負が、ここで終わります。' : '') + '経験値もお金も、アイテムももらえません（使った回復薬はなくなります）。', value: 0, disabled: true },
      { label: '🏳 あきらめる', value: 1 }, { label: 'たたかいをつづける', value: 0 }]);
    return !!ok;
  }
  async function chooseAction() {
    for (;;) {
      const f = Battle.actOf(st, mySide);
      const top = await choose(`${f.name} はどうする？`, [
        { label: '⚔ たたかう', value: 'skill' },
        { label: '🔄 こうたい', value: 'switch', disabled: !Battle.benchAlive(st.sides[mySide]).length },
        { label: '🏳 あきらめる', value: 'giveup' }]);
      if (top === 'giveup') { if (await confirmGiveUp()) return { type: 'giveup' }; continue; }
      if (top === 'skill') {
        const opts = Battle.availableSkills(st, mySide).map((s) => ({
          label: `<b class="big">${s.name}</b>${s.off ? `<span class="why">${s.off}</span>` : ''}`,
          value: s.id, disabled: !!s.off,
        }));
        const id = await choose('たたかう', opts, { grid: true, back: { value: 0 } });
        if (id) return { type: 'skill', skill: id };
      } else if (top === 'switch') {
        const to = await pickBench('だれとこうたいする？', true);
        if (to === 'giveup') return { type: 'giveup' };
        if (to !== null) return { type: 'switch', to };
      }
    }
  }

  // 1試合の対戦。勝者（0=自分 1=相手 -1=引き分け）を返す
  async function runBattle(mineList, foeList) {
    mySide = 0;
    st = Battle.createBattle(Battle.createSide('あなた', mineList, match.herbs), Battle.createSide('てき', foeList));
    view = { hp: st.sides.map((sd) => sd.party.map((f) => f.hp)), active: [0, 0], herbs: [match.herbs, 3], seen: [new Set([0]), new Set([0])], hist: [[], []] };
    logLines = []; $('timeline').innerHTML = ''; $('log').innerHTML = '';
    $('starLine').textContent = '相性：矢印の元の属性が、先に強い（×1.5）。同じ属性は ×0.75。図をタップで大きく表示 →';
    show('battle'); renderBattle();
    say(`${foeList[0].name} が勝負をしかけてきた！`); await sleep(700);
    while (!st.over) {
      $('timeline').innerHTML = '';
      const mine = await chooseAction();            // 同時入力：相手の行動は見えない
      if (mine.type === 'giveup') return 'giveup';
      const foeAct = Battle.cpuAction(st, 1, rng);
      await playEvents(Battle.resolveTurn(st, [mine, foeAct], rng));
      for (const s of Battle.needReplace(st)) {      // たおれたあとは、次に出すキャラを選ぶ
        let to = null;
        if (s === 0) { while (to === null) to = await pickBench('次に出すキャラを選んでください', false); } else to = Battle.cpuReplace(st, 1);
        if (to === 'giveup') return 'giveup';
        await playEvents([Battle.replaceActive(st, s, to)]);
      }
      await sleep(250);
    }
    await sleep(500);
    return st.winner;
  }


  // ---------- マルチバトル（場に2体・選出4体。CPUと） ----------
  let mview = null;
  function say2(t) { logLines.push(t); if (logLines.length > 6) logLines.shift(); $('log2').innerHTML = logLines.map((l) => `<div>${l}</div>`).join(''); }
  const mCard = (s, slot) => $(`mc_${s}_${slot}`);
  function mcardHtml(s, slot) {
    const mine = s === 0, side = st.sides[s], idx = mview.field[s][slot], f = side.party[idx], hp = mview.hp[s][idx];
    const A = BB.ATTRS[f.attr], pct = Math.max(0, hp / f.maxHp * 100);
    const col = pct > 50 ? 'var(--hp)' : pct > 20 ? 'var(--hp2)' : 'var(--hp3)';
    const stt = Object.keys(f.status).filter((k) => f.status[k] > 0).map((k) => STATUS_JA[k]).join('・');
    const sub = mine ? `${A.emoji}${A.name} ／ ✨${f.spCd > 0 ? 'あと' + f.spCd : '使える'}` : `${A.emoji}${A.name}属性`;
    return `<div class="mstk"></div><div class="minfo"><div class="top"><span style="color:var(--${mine ? 'me' : 'foe'})">${f.name}</span><span>Lv${f.level}</span></div>
      <div class="hpwrap"><div class="hpbar" style="width:${pct}%;background:${col}"></div></div>
      <div class="small">${hp <= 0 ? 'たおれた' : mine ? `❤️ ${hp}/${f.maxHp}` : `❤️ ${Math.ceil(pct)}%`}${stt ? ' ／ 💫' + stt : ''}</div><div class="small">${sub}</div></div>`;
  }
  function benchLine(s) {
    const side = st.sides[s];
    return (s === 0 ? '控え：' : 'あいての控え：') + side.party.map((m, i) => {
      if (mview.field[s].includes(i)) return '';
      const known = s === 0 || mview.seen[s].has(i), dead = mview.hp[s][i] <= 0;
      const dot = `<span class="dot" style="background:${known ? ATTR_COLORS[m.attr] : '#555'}"></span>`;
      return `<span class="chip ${dead ? 'dead' : ''}">${dot}${known ? m.name : '？'}${s === 0 && !dead ? ` ${Math.ceil(mview.hp[s][i] / m.maxHp * 100)}%` : ''}</span>`;
    }).join('') + ` ／ 🌿${mview.herbs[s]}`;
  }
  function renderMulti(acting) {
    for (const s of [1, 0]) {
      const row = $(s === 0 ? 'mMe' : 'mFoe'); row.innerHTML = '';
      for (const slot of [0, 1]) {
        const el = document.createElement('div'); el.id = `mc_${s}_${slot}`;
        const idx = mview.field[s][slot];
        el.className = 'card mcard' + (mview.hp[s][idx] <= 0 ? ' dead' : '') + (s === 0 && acting === slot ? ' acting' : '');
        el.innerHTML = mcardHtml(s, slot);
        el.querySelector('.mstk').appendChild(st.sides[s].party[idx].canvas);
        row.appendChild(el);
      }
      $(s === 0 ? 'mMeBench' : 'mFoeBench').innerHTML = benchLine(s);
    }
  }
  async function flashSlot(s, slot, text, color) {
    const card = mCard(s, slot); if (!card) return;
    card.classList.add('hit');
    const p = document.createElement('div'); p.className = 'pop'; p.style.color = color || '#fff'; p.textContent = text; card.appendChild(p);
    await sleep(650); card.classList.remove('hit'); p.remove();
  }
  async function playMulti(events) {
    for (const e of events) {
      switch (e.t) {
        case 'order':
          $('timeline2').innerHTML = e.list.map((x, i) => `<span class="tl ${x.s === 0 ? 'me' : 'foe'}" style="animation-delay:${i * 0.2}s">${i + 1}. ${x.s === 0 ? '' : 'てき '}${x.name}：${x.label}</span>`).join('');
          await sleep(400 + e.list.length * 250); break;
        case 'switch':
          say2(`${e.s === 0 ? 'あなた' : 'てき'}は ${e.from ? e.from + ' を戻して ' : ''}${e.to} を出した！`);
          mview.field[e.s][e.slot] = e.idx; mview.seen[e.s].add(e.idx); renderMulti(); await sleep(700); break;
        case 'use': say2(`${e.who} の ${e.skill}！`); await sleep(420); break;
        case 'miss': say2('しかし攻撃は外れた！'); await sleep(450); break;
        case 'msg': say2(e.text); await sleep(550); break;
        case 'dmg':
          mview.hp[e.s][e.idx] = e.hp;
          if (effText(e.mult)) say2(effText(e.mult));
          say2(e.crit ? `会心の一撃！ ${e.name} に ${e.dmg} のダメージ！` : `${e.name} に ${e.dmg} のダメージ！`);
          renderMulti(); await flashSlot(e.s, e.slot, '-' + e.dmg, e.crit ? '#ffd700' : '#ff7b72'); break;
        case 'heal':
          mview.hp[e.s][e.idx] = e.hp; if (e.herbs !== undefined) mview.herbs[e.s] = e.herbs;
          say2(e.item ? `${e.item} を使った！${e.amount ? ` ${e.amount} 回復！` : ''}` : `${e.amount} 回復！`);
          renderMulti(); await flashSlot(e.s, e.slot, '+' + e.amount, '#3fb950'); break;
        case 'status': say2(`${e.name} は${STATUS_JA[e.status]}になった！`); renderMulti(); await sleep(550); break;
        case 'poison':
          mview.hp[e.s][e.idx] = e.hp; say2(`${e.name} は毒で ${e.dmg} のダメージ！`);
          renderMulti(); await flashSlot(e.s, e.slot, '-' + e.dmg, '#a371f7'); break;
        case 'faint': say2(`${e.name} は たおれた！`); mview.hp[e.s][e.idx] = 0; renderMulti(); await sleep(750); break;
      }
    }
  }
  // 自分の1体ぶんの行動をえらぶ（スキル＋相手／交代／あきらめる）。taken＝このターンにほかの1体が交代で出す控え
  async function chooseSlotAction(slot, taken) {
    for (;;) {
      renderMulti(slot);
      const f = Multi.fighterAt(st, 0, slot);
      const bench = Multi.benchAlive(st.sides[0]).filter((i) => !taken.has(i));
      const top = await choose(`${BB.ATTRS[f.attr].emoji} ${f.name} はどうする？`, [
        { label: '⚔ たたかう', value: 'skill' },
        { label: '🔄 こうたい', value: 'switch', disabled: !bench.length },
        { label: '🏳 あきらめる', value: 'giveup' }]);
      if (top === 'giveup') { if (await confirmGiveUp()) return { type: 'giveup' }; continue; }
      if (top === 'skill') {
        const opts = Multi.availableSkills(st, 0, slot).map((s) => ({
          label: `<b class="big">${s.name}</b>${s.off ? `<span class="why">${s.off}</span>` : ''}`,
          value: s.id, disabled: !!s.off,
        }));
        const id = await choose('たたかう', opts, { grid: true, back: { value: 0 } });
        if (!id) continue;
        if (!Multi.needsTarget(id)) return { type: 'skill', skill: id };
        const foes = Multi.liveSlots(st, 1);
        if (foes.length === 1) return { type: 'skill', skill: id, target: foes[0] };
        const tg = await choose('だれをこうげきする？', foes.map((k) => {
          const d = Multi.fighterAt(st, 1, k), p = Math.ceil(mview.hp[1][Multi.idxAt(st, 1, k)] / d.maxHp * 100);
          const aff = BB.affinity(f.atkAttr, d.attr);
          return { label: `${BB.ATTRS[d.attr].emoji} <b>${d.name}</b> <span class="small">❤️ ${p}% ／ ${aff > 1 ? '◎ 有利' : aff < 1 ? '▼ 不利' : '－ 互角'}</span>`, value: k + 1 };
        }).concat([{ label: '← もどる', value: 0 }]));
        if (tg) return { type: 'skill', skill: id, target: tg - 1 };
      } else if (top === 'switch') {
        const to = await choose('だれとこうたいする？', bench.map((i) => {
          const m = st.sides[0].party[i];
          return { label: `${BB.ATTRS[m.attr].emoji} ${m.name} Lv${m.level}　❤️ ${mview.hp[0][i]}/${m.maxHp}`, value: i + 1 };
        }).concat([{ label: '← もどる', value: 0 }]));
        if (to) { taken.add(to - 1); return { type: 'switch', to: to - 1 }; }
      }
    }
  }
  // マルチの1試合。勝者（0=自分 1=相手 -1=引き分け）を返す
  async function runMultiBattle(mineList, foeList) {
    mySide = 0;
    st = Multi.createBattle(Multi.createSide('あなた', mineList, match.herbs), Multi.createSide('てき', foeList));
    mview = { hp: st.sides.map((sd) => sd.party.map((f) => f.hp)), field: [[0, 1], [0, 1]], herbs: [match.herbs, 3], seen: [new Set([0, 1]), new Set([0, 1])] };
    logLines = []; $('timeline2').innerHTML = ''; $('log2').innerHTML = '';
    $('starLine2').textContent = '相性：矢印の元の属性が、先に強い（×1.5）。同じ属性は ×0.75。図をタップで大きく表示 →';
    show('battle2'); renderMulti();
    say2(`${foeList[0].name} と ${foeList[1].name} が勝負をしかけてきた！`); await sleep(800);
    while (!st.over) {
      $('timeline2').innerHTML = '';
      const taken = new Set(), mineActs = [];
      for (const k of Multi.liveSlots(st, 0)) {
        const a = await chooseSlotAction(k, taken);
        if (a.type === 'giveup') return 'giveup';
        mineActs[k] = a;
      }
      renderMulti();
      await playMulti(Multi.resolveTurn(st, [mineActs, Multi.cpuActions(st, 1, rng)], rng));
      for (const { s, slot } of Multi.needReplace(st)) {
        let to = null;
        if (s === 0) {
          while (to === null) {
            const opts = Multi.benchAlive(st.sides[0]).map((i) => {
              const m = st.sides[0].party[i];
              return { label: `${BB.ATTRS[m.attr].emoji} ${m.name} Lv${m.level}　❤️ ${mview.hp[0][i]}/${m.maxHp}`, value: i + 1 };
            }).concat([{ label: '🏳 あきらめる', value: -1 }]);
            const v = await choose('次に出すキャラを選んでください', opts);
            if (v === -1) { if (await confirmGiveUp()) return 'giveup'; } else to = v - 1;
          }
        } else to = Multi.cpuReplace(st, 1);
        await playMulti([Multi.replaceSlot(st, s, slot, to)]);
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

  // あきらめた：経験値・お金・ドロップはなし。試合の中で使った回復薬だけ、へる（持ち込みも、戻らない）
  async function giveUpMatch() {
    for (const id of [...match.usedMine, ...st.sides[mySide].usedItems]) {
      player.bag[id] = (player.bag[id] || 1) - 1; if (player.bag[id] <= 0) delete player.bag[id];
      for (const c of Object.keys(player.party.items)) if (player.party.items[c] === id) delete player.party.items[c];
    }
    await savePlayer();
    $('resEmo').textContent = '🏳'; $('resTitle').textContent = 'あきらめた';
    $('resSub').textContent = 'この対戦では、経験値もお金もアイテムも、もらえません';
    $('rewards').innerHTML = '<div class="reward none" style="--d:0s"><div class="ic">🏳</div><div class="rb"><div class="rt">報酬なし</div><div class="small">また、がんばろう！</div></div></div>';
    $('foeRevealTitle').style.display = 'none'; $('foeReveal').innerHTML = '';
    if (pvp) await pvpEnd('giveup');
    renderWallet(); show('result');
  }

  // 結果：出場した戦士に経験値、お金、まれにアイテム
  const RESERVE_XP = 0.7;
  const WIN_XP_MULT = 2;                                  // 勝ったときの経験値だけ、さらに2倍
  const REWARD_MULT = 2;                                  // 戦いの報酬（経験値・お金）の倍率
  async function finishMatch() {
    const win = match.wins[0] > match.wins[1], draw = match.wins[0] === match.wins[1];
    $('resEmo').textContent = win ? '🏆' : draw ? '🤝' : '💀';
    $('resTitle').textContent = win ? 'しょうり！' : draw ? 'ひきわけ' : 'はいぼく…';
    const known = match.foeBase.filter((f) => f.level != null);   // 通信対戦：あいてが出してきた戦士のレベルだけ分かる
    const avgFoe = known.length ? Math.round(known.reduce((a, f) => a + f.level, 0) / known.length) : 1;
    $('resSub').textContent = match.pvp ? `${match.oppName} さんとの対戦：${match.wins[0]}勝 ${match.wins[1]}敗` : match.maxGames > 1 ? `3本勝負：${match.wins[0]}勝 ${match.wins[1]}敗` : (win ? 'てきのパーティを全員たおした' : draw ? 'どちらも全員が戦えなくなった' : 'パーティが全員たおされた');
    const members = [], boost2 = !!match.boost || player.xp2 === today();
    const baseXp = (win ? (30 + 5 * avgFoe) * WIN_XP_MULT : 10) * REWARD_MULT * (boost2 ? 2 : 1);
    // 出場した3体は満額、出番のなかった控えは7割
    for (const code of match.codes) {
      const e = dex[code]; if (!e) continue;
      const played = match.played.has(code), oldLv = e.level, oldXp = e.xp;
      e.xp = Math.max(e.xp, Math.min(e.xp + Math.round(baseXp * (played ? 1 : RESERVE_XP)), BB.xpForLevel(e.maxLv)));  // 経験値は減らない
      const gain = e.xp - oldXp;
      e.level = BB.levelFromXp(e.xp, e.maxLv); if (played) e[win ? 'wins' : 'losses']++;
      await Store.saveFighter(cur, e);
      members.push({ name: e.name, oldLv, e, gain, reserve: !played });
    }
    const gold = BB.rewardMoney(win, avgFoe, rng) * REWARD_MULT;
    player.money += gold;
    for (const id of match.usedMine) { // 使い切りのアイテムは、持ち物からへる
      player.bag[id] = (player.bag[id] || 1) - 1; if (player.bag[id] <= 0) delete player.bag[id];
      for (const c of Object.keys(player.party.items)) if (player.party.items[c] === id) delete player.party.items[c];
    }
    // ステージクリア：CPUに勝つと、次のステージが開く
    let unlock = null;
    if (win && match.stage && !match.pvp) {
      const no = STAGES.indexOf(match.stage) + 1;
      if (no > (player.stageClear || 0)) { player.stageClear = no; unlock = { stage: match.stage, next: STAGES[no] || null }; }
    }
    const dropId = BB.rollDrop(win, rng);
    if (dropId) player.bag[dropId] = (player.bag[dropId] || 0) + 1;
    await savePlayer();
    show('result');
    renderRewards({ members, gold, unlock, boost: boost2, drop: dropId ? BB.itemById(dropId) : null });
    $('foeRevealTitle').style.display = 'block';
    renderFoeReveal($('foeReveal'));
    if (pvp) await pvpEnd('done');
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
        : (e.maxLv < BB.MAX_LV ? `限界です（同じキャラ・属性のバーコードで限界Lv+${BB.LOT_STEP}。最大 Lv${BB.MAX_LV}）` : `最大 Lv${BB.MAX_LV}`);
      return `<div style="margin-bottom:8px"><div class="rt">${m.name}${m.reserve ? ' <span class="tag">控え 7割</span>' : ''} <b>+${m.gain}</b> <span class="small">Lv${e.level}　${note}</span></div>
        <div class="xpbar"><div style="width:${pct}%"></div></div>${e.level > m.oldLv ? `<div class="lvup">🎉 レベルアップ！ Lv${m.oldLv} → Lv${e.level}</div>` : ''}</div>`;
    }).join('');
    add(`<div class="ic">⭐</div><div class="rb"><div class="rt" style="margin-bottom:6px">経験値${r.boost ? ' <span class="tag">ブースト×2</span>' : ''}</div>${rows}</div>`);
    if (r.unlock) add(`<div class="ic">🎌</div><div class="rb"><div class="rt">ステージクリア！ ${r.unlock.stage.flag} ${r.unlock.stage.name}</div><div class="small">${r.unlock.next ? `次は ${r.unlock.next.flag} ${r.unlock.next.name} が遊べます` : '全ステージ制覇！おめでとう！'}</div></div>`);
    add(`<div class="ic">💰</div><div class="rb"><div class="rt">お金 <b>+${r.gold.toLocaleString()}</b></div><div class="small">所持金 ${player.money.toLocaleString()}</div></div>`);
    if (r.drop) {
      const el = add(`<div class="rimg"></div><div class="rb"><div class="rt">🎁 アイテムを手に入れた！</div><div class="rn">${r.drop.name}</div>
        <div class="small">${r.drop.text}</div><div class="small">🎒 持ち物に入りました（${player.bag[r.drop.itemId]}個）</div></div>`, 'drop');
      makeSticker(r.drop, 192).then((c) => el.querySelector('.rimg').appendChild(c));
    } else {
      add('<div class="ic">🎁</div><div class="rb"><div class="rt">アイテム</div><div class="small">今回はなし（まれに手に入ります）</div></div>', 'none');
    }
  }

  // ---------- 家族対戦（通信対戦：家族につないだユーザー同士。それぞれの端末で） ----------
  // 画面では「自分」が常に下側。内部の対戦は、どちらの端末でも同じ並び（ホスト=0、ゲスト=1）で、同じ乱数で処理するので、結果が同じになる
  const TURN_SECONDS = 45;
  const verOf = () => { const m = ((document.querySelector('script[src*="app.js"]') || {}).src || '').match(/v=([\w-]+)/); return m ? m[1] : ''; };
  const publicParty = (codes) => codes.map((c) => { const d = BB.decode(c); return { idx: d.idx, kk: d.kk, attr: d.attr }; }); // 見せ合いで見せるのは、姿と属性だけ
  const rngFor = (g, t) => BB.seeded(BB.hashStr(`${pvp.seed}|${g}|${t}`));
  const stateHash = () => BB.hashStr(`${st.round}|` + st.sides.map((s) => s.active + ':' + s.party.map((f) => f.hp).join(',')).join('/'));
  const myName = async () => ((await Store.listProfiles()).find((p) => p.id === cur) || { name: '？' }).name;

  // ---- ロビー ----
  async function openLobby() {
    PICK = 3; $('btnPick').textContent = 'この3体・この順番で決定';   // 家族対戦はシングル（選出3体）
    if (!window.Cloud || !Cloud.isConnected()) {
      await cloudMsg('家族につながっていません', 'ホームの「☁ 家族クラウド」で、家族につないでください。家族対戦は、同じ家族につながっているユーザー同士で遊べます。');
      return;
    }
    if (partyCodes().length < PICK) {
      const v = await choose('パーティが足りません', [
        { label: `対戦には${PICK}体以上必要です（いま${partyCodes().length}体）`, value: 0, disabled: true },
        { label: '👥 パーティ編成へ', value: 1 }, { label: '← もどる', value: 0 }]);
      if (v) openParty();
      return;
    }
    $('lobbyWait').style.display = 'none'; $('lobbyMsg').textContent = '';
    show('lobby'); refreshLobby();
  }
  async function refreshLobby() {
    const box = $('lobbyList'); box.innerHTML = '<p class="small">さがしています…</p>';
    try {
      const rooms = await Cloud.listRooms();
      box.innerHTML = rooms.length ? '' : '<p class="small">いま待っている部屋は、ありません。部屋を作って、家族に声をかけましょう。</p>';
      rooms.forEach((r) => {
        const row = document.createElement('div'); row.className = 'srow';
        row.innerHTML = `<div class="pinfo" style="flex:1"><b>${r.hostName}</b> さんが待っています<div class="small">${r.maxGames > 1 ? '🏆 3本勝負' : '⚔ 1本勝負'}　部屋 ${r.id.toUpperCase()}</div></div>`;
        const b = document.createElement('button'); b.textContent = '入る'; b.style.flex = 'none'; b.onclick = () => enterRoom(r.id); row.appendChild(b);
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = `<p class="small">${/permission-denied/.test(String(e.code || e.message)) ? '待っている部屋の一覧を出すには、Firebaseのルールの更新が必要です。下の「部屋コード」では入れます。' : Cloud.explain(e)}</p>`;
    }
  }
  async function hostRoom(games) {
    $('lobbyMsg').textContent = '';
    try {
      const name = await myName();
      const rid = await Cloud.createRoom({ name, maxGames: games, party: publicParty(partyCodes()), ver: verOf() });
      pvp = { rid, isHost: true, uid: Cloud.uid(), myName: name, maxGames: games, waiters: new Set(), started: false };
      $('roomCode').textContent = rid.toUpperCase();
      $('waitInfo').textContent = `あいてを待っています…（${games > 1 ? '3本勝負' : '1本勝負'}）`;
      $('lobbyWait').style.display = 'block';
      pvp.unsub = Cloud.watchRoom(rid, onRoomChange);
    } catch (e) { $('lobbyMsg').textContent = Cloud.explain(e); }
  }
  async function cancelRoom() {
    if (pvp && !pvp.started) { const p = pvp; pvp = null; p.unsub && p.unsub(); await Cloud.deleteRoom(p.rid); }
    $('lobbyWait').style.display = 'none';
  }
  async function enterRoom(rid) {
    $('lobbyMsg').textContent = '';
    try {
      const name = await myName();
      const room = await Cloud.joinRoom(rid, { name, party: publicParty(partyCodes()), ver: verOf() });
      pvp = { rid: room.id, isHost: false, uid: Cloud.uid(), myName: name, maxGames: room.maxGames, waiters: new Set(), started: true };
      pvp.unsub = Cloud.watchRoom(room.id, onRoomChange);
      await beginPvpMatch(room);
    } catch (e) {
      const m = String(e.message);
      $('lobbyMsg').textContent = m === 'not-found' ? 'その部屋が見つかりません（コードを確かめてください）' : m === 'full' ? 'その部屋は、もう始まっているか、いっぱいです'
        : m === 'self' ? '自分の部屋には入れません' : m === 'other-family' ? 'ほかの家族の部屋です' : /^ver:/.test(m) ? `あいてのゲームの版が違います（あいて ${m.slice(4)}／自分 ${verOf()}）。両方の画面を、更新してください` : Cloud.explain(e);
    }
  }
  function onRoomChange(room) {
    if (!pvp || !room) return;
    if (pvp.isHost && room.state === 'select' && !pvp.started) { pvp.started = true; beginPvpMatch(room); }
    if (room.state === 'closed' && room.reason === 'left' && room.closedBy !== pvp.uid && !pvp.goneShown) opponentGone();
  }

  // ---- 試合のはじまり ----
  async function beginPvpMatch(room) {
    pvp.oppUid = pvp.isHost ? room.guestUid : room.hostUid;
    pvp.oppName = pvp.isHost ? room.guestName : room.hostName;
    pvp.hostName = room.hostName; pvp.guestName = room.guestName; pvp.seed = room.seed;
    mySide = pvp.isHost ? 0 : 1;
    const codes = partyCodes();
    match = { pvp: true, oppName: pvp.oppName, maxGames: room.maxGames, game: 0, wins: [0, 0], codes, usedMine: [], usedFoe: [], foeUsedGames: [], played: new Set(), foeBase: [],
      herbs: 3 + player.carry.herbs, boost: player.carry.boost, carryBack: { herbs: player.carry.herbs, boost: player.carry.boost }, battleStarted: false };
    match.carryText = [player.carry.herbs ? `薬草+${player.carry.herbs}` : '', player.carry.boost ? '経験値×2' : ''].filter(Boolean).join('・');
    if (player.carry.herbs || player.carry.boost) { player.carry = { herbs: 0, boost: false }; await savePlayer(); }
    const oppPub = pvp.isHost ? room.guestParty : room.hostParty;
    // 相手の6体：姿と属性だけ（レベルとアイテムは、選出が決まるまで分からない）
    match.foeBase = oppPub.map((p) => { const f = BB.makeFighter(BB.stickerDec(p.idx, p.kk, p.attr), null, 1); f.level = null; f.pub = true; return f; });
    const mine0 = codes.map((c) => BB.makeFighter(BB.decode(c), null, dex[c].level));
    await Promise.all(match.foeBase.map(async (f) => { f.canvas = await makeSticker(f, 160); }));
    await Promise.all(codes.map(async (c, i) => { canvasCache[c] = await makeSticker(mine0[i], 160); }));
    await nextPvpGame();
  }
  async function nextPvpGame() {
    match.game++;
    myParty = match.codes.map(memberFighter);
    foeParty = match.foeBase;
    picked = []; focusMine = 0; foeFocus = null;
    pvp.oppDecided = false;
    if (pvp.watchPicks) pvp.watchPicks.cancel();
    pvp.watchPicks = Cloud.waitSub(pvp.rid, 'picks', `${match.game}_${pvp.oppUid}`);   // あいてが決めたかを、見張る（表示用）
    pvp.watchPicks.promise.then((v) => { if (v) pvp.oppDecided = true; });
    $('gameNo').textContent = `（${pvp.oppName} さんと対戦）` + (match.maxGames > 1 ? `（第${match.game}試合／先に2勝）` : '') + (match.carryText ? `（持ち込み：${match.carryText}）` : '');
    $('matchHist').textContent = match.foeUsedGames.length ? '　印G＝前の試合で出てきた' : '';
    $('btnPick').textContent = 'この3体・この順番で決定';
    renderPick(); show('preview');
    startPickTimer();
  }

  // ---- 選出の送りあい ----
  async function pvpGuard(fn) {
    try { return await fn(); } catch (e) { if (e && (e.message === 'aborted' || e.message === 'timeout')) return undefined; throw e; }
  }
  // あいての入力が来るのを待つ。60秒こなければ「まだ待つ／退出」をたずねる。null=あいてがいない
  async function waitOpp(sub, docId) {
    for (;;) {
      const w = Cloud.waitSub(pvp.rid, sub, docId, { timeoutMs: 60000 });
      pvp.waiters.add(w);
      const v = await w.promise;
      pvp.waiters.delete(w);
      if (v === undefined) {
        const leave = await choose('あいてを待っています', [
          { label: 'あいての入力が、まだ届きません。', value: 0, disabled: true },
          { label: 'もう少し待つ', value: 0 }, { label: '退出する（この対戦は終わります）', value: 1 }]);
        if (leave) { await leavePvp('left'); return null; }
        continue;
      }
      return v;
    }
  }
  async function confirmPickPvp() {
    clearInterval(pickTimer);
    const g = match.game;
    const mineSim = picked.map((i) => { // 自分の戦士も、仕様から作り直す（あいての端末と、まったく同じものになる）
      const f = BB.fighterFromSpec({ ...BB.specOf(myParty[i]) });
      f.code = myParty[i].code; f.canvas = myParty[i].canvas; f.slot = i; return f;
    });
    $('btnPick').disabled = true; $('btnPick').textContent = 'あいての決定を待っています…';
    try {
      await Cloud.setSub(pvp.rid, 'picks', `${g}_${pvp.uid}`, { picks: mineSim.map((f) => ({ ...BB.specOf(f), slot: f.slot })), herbs: match.herbs });
    } catch (e) { await pvpFail(e); return; }
    const opp = await waitOpp('picks', `${g}_${pvp.oppUid}`);
    if (!opp) return;
    const foeList = opp.picks.map((sp) => {
      const f = BB.fighterFromSpec(sp); f.canvas = foeParty[sp.slot].canvas; f.slot = sp.slot;
      match.foeBase[sp.slot] = f; return f;                       // これで、あいてのレベルとアイテムが分かる（試合のあとの公開に使う）
    });
    const foeSel = opp.picks.map((sp) => sp.slot);
    await revealSelections(mineSim, foeList);
    match.battleStarted = true;
    const res = await runPvpBattle(mineSim, foeList, opp.herbs);
    if (res.type === 'gone') return;
    await afterPvpGame(res, foeSel);
  }

  // ---- 入力の時間制限（通信対戦のターンだけ。時間切れは自動で「こうげき」） ----
  let turnIv = null;
  function stopTurnTimer() { clearInterval(turnIv); turnIv = null; turnExpired = false; $('turnTimer').textContent = ''; }
  async function timedChoice(fn, fallback) {
    let left = TURN_SECONDS; turnExpired = false;
    const el = $('turnTimer');
    const tick = () => { el.innerHTML = `⏱ のこり <b>${left}</b> 秒${left <= 10 ? '（時間切れは自動で「こうげき」）' : ''}`; el.classList.toggle('warnt', left <= 10); };
    tick(); clearInterval(turnIv);
    turnIv = setInterval(() => {
      left--; tick();
      if (left <= 10 && left > 0) beep(left <= 3 ? 1320 : 880);
      if (left <= 0) { turnExpired = true; clearInterval(turnIv); cancelChoose('timeout'); }
    }, 1000);
    try { return await fn(); } catch (e) { if (e && e.message === 'timeout') return fallback(); throw e; } finally { stopTurnTimer(); }
  }

  // ---- 1試合の対戦（両方の端末で、同じ入力・同じ乱数で処理する） ----
  async function runPvpBattle(mineList, foeList, oppHerbs) {
    const g = match.game, me = mySide, opp = 1 - me;
    const lists = me === 0 ? [mineList, foeList] : [foeList, mineList];
    const herbs = me === 0 ? [match.herbs, oppHerbs] : [oppHerbs, match.herbs];
    st = Battle.createBattle(Battle.createSide(pvp.hostName, lists[0], herbs[0]), Battle.createSide(pvp.guestName, lists[1], herbs[1]));
    view = { hp: st.sides.map((sd) => sd.party.map((f) => f.hp)), active: [0, 0], herbs: herbs.slice(), seen: [new Set([0]), new Set([0])], hist: [[], []] };
    logLines = []; $('timeline').innerHTML = ''; $('log').innerHTML = '';
    $('starLine').textContent = '相性：矢印の元の属性が、先に強い（×1.5）。同じ属性は ×0.75。図をタップで大きく表示 →';
    show('battle'); renderBattle();
    say(`${foeList[0].name} が勝負をしかけてきた！`); await sleep(700);
    for (let t = 1; !st.over; t++) {
      $('timeline').innerHTML = '';
      const h0 = stateHash();
      const myAct = await timedChoice(() => chooseAction(), () => ({ type: 'skill', skill: 'attack' }));
      try { await Cloud.setSub(pvp.rid, 'turns', `${g}_${t}_${pvp.uid}`, { a: myAct, h: h0 }); } catch (e) { await pvpFail(e); return { type: 'gone' }; }
      if (myAct.type === 'giveup') return { type: 'giveup', giver: me };
      say('あいての入力を待っています…');
      const oa = await waitOpp('turns', `${g}_${t}_${pvp.oppUid}`);
      if (!oa) return { type: 'gone' };
      if (oa.h !== undefined && oa.h !== h0 && window.__showErr) __showErr(`同期のずれを検出（ターン${t}）。両方の画面を更新してください`);
      if (oa.a.type === 'giveup') return { type: 'giveup', giver: opp };
      const actions = me === 0 ? [myAct, oa.a] : [oa.a, myAct];
      await playEvents(Battle.resolveTurn(st, actions, rngFor(g, t)));
      for (const s of Battle.needReplace(st)) {      // たおれたあとは、次に出すキャラを選ぶ（選ぶ側が送り、もう一方は待つ）
        let to;
        if (s === me) {
          to = await timedChoice(async () => { let v = null; while (v === null) v = await pickBench('次に出すキャラを選んでください', false); return v; }, () => Battle.benchAlive(st.sides[me])[0]);
          try { await Cloud.setSub(pvp.rid, 'rep', `${g}_${t}_${s}`, { to }); } catch (e) { await pvpFail(e); return { type: 'gone' }; }
          if (to === 'giveup') return { type: 'giveup', giver: me };
        } else {
          const r = await waitOpp('rep', `${g}_${t}_${s}`);
          if (!r) return { type: 'gone' };
          if (r.to === 'giveup') return { type: 'giveup', giver: opp };
          to = r.to;
        }
        await playEvents([Battle.replaceActive(st, s, to)]);
      }
      await sleep(250);
    }
    await sleep(500);
    return { type: 'done', winner: st.winner };
  }
  async function afterPvpGame(res, foeSel) {
    const me = mySide, need = match.maxGames === 1 ? 1 : 2;
    match.foeUsedGames.push(foeSel);
    picked.forEach((i) => match.played.add(match.codes[i]));
    match.usedMine.push(...st.sides[me].usedItems); match.usedFoe.push(...st.sides[1 - me].usedItems);
    if (res.type === 'giveup') {
      if (res.giver === me) { await giveUpMatch(); return; }          // 自分があきらめた
      match.wins = [need, 0]; await finishMatch(); return;           // あいてがあきらめた：自分の勝ち
    }
    if (res.winner === me) match.wins[0]++; else if (res.winner === 1 - me) match.wins[1]++;
    if (match.wins[0] >= need || match.wins[1] >= need || match.game >= match.maxGames) { await finishMatch(); return; }
    $('btEmo').textContent = res.winner === me ? '🏆' : res.winner === 1 - me ? '💀' : '🤝';
    $('btTitle').textContent = `第${match.game}試合 ${res.winner === me ? 'しょうり！' : res.winner === 1 - me ? 'はいぼく…' : 'ひきわけ'}`;
    $('btSub').textContent = `ここまで ${match.wins[0]}勝 ${match.wins[1]}敗（先に2勝で勝ち）`;
    renderFoeReveal($('btFoe'));
    show('between');
  }

  // ---- 退出・終わり ----
  async function pvpEnd(reason) {
    const p = pvp; if (!p) return;
    pvp = null; mySide = 0; stopTurnTimer();
    p.waiters.forEach((w) => w.cancel()); if (p.watchPicks) p.watchPicks.cancel();
    p.unsub && p.unsub();
    await Cloud.closeRoom(p.rid, reason || 'done');
  }
  async function leavePvp(reason) {            // 自分から抜ける：戦いが始まる前なら、持ち込み（薬草・ブースト）は返す
    clearInterval(pickTimer);
    if (match && !match.battleStarted && match.game <= 1 && (match.carryBack.herbs || match.carryBack.boost)) { player.carry = { ...match.carryBack }; await savePlayer(); }
    await pvpEnd(reason || 'left');
    match = null; renderWallet(); show('home');
  }
  async function opponentGone() {             // あいてが抜けた
    if (!pvp || pvp.goneShown) return;
    pvp.goneShown = true;
    clearInterval(pickTimer); cancelChoose('aborted');
    if (match && !match.battleStarted && match.game <= 1 && (match.carryBack.herbs || match.carryBack.boost)) { player.carry = { ...match.carryBack }; await savePlayer(); }
    const p = pvp; pvp = null; mySide = 0; stopTurnTimer();
    p.waiters.forEach((w) => w.cancel()); if (p.watchPicks) p.watchPicks.cancel(); p.unsub && p.unsub();
    match = null; renderWallet(); show('home');
    await cloudMsg('あいてが退出しました', 'この対戦は終わりました。経験値もお金も、もらえません。');
  }
  async function pvpFail(e) { await cloudMsg('通信できませんでした', Cloud.explain(e)); await leavePvp('left'); }

  $('btnPvp').onclick = openLobby;
  $('btnRoom1').onclick = () => hostRoom(1);
  $('btnRoom3').onclick = () => hostRoom(3);
  $('btnRoomCancel').onclick = cancelRoom;
  $('btnLobbyRefresh').onclick = refreshLobby;
  $('btnRoomJoin').onclick = () => { const v = $('inRoom').value.trim(); if (v) enterRoom(v); };
  $('btnLobbyBack').onclick = async () => { await cancelRoom(); show('home'); };

  // ---------- お店（今日の品・売る・修行・持ち込み・見た目） ----------
  const XP_PRICE = 1;                                       // 修行：1XP=1円（回数の上限なし）
  const CARRY_HERB_PRICE = 120, CARRY_HERB_MAX = 2, BOOST_PRICE = 250, DAY_BOOST_PRICE = 700;
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
  // 🏋 修行：お金で経験値を買う（回数の上限なし。限界レベルは超えない）
  function shopTrain(box) {
    box.insertAdjacentHTML('beforeend', `<p class="small">1XP＝${XP_PRICE}円。<b>回数の上限はありません</b>（お金があるだけ、何度でも）。限界レベルを超えては上がりません。</p>`);
    const list = Object.values(dex).sort((a, b) => b.level - a.level || b.xp - a.xp);
    if (!list.length) box.insertAdjacentHTML('beforeend', '<p class="small">図鑑に戦士がいません。</p>');
    list.forEach((e) => {
      const capXp = BB.xpForLevel(e.maxLv), base = BB.xpForLevel(e.level), need = BB.xpForLevel(e.level + 1) - base;
      const pct = e.level >= e.maxLv ? 100 : Math.round((e.xp - base) / need * 100);
      const A = BB.ATTRS[e.attr];
      const gainOf = (req) => Math.max(0, Math.min(req, capXp - e.xp));
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
        buttons: [btn(50), btn(200), btn(1000)],
      });
    });
  }
  // 🎒 持ち込み：次の試合だけ有効（試合を始めると使われる）
  function shopCarry(box) {
    box.insertAdjacentHTML('beforeend', '<p class="small">薬草と「経験値ブースト」は<b>次の試合だけ</b>有効です（試合を始めると使われます。3本勝負なら、その3試合ぶん）。「きょう1日」は、きょう中の全部の試合で有効です。</p>');
    const c = player.carry;
    srow(box, {
      html: `<b>🌿 薬草 +1</b><div class="small">薬草が3個→4個（最大+${CARRY_HERB_MAX}まで）。いま +${c.herbs}</div><div>${yen(CARRY_HERB_PRICE)}</div>`,
      buttons: [['買う', async () => { c.herbs++; await pay(CARRY_HERB_PRICE); shopMsg('🌿 薬草を持ち込みます（次の試合）'); renderShop(); }, c.herbs >= CARRY_HERB_MAX || player.money < CARRY_HERB_PRICE]],
    });
    const dayOn = player.xp2 === today();
    srow(box, {
      html: `<b>🌟 きょう1日 経験値ブースト</b><div class="small">きょう（夜12時まで）の試合は、ずっと経験値が×2${dayOn ? '　<span class="tag">きょうは有効</span>' : ''}</div><div>${yen(DAY_BOOST_PRICE)}</div>`,
      buttons: [[dayOn ? '有効中' : '買う', async () => { player.xp2 = today(); await pay(DAY_BOOST_PRICE); shopMsg('🌟 きょう1日、経験値が2倍になります'); renderShop(); }, dayOn || player.money < DAY_BOOST_PRICE]],
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
    if (!window.Cloud) { $('cloudState').textContent = 'クラウドは つかえません（このたんまつに だけ ほぞんされます）'; return; }
    const mkb = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; box.appendChild(b); };
    if (Cloud.isConnected()) {
      $('cloudState').innerHTML = `☁ つながっています　かぞくコード：<b>${Cloud.familyCode()}</b><br>${Cloud.status() || ''}`;
      mkb('🔄 いますぐ どうき', cloudSync); mkb('📋 コードをコピー', cloudCopy); mkb('きりはなす', cloudLeave);
    } else {
      $('cloudState').textContent = 'つながっていません（いまは、このたんまつに だけ ほぞんされています）';
      mkb('🔗 かぞくにつなぐ', cloudCreate); mkb('🔑 かぞくコードで さんか', () => cloudJoin(false));
    }
  }
  const cloudMsg = (title, lines) => choose(title, [{ label: lines, value: 0, disabled: true }, { label: 'とじる', value: 0 }]);
  async function cloudCreate() {
    const ok = await choose('家族につなぐ', [
      { label: 'この端末のユーザー（図鑑・お金・パーティ）が、クラウドに保存されます。家族コードが作られます。ほかの端末は、そのコードで同じ家族につなげます。', value: 0, disabled: true },
      { label: '✅ つなぐ（家族コードを作る）', value: 1 }, { label: 'やめる', value: 0 }]);
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
      await cloudMsg('参加しました', `家族コード ${r.code} につながりました。<br><span class="small">ユーザーを ${r.imported}人ぶん受け取り、${r.pushed}人ぶん送りました。</span>`);
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
  $('btnAgain').onclick = () => (match && match.pvp ? openLobby() : startMatch(match ? match.maxGames : 1, !!(match && match.multi)));
  $('btnHome').onclick = () => { renderWallet(); show('home'); };
  $('btnHelp').onclick = () => modal(`<h2 style="margin:0 0 8px;font-size:16px">あそびかた</h2>
    <p class="small" style="line-height:1.7">・バーコード（標準タイプのJAN。13桁）から、戦士の「シール」が決まります。先頭が45・49の商品が戦士（①②。45と49は同じ）、9784の書籍がアイテムです。それ以外は使えません。<br>
    ・戦士は、スキャン（カメラ・写真・数字の直接入力）・ランダムのあと、その場で図鑑に登録されます。シールは3層：キャラ（⑤⑥）／キラキラ（⑦⑧）／属性（⑨）。③④は使いません。<br>
    ・<b>キラキラで強さが変わります</b>（弱い順）：ベーシック（Lv1から・限界Lv10）／EX（Lv10から・全能力×1.1・限界30）／レア（Lv20から・×1.2・限界50）／スーパーレア（Lv30から・×1.2・限界70）／ハロウィン（Lv40から・×1.2・限界90）／レジェンド（Lv50から・×1.2・限界99）。能力は最大999。<br>
    ・同じキャラ・同じ属性のバーコードを読むと、<b>上位のキラキラなら上書き</b>（レベルや経験値はそのまま）、<b>同等か下位なら限界レベル+10</b>（最大Lv99）。<br>
    ・「👥 パーティ編成」で最大6体を選びます（同じキャラは1体まで）。持たせるアイテムも決めます（同じアイテムは1体まで）。<br>
    ・「2x2」（マルチ）：6体から<b>4体</b>を選び、先発の<b>2体</b>が場に同時に出ます（残り2体は控え）。毎ターン、場の2体それぞれが、スキルを使うか交代するかを決め、こうげきは<b>相手の2体のどちらを狙うか</b>もえらびます。相手の2体を倒す（控えも全員倒す）と勝ち。CPUとの1本勝負で、ステージ・経験値・お金はシングルと同じです。<br>
    ・CPUとの対戦は、はじめに<b>ステージ（国名・10段階）</b>をえらびます。後ろの国ほどCPUが強く、もらえる経験値とお金も多くなります。<b>勝ってクリアすると、次の国が開きます</b>（最初は日本だけ）。<br>
    ・「⚔ たいせん」：「シングル（1本）」か「3かい（同じ6体で最大3試合、先に2勝）」。相手のパーティと見せ合い、制限時間60秒で戦う3体と、先発・控えの順番を決めます。見えるのは相手の6体の姿と属性だけです。<br>
    ・選ぶときは、カードをタップするとステータス・スキル・アイテムの詳細が出ます。「🔎 相性ヒント」をオンにすると、相手のカードをタップして、自分の6体の有利・不利を確かめられます。<br>
    ・3本勝負では、前の試合で相手が出したキャラに「G」の印が付きます。試合のあとに、相手のパーティが公開されます。<br>
    ・毎ターン、自分と相手が<b>同時に</b>スキルか交代を決め、一斉に処理されます。順番は <b>交代 → 優先度の高いスキル → 👟の高い順</b> です。<br>
    ・ステータスのマーク：❤️ たいりょく／⚔️ こうげき／🛡️ ぼうぎょ／👟 すばやさ（はやい人が先に動く）／✨ とくしゅ（特殊技の強さ）。<br>
    ・スキル：こうげき／クイック（優先度+1）／とくしゅ（防御無視・必中、3ターンに1回）／ガード（優先度+3、連続不可）／やくそう／パワーキー／アイテム。<br>
    ・属性の相性：炎→風→土→雷→水→炎が有利（×1.5）。不利×0.5、同じ属性×0.75。<br>
    ・戦いのあとに、経験値（参加した3体は全部、控えの3体は7割。勝つと経験値は特に多い）・お金・まれにアイテム（勝ち12%／負け3%）がもらえます。<br>
    ・「ランダム」は、戦士・アイテムそれぞれ1日1回だけです。「🌟 コラボスキャン」は、合言葉を知っている家族だけの特別なキャラです（読み取りのルールは、ふつうのスキャンと同じ）。<br>
    ・「かぞく」（家族対戦）：家族クラウドにつないでいるユーザー同士で、それぞれの端末で対戦できます。部屋を作る／待っている部屋に入る／部屋コードで入る。毎ターンの入力は45秒、時間切れは自動で「たたかう」。「あきらめる」はあいての勝ち。<br>
    ・「☁ 家族クラウド」：家族コードで、端末をまたいで図鑑・お金・パーティを共有できます（コードは家族以外に教えないでください）。<br>
    ・「🏪 お店」：毎日かわる3つの品を買う／持ち物を売る／お金で経験値を買う「修行」（上限なし）／次の試合だけの「持ち込み」（薬草+1・経験値×2）／称号とシールの枠（見た目だけ）。<br>
    ・書籍のアイテムは、手に入れると持ち物に入ります（同じバーコードは1回だけ）。使い切りの回復薬は、使うと持ち物からへります。</p>
    <button class="pri" onclick="document.getElementById('modalMask').classList.remove('on')" style="width:100%">閉じる</button>`);

  if (window.Cloud) Cloud.onStatus = renderCloud;
  renderCloud();   // まず表示する（このあとの読み込みで何かあっても、家族クラウドのボタンは出す）
  (window.Collab ? Collab.tryStored() : Promise.resolve()).catch(() => {}).then(() => loadProfiles()).then(() => {
    renderCloud();
    if (window.Cloud) Cloud.init(() => loadProfiles());   // つながっていれば、起動時に同期（新しいデータがあれば取り込む）
  }).catch((e) => { renderCloud(); if (window.__showErr) __showErr('読み込み：' + (e && (e.message || e))); });
})();
