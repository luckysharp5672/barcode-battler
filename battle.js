// 同時入力ターン制の対戦エンジン（画面に依存しない）。シングルバトル：場に1体、選出3体。
// 通信対戦でも同じ結果になるように、乱数は引数 rng で受け取り、結果は「イベントのリスト」として返す。
(function (root) {
  const BB = root.BB || require('./engine.js');

  // ---- スキル ----
  // pri: 優先度（大きいほど先。同じなら DX が高い方が先）  交代は、すべてのスキルより先に処理される
  const SKILLS = {
    attack: { id: 'attack', name: 'たたかう', pri: 0, kind: 'dmg', power: 1.0, desc: '通常攻撃（外れることがある）' },
    quick: { id: 'quick', name: 'クイック', pri: 1, kind: 'dmg', power: 0.6, desc: '先制の弱い一撃（優先度+1）' },
    special: { id: 'special', name: '特殊技', pri: 0, kind: 'sp', desc: '✨の値で攻撃。防御無視・必中。3ターンに1回' },
    guard: { id: 'guard', name: 'ガード', pri: 3, kind: 'guard', desc: 'そのターンの攻撃を防ぐ（優先度+3）。連続では使えない' },
    herb: { id: 'herb', name: '薬草', pri: 0, kind: 'herb', desc: 'HPを20%回復（薬草1個。チームで3個）' },
    power: { id: 'power', name: 'パワーキー', pri: 0, kind: 'power', desc: '薬草1個で、運しだいの大回復（10〜84%）' },
    item: { id: 'item', name: 'アイテム', pri: 0, kind: 'item', desc: '持っている回復薬を使う（1回だけ）' },
  };
  const SKILL_ORDER = ['attack', 'quick', 'special', 'guard', 'herb', 'power', 'item'];
  const ATTACK_TIMING = 2.6; // メーターをなくしたので、攻撃の倍率は固定（平均的なメーターの値）
  const CRIT_RATE = 1 / 16;

  const actOf = (st, s) => st.sides[s].party[st.sides[s].active];
  const alive = (f) => f.hp > 0;
  const benchAlive = (side) => side.party.map((f, i) => i).filter((i) => i !== side.active && alive(side.party[i]));

  function createSide(name, fighters, herbs = 3) {
    return { name, party: fighters, active: 0, herbs, lastGuard: false, usedItems: [] };
  }
  function createBattle(a, b) { return { sides: [a, b], round: 0, over: false, winner: null }; }

  // いま選べるスキル（無効なものには理由つき）
  function availableSkills(st, s) {
    const side = st.sides[s], f = actOf(st, s);
    return SKILL_ORDER.filter((id) => id !== 'item' || f.consumable).map((id) => {
      const sk = SKILLS[id];
      let off = '';
      if (id === 'special' && f.spCd > 0) off = `あと${f.spCd}ターン`;
      if (id === 'guard' && side.lastGuard) off = '連続では使えない';
      if ((id === 'herb' || id === 'power') && side.herbs <= 0) off = '薬草がない';
      if ((id === 'herb' || id === 'power') && f.hp >= f.maxHp) off = 'HPが満タン';
      if (id === 'item' && f.consumable && !(f.consumable.heal_hp_pct && f.hp < f.maxHp) && !f.consumable.cure && !f.consumable.heal_mp) off = '使えない';
      return { ...sk, off };
    });
  }

  // ---- ターンの処理 ----
  // actions[s] = { type: 'skill', skill: id } | { type: 'switch', to: 控えの番号 }
  function resolveTurn(st, actions, rng) {
    const ev = [];
    st.round++;
    const fat = BB.fatigue(st.round);
    const hpEv = (s, extra) => ({ s, idx: st.sides[s].active, hp: actOf(st, s).hp, ...extra });

    // 1. 交代（すべてのスキルより先）
    for (const s of [0, 1]) {
      const a = actions[s];
      if (a.type !== 'switch') continue;
      const side = st.sides[s];
      if (!benchAlive(side).includes(a.to)) continue;
      const from = actOf(st, s);
      side.active = a.to; side.lastGuard = false;
      ev.push({ t: 'switch', s, from: from.name, to: actOf(st, s).name, idx: a.to });
    }

    // 2. スキル：優先度 → DX の順
    const order = [0, 1].filter((s) => actions[s].type === 'skill').map((s) => ({
      s, pri: SKILLS[actions[s].skill].pri, dx: actOf(st, s).dx, r: rng(),
    })).sort((x, y) => y.pri - x.pri || y.dx - x.dx || x.r - y.r);

    // 行動順の記録（画面のタイムライン用）：交代 → 優先度の高いスキル → DX
    ev.unshift({
      t: 'order',
      list: [0, 1].filter((x) => actions[x].type === 'switch' && ev.some((e) => e.t === 'switch' && e.s === x))
        .map((x) => ({ s: x, kind: 'switch', label: '交代' }))
        .concat(order.map((o) => ({ s: o.s, kind: 'skill', label: SKILLS[actions[o.s].skill].name, pri: o.pri, dx: o.dx }))),
    });
    for (const o of order) {
      const s = o.s, side = st.sides[s], u = actOf(st, s), d = actOf(st, 1 - s), sk = SKILLS[actions[s].skill];
      if (!alive(u)) continue;
      if (u.status.stun > 0) { u.status.stun--; ev.push({ t: 'msg', text: `${u.name} は麻痺して動けない！` }); side.lastGuard = false; continue; }
      const avail = availableSkills(st, s).find((x) => x.id === sk.id);
      if (!avail || avail.off) { ev.push({ t: 'msg', text: `${u.name} の ${sk.name}… しかしうまくいかなかった！` }); side.lastGuard = false; continue; }
      ev.push({ t: 'use', s, who: u.name, skill: sk.name });
      if (sk.kind !== 'guard') side.lastGuard = false;

      if (sk.kind === 'guard') {
        u.protect = true; side.lastGuard = true;
        ev.push({ t: 'msg', text: `${u.name} は身を守っている！` });
      } else if (sk.kind === 'dmg' || sk.kind === 'sp') {
        if (!alive(d)) continue;
        if (d.protect) { ev.push({ t: 'msg', text: `${d.name} は攻撃を防いだ！` }); continue; }
        if (sk.kind === 'dmg' && !BB.rollHit(u, d, rng)) { ev.push({ t: 'miss', s }); continue; }
        let dmg, mult, crit = false;
        if (sk.kind === 'sp') {
          ({ dmg, mult } = BB.specialDamage(u, d, ATTACK_TIMING)); u.spCd = BB.SP_COOLDOWN;
        } else {
          ({ dmg, mult } = BB.calcDamage(u, d, ATTACK_TIMING * sk.power, rng));
          if (rng() < CRIT_RATE) { crit = true; dmg = Math.round(dmg * 1.5); }
        }
        dmg = Math.max(1, Math.round(dmg * fat));
        d.hp = Math.max(0, d.hp - dmg);
        ev.push({ t: 'dmg', s: 1 - s, idx: st.sides[1 - s].active, dmg, hp: d.hp, mult, crit });
        if (sk.kind === 'dmg') for (const k of BB.tryInflict(u, d, rng)) ev.push({ t: 'status', s: 1 - s, name: d.name, status: k });
      } else if (sk.kind === 'herb' || sk.kind === 'power') {
        side.herbs--;
        let amount;
        if (sk.kind === 'herb') amount = BB.healAmount(u, 1);
        else amount = BB.powerHeal(u, 1.2, rng).amount;
        u.hp += amount;
        ev.push({ t: 'heal', s, idx: side.active, amount, hp: u.hp, herbs: side.herbs });
      } else if (sk.kind === 'item') {
        const name = u.item.name;
        const healed = BB.useConsumable(u);
        side.usedItems.push(u.item.itemId);
        ev.push({ t: 'heal', s, idx: side.active, amount: healed, hp: u.hp, item: name });
      }
    }

    // 3. ターンの終わり：毒・ガードの解除・特殊技の待ち時間
    for (const s of [0, 1]) {
      const f = actOf(st, s);
      f.protect = false;
      if (alive(f) && f.status.poison > 0) {
        const p = Math.max(1, Math.round(f.maxHp * 0.06));
        f.hp = Math.max(0, f.hp - p); f.status.poison--;
        ev.push({ t: 'poison', s, idx: st.sides[s].active, dmg: p, hp: f.hp, name: f.name });
      }
    }
    // 特殊技の待ち時間：使うと3、ターンの終わりごとに1ずつ減る（全員）
    for (const side of st.sides) for (const f of side.party) if (f.spCd > 0) f.spCd--;

    // 4. ひんし・勝敗
    for (const s of [0, 1]) {
      const f = actOf(st, s);
      if (!alive(f)) ev.push({ t: 'faint', s, idx: st.sides[s].active, name: f.name });
    }
    const left = [0, 1].map((s) => st.sides[s].party.some(alive));
    if (!left[0] || !left[1]) {
      st.over = true;
      st.winner = left[0] ? 0 : left[1] ? 1 : -1; // -1 = 引き分け
    }
    return ev;
  }

  // ひんしの次に出すキャラが必要な側
  const needReplace = (st) => (st.over ? [] : [0, 1].filter((s) => !alive(actOf(st, s)) && benchAlive(st.sides[s]).length));
  function replaceActive(st, s, to) {
    const side = st.sides[s];
    if (!benchAlive(side).includes(to)) return null;
    side.active = to; side.lastGuard = false;
    return { t: 'switch', s, from: '', to: actOf(st, s).name, idx: to };
  }

  // ---- CPU ----
  function expectedDamage(u, d, sk) {
    const mid = () => 0.5;
    if (sk === 'special') return BB.specialDamage(u, d, ATTACK_TIMING).dmg;
    return BB.calcDamage(u, d, ATTACK_TIMING * SKILLS[sk].power, mid).dmg * BB.hitChance(u, d);
  }
  function cpuAction(st, s, rng) {
    const side = st.sides[s], u = actOf(st, s), d = actOf(st, 1 - s);
    const av = availableSkills(st, s).filter((x) => !x.off).map((x) => x.id);
    const bench = benchAlive(side);
    // 倒せるなら、優先度の高い技で確実に
    if (av.includes('quick') && expectedDamage(u, d, 'quick') >= d.hp) return { type: 'skill', skill: 'quick' };
    // 相性が悪ければ、控えと交代することがある
    const bad = BB.affinity(d.attr, u.bodyAttr) > 1 && BB.affinity(u.atkAttr, d.attr) < 1;
    if (bad && bench.length && rng() < 0.4) {
      const best = bench.map((i) => ({ i, sc: BB.affinity(side.party[i].atkAttr, d.attr) - BB.affinity(d.attr, side.party[i].bodyAttr) + side.party[i].hp / side.party[i].maxHp }))
        .sort((a, b) => b.sc - a.sc)[0];
      return { type: 'switch', to: best.i };
    }
    if (u.hp < u.maxHp * 0.35) {
      if (av.includes('item') && rng() < 0.7) return { type: 'skill', skill: 'item' };
      if (av.includes('power') && rng() < 0.3) return { type: 'skill', skill: 'power' };
      if (av.includes('herb') && rng() < 0.55) return { type: 'skill', skill: 'herb' };
    }
    if (av.includes('guard') && rng() < 0.12) return { type: 'skill', skill: 'guard' };
    if (av.includes('special') && rng() < 0.55) return { type: 'skill', skill: 'special' };
    return { type: 'skill', skill: 'attack' };
  }
  // CPUの選出：相手の6体に対して相性がよく、レベルの高い順に n 体。先頭が先発
  function cpuSelect(myParty, foeParty, n) {
    const score = (f) => f.level + 12 * foeParty.reduce((a, p) => a + BB.affinity(f.atkAttr, p.attr) - BB.affinity(p.attr, f.bodyAttr), 0) / foeParty.length;
    return myParty.map((f, i) => ({ i, sc: score(f) })).sort((a, b) => b.sc - a.sc).slice(0, n).map((x) => x.i);
  }
  // CPUの代わりのキャラ
  function cpuReplace(st, s) {
    const side = st.sides[s], d = actOf(st, 1 - s);
    return benchAlive(side).map((i) => ({ i, sc: BB.affinity(side.party[i].atkAttr, d.attr) - BB.affinity(d.attr, side.party[i].bodyAttr) + side.party[i].level / 100 }))
      .sort((a, b) => b.sc - a.sc)[0].i;
  }
  // CPUのパーティ（6体。同じキャラは1体まで。持ち物は重ならない）
  function generateCpuParty(avgLv, rng, size = 6, itemRate = 0.5) {
    const party = [], idxs = new Set(), items = new Set();
    let guard = 0;
    while (party.length < size && guard++ < 500) {
      let dec = BB.decode(BB.randomCode('char', rng));
      // 強いステージでは、そのレベルまで育てられるキャラ（限界レベルが足りるもの）だけを選ぶ
      for (let k = 0; k < 40 && dec.limit < avgLv - 2; k++) dec = BB.decode(BB.randomCode('char', rng));
      if (idxs.has(dec.idx)) continue;
      idxs.add(dec.idx);
      let it = null;
      if (rng() < itemRate) {
        const cand = BB.itemById(BB.DATA.items[Math.floor(rng() * BB.DATA.items.length)].id);
        if (!items.has(cand.itemId)) { items.add(cand.itemId); it = cand; }
      }
      const lv = Math.max(1, Math.min(dec.limit, Math.round(avgLv - 2 + rng() * 5)));
      party.push(BB.makeFighter(dec, it, lv));
    }
    return party;
  }

  const api = {
    SKILLS, SKILL_ORDER, ATTACK_TIMING, createSide, createBattle, availableSkills, resolveTurn, needReplace, replaceActive,
    cpuAction, cpuSelect, cpuReplace, generateCpuParty, actOf, benchAlive, alive,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Battle = api;
})(typeof window !== 'undefined' ? window : this);
