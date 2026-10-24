// バーコードバトラー 戦闘エンジン（画面に依存しない純粋ロジック）
// ブラウザでは window.BB、Node では module.exports として使える。データは data.js（BB_DATA）。
(function (root) {
  const DATA = root.BB_DATA || (typeof require !== 'undefined' ? require('./data.js') : null);

  // ---- 属性 ----
  // 0風 1土 2水 3炎 4雷。相性の輪：炎→風→土→雷→水→炎（有利×1.5、不利×0.5、同属性×0.75）
  const ATTRS = DATA.attrs;
  const ATTR_OF_KEY = { wind: 0, earth: 1, water: 2, fire: 3, thunder: 4 };
  const BEATS = { 3: 0, 0: 1, 1: 4, 4: 2, 2: 3 }; // 左が右に有利
  function affinity(att, def) {
    if (att === def) return 0.75;
    if (BEATS[att] === def) return 1.5;
    if (BEATS[def] === att) return 0.5;
    return 1.0;
  }

  // ---- バーコード ----
  // 標準タイプJAN（13桁。12桁＋チェックデジット）だけを有効とする
  function checkDigit(first12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += +first12[i] * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
  }
  function isValidJan(code) {
    const s = String(code);
    return /^\d{13}$/.test(s) && checkDigit(s) === +s[12];
  }
  // 先頭が45/49＝戦士（シール）、9784＝アイテム（書籍）。それ以外は無効
  function prefixKind(code) {
    const s = String(code);
    if (/^(45|49)/.test(s)) return 'char';
    if (/^9784/.test(s)) return 'item';
    return null;
  }
  // 同じシール（キャラ・キラキラ・属性が同じ）を表すキー。45と49は同じ扱い。戦士は ⑤〜⑨ の5桁で決まるので、③④は見ない
  function identityKey(code) {
    const s = String(code);
    return prefixKind(s) === 'char' ? '4x' + s.slice(4, 9) : s.slice(0, 7);
  }

  // ⑤⑥（00〜99）→ キラキラの種類（限界レベルを表す）
  function kirakiraOf(n) {
    let k = DATA.kirakira[0];
    for (const x of DATA.kirakira) if (n >= x.from) k = x;
    return k;
  }

  function describeItem(e) {
    const STAT = { hp: 'HP', st: 'ST', df: 'DF', dx: 'DX', sp: '特殊' };
    const STATUS = { poison: '毒', stun: '麻痺', sleep: '眠り' };
    if (e.kind === 'consumable') {
      const p = [];
      if (e.heal_hp_pct) p.push(`HP${e.heal_hp_pct}%回復`);
      if (e.heal_mp) p.push('特殊技がすぐ使える');
      if (e.cure) p.push('状態異常を治す');
      return '使い切り：' + p.join('・');
    }
    const p = Object.entries(e.bonus).map(([k, v]) => `${STAT[k]}${v > 0 ? '+' : ''}${v}`);
    if (e.element) p.push((e.slot === 'weapon' ? '攻撃' : '体') + 'の属性が' + ATTRS[ATTR_OF_KEY[e.element]].name);
    for (const [k, v] of Object.entries(e.inflict || {})) p.push(`${STATUS[k]}${v}%`);
    for (const [k, v] of Object.entries(e.resist || {})) p.push(`${ATTRS[ATTR_OF_KEY[k]].name}ダメージ-${v}%`);
    if ((e.immune || []).length) p.push(e.immune.map((s) => STATUS[s]).join('・') + '無効');
    return p.join('、') || '-';
  }

  // バーコード → 戦士（シール）／アイテム
  //   戦士(45/49): ⑤⑥=キャラ(00〜99)、⑦⑧=キラキラ(00〜99)、⑨=属性(% 5)。③④は使わない
  //   アイテム(9784): ⑤⑥⑦=000〜999 → 番号 % 68
  function decode(code) {
    if (!isValidJan(code)) return null;
    const kind = prefixKind(code);
    if (!kind) return null;
    const s = String(code), g = (n) => +s[n - 1];
    const base = { code: s, prefix: identityKey(s), kind };
    if (kind === 'char') {
      const idx = g(5) * 10 + g(6), c = DATA.chars[idx], kk = kirakiraOf(g(7) * 10 + g(8));
      return { ...base, idx, id: c.id, name: c.name, breed: c.breed, role: c.role, type: c.type, init: c.init, growth: c.growth,
        attr: g(9) % 5, kirakira: kk, limit: kk.limit };
    }
    const it = DATA.items[(g(5) * 100 + g(6) * 10 + g(7)) % DATA.items.length];
    return { ...base, itemId: it.id, name: it.name, effect: it.effect, text: describeItem(it.effect) };
  }

  // 有効なJAN13を作る。戦士は45/49始まり、アイテムは9784始まり
  function randomCode(kind, rng) {
    rng = rng || Math.random;
    let s = kind === 'item' ? '9784' : ['45', '49'][Math.floor(rng() * 2)];
    while (s.length < 12) s += Math.floor(rng() * 10);
    return s + checkDigit(s);
  }

  // EAN-13 の描画用ビット列
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const R = L.map((s) => s.replace(/[01]/g, (c) => (c === '0' ? '1' : '0')));
  const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  function barBits(code) {
    const d = [...String(code).replace(/\D/g, '').padStart(13, '0').slice(0, 13)].map(Number);
    const par = PAR[d[0]];
    let bits = '101';
    for (let i = 0; i < 6; i++) bits += (par[i] === 'L' ? L : G)[d[i + 1]];
    bits += '01010';
    for (let i = 7; i < 13; i++) bits += R[d[i]];
    return bits + '101';
  }

  // ---- 育成 ----
  const MAX_LV = 60;
  const START_LIMIT = 5; // 最初の限界レベル。別ロットのバーコードで+5ずつ、キラキラの限界まで
  const LOT_STEP = 5;
  const xpForLevel = (lv) => (25 * (lv - 1) * lv) / 2;
  function levelFromXp(xp, maxLv) {
    const cap = Math.min(MAX_LV, maxLv || MAX_LV);
    let lv = 1;
    while (lv < cap && xp >= xpForLevel(lv + 1)) lv++;
    return lv;
  }
  const maxLevelOf = (limit, lots) => Math.min(limit, START_LIMIT + LOT_STEP * lots);
  // レベルごとの能力（最大999）
  function statsAt(dec, lv) {
    const o = {};
    for (const k of ['hp', 'st', 'df', 'dx', 'sp']) o[k] = Math.min(999, dec.init[k] + dec.growth[k] * (lv - 1));
    return o;
  }

  // ---- 戦闘 ----
  const HP_SCALE = 10; // HPの能力値 × 10 が体力の合計
  // 戦闘用の個体。item はアイテム(decode結果)か null
  function makeFighter(dec, item, level) {
    level = level || 1;
    const st = statsAt(dec, level);
    const e = item ? item.effect : null;
    const f = {
      ...dec, level, atkAttr: dec.attr, bodyAttr: dec.attr,
      herbs: 3, spCd: 0, status: { poison: 0, stun: 0 }, item: item || null,
      resist: {}, immune: [], inflict: {}, consumable: null,
    };
    if (e && e.kind === 'equipment') {
      for (const [k, v] of Object.entries(e.bonus)) st[k] = Math.max(1, st[k] + v);
      if (e.element) { if (e.slot === 'weapon') f.atkAttr = ATTR_OF_KEY[e.element]; else if (e.slot === 'armor') f.bodyAttr = ATTR_OF_KEY[e.element]; }
      f.inflict = e.inflict || {}; f.resist = e.resist || {}; f.immune = e.immune || [];
    } else if (e && e.kind === 'consumable') {
      f.consumable = e;
    }
    f.st = st.st; f.df = st.df; f.dx = st.dx; f.sp = st.sp;
    f.maxHp = st.hp * HP_SCALE; f.hp = f.maxHp;
    return f;
  }

  // 行動順の値（大きい方が先攻）
  const initiative = (f, rng) => f.dx + Math.floor(rng() * 30);
  const hitChance = (a, d) => Math.max(0.55, Math.min(1, 0.8 + (a.dx - d.dx) / 800));
  const rollHit = (a, d, rng) => rng() < hitChance(a, d);

  // 属性ダメージの倍率（相性＋防御側の耐性）
  function elementMult(a, d) {
    let m = affinity(a.atkAttr, d.bodyAttr);
    const key = ATTRS[a.atkAttr].key;
    if (d.resist[key]) m *= 1 - d.resist[key] / 100;
    return m;
  }

  // 通常攻撃。timing は 1〜2
  function calcDamage(a, d, timing, rng) {
    const r = Math.floor(rng() * 5) * 2 / 10;
    const raw = a.st * (2 + r);
    const base = Math.max(a.st * 0.2, (raw - d.df) / 2) + 5;
    const mult = elementMult(a, d);
    const dmg = Math.max(1, Math.round(base * mult * timing));
    return { dmg, mult, crit: timing >= 1.9 };
  }

  // 特殊技：特殊能力値で攻撃。防御は無視、必ず当たる。3ターンに1回
  const SP_COOLDOWN = 3;
  function specialDamage(a, d, timing) {
    const mult = elementMult(a, d);
    return { dmg: Math.max(1, Math.round((a.sp * 2.2 + 5) * mult * (0.8 + (timing - 1) * 0.4))), mult };
  }

  // 武器の状態異常（当たったときの確率）。かかったものを返す
  function tryInflict(a, d, rng) {
    const got = [];
    for (const [k, pct] of Object.entries(a.inflict)) {
      if (d.immune.includes(k) || d.status[k] === undefined || d.status[k] > 0) continue;
      if (rng() * 100 < pct) { d.status[k] = k === 'poison' ? 3 : 1; got.push(k); }
    }
    return got;
  }
  // 自分のターンの始めの処理。毒のダメージと、麻痺で行動できないかを返す
  function startTurn(f) {
    let poison = 0, skip = false;
    if (f.spCd > 0) f.spCd--;
    if (f.status.poison > 0) { poison = Math.max(1, Math.round(f.maxHp * 0.06)); f.hp = Math.max(0, f.hp - poison); f.status.poison--; }
    if (f.status.stun > 0) { skip = true; f.status.stun--; }
    return { poison, skip };
  }

  // 長引いた戦いは決着がつくように、21ラウンド目から全ダメージが少しずつ増える（ラウンド=お互いが1回ずつ動く）
  const fatigue = (round) => (round <= 20 ? 1 : 1 + (round - 20) * 0.15);

  // 薬草 n 個の回復（1個=最大HPの20%）
  function healAmount(f, n) { return Math.min(f.maxHp - f.hp, Math.round((f.maxHp * n * 2) / 10)); }
  // パワーキー：薬草1個。乱数(1,2,3,5,7)とタイミング(1〜1.4)で最大HPの10〜98%
  function powerHeal(f, timing, rng) {
    const r = [1, 2, 3, 5, 7][Math.floor(rng() * 5)];
    const v = (f.maxHp * r * Math.min(1.4, Math.max(1, timing))) / 10;
    return { amount: Math.min(f.maxHp - f.hp, Math.round(v)), r };
  }
  // 消耗品アイテムを使う（1回だけ）
  function useConsumable(f) {
    const c = f.consumable;
    let healed = 0;
    if (c.heal_hp_pct) { healed = Math.min(f.maxHp - f.hp, Math.round(f.maxHp * c.heal_hp_pct / 100)); f.hp += healed; }
    if (c.cure) { f.status.poison = 0; f.status.stun = 0; }
    if (c.heal_mp) f.spCd = 0;
    f.consumable = null;
    return healed;
  }

  const api = {
    ATTRS, ATTR_OF_KEY, affinity, isValidJan, checkDigit, prefixKind, identityKey, kirakiraOf, decode, describeItem, randomCode, barBits,
    MAX_LV, START_LIMIT, LOT_STEP, xpForLevel, levelFromXp, maxLevelOf, statsAt,
    HP_SCALE, SP_COOLDOWN, makeFighter, initiative, hitChance, rollHit, elementMult, calcDamage, specialDamage, tryInflict, startTurn,
    healAmount, powerHeal, useConsumable, fatigue, DATA,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BB = api;
})(typeof window !== 'undefined' ? window : this);
