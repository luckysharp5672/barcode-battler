// マルチバトルのエンジン（画面に依存しない）。場に2体、選出4体（控え2体）。
// シングル用の battle.js のスキル・ダメージ計算をそのまま使い、「場に2体」「攻撃の相手をえらぶ」だけを足したもの。
// 乱数は引数 rng で受け取り、結果は「イベントのリスト」として返す。
(function (root) {
  const BB = root.BB || require('./engine.js');
  const Battle = root.Battle || require('./battle.js');
  const { SKILLS, SKILL_ORDER, ATTACK_TIMING } = Battle;
  const CRIT_RATE = 1 / 16;
  const alive = (f) => f.hp > 0;
  const SLOTS = [0, 1];
  const TARGETED = new Set(['dmg', 'sp']);       // 相手をえらぶスキル

  const fighterAt = (st, s, slot) => st.sides[s].party[st.sides[s].field[slot]];
  const idxAt = (st, s, slot) => st.sides[s].field[slot];
  const onField = (side) => side.field;
  // 控え（場に出ていなくて、たおれていない）
  const benchAlive = (side) => side.party.map((f, i) => i).filter((i) => !side.field.includes(i) && alive(side.party[i]));
  const needsTarget = (skillId) => TARGETED.has(SKILLS[skillId].kind);

  function createSide(name, fighters, herbs = 3) {
    return { name, party: fighters, field: [0, 1], herbs, usedItems: [] };
  }
  function createBattle(a, b) { return { sides: [a, b], round: 0, over: false, winner: null }; }
  // 行動できる（場にいて、たおれていない）スロット
  const liveSlots = (st, s) => SLOTS.filter((k) => alive(fighterAt(st, s, k)));

  // いま選べるスキル（無効なものには理由つき）
  function availableSkills(st, s, slot) {
    const side = st.sides[s], f = fighterAt(st, s, slot);
    return SKILL_ORDER.filter((id) => id !== 'item' || f.consumable).map((id) => {
      const sk = SKILLS[id];
      let off = '';
      if (id === 'special' && f.spCd > 0) off = `あと${f.spCd}ターン`;
      if (id === 'guard' && f.lastGuard) off = '連続では使えない';
      if ((id === 'herb' || id === 'power') && side.herbs <= 0) off = 'やくそうがない';
      if ((id === 'herb' || id === 'power') && f.hp >= f.maxHp) off = 'HPが満タン';
      if (id === 'item' && f.consumable && !(f.consumable.heal_hp_pct && f.hp < f.maxHp) && !f.consumable.cure && !f.consumable.heal_mp) off = '使えない';
      return { ...sk, off };
    });
  }

  // ---- ターンの処理 ----
  // actions[s][slot] = { type:'skill', skill, target(相手のスロット 0/1) } | { type:'switch', to: 控えの番号 }（たおれたスロットは undefined）
  function resolveTurn(st, actions, rng) {
    const ev = [];
    st.round++;
    const fat = BB.fatigue(st.round);

    // 1. 交代（すべてのスキルより先）
    const switched = [];
    for (const s of [0, 1]) for (const k of SLOTS) {
      const a = actions[s][k];
      if (!a || a.type !== 'switch') continue;
      const side = st.sides[s];
      if (!alive(fighterAt(st, s, k)) || !benchAlive(side).includes(a.to)) continue;
      const from = fighterAt(st, s, k);
      side.field[k] = a.to; fighterAt(st, s, k).lastGuard = false;
      switched.push({ s, k });
      ev.push({ t: 'switch', s, slot: k, from: from.name, to: fighterAt(st, s, k).name, idx: a.to });
    }

    // 2. スキル：優先度 → DX の順
    const order = [];
    for (const s of [0, 1]) for (const k of SLOTS) {
      const a = actions[s][k];
      if (!a || a.type !== 'skill' || switched.some((x) => x.s === s && x.k === k)) continue;
      const u = fighterAt(st, s, k); if (!alive(u)) continue;
      order.push({ s, k, a, pri: SKILLS[a.skill].pri, dx: u.dx, r: rng() });
    }
    order.sort((x, y) => y.pri - x.pri || y.dx - x.dx || x.r - y.r);
    ev.unshift({
      t: 'order',
      list: switched.map((x) => ({ s: x.s, slot: x.k, kind: 'switch', label: '交代', name: fighterAt(st, x.s, x.k).name }))
        .concat(order.map((o) => ({ s: o.s, slot: o.k, kind: 'skill', label: SKILLS[o.a.skill].name, pri: o.pri, dx: o.dx, name: fighterAt(st, o.s, o.k).name }))),
    });

    for (const o of order) {
      const s = o.s, k = o.k, side = st.sides[s], u = fighterAt(st, s, k), sk = SKILLS[o.a.skill];
      if (!alive(u)) continue;
      if (u.status.stun > 0) { u.status.stun--; ev.push({ t: 'msg', text: `${u.name} は麻痺して動けない！` }); u.lastGuard = false; continue; }
      const avail = availableSkills(st, s, k).find((x) => x.id === sk.id);
      if (!avail || avail.off) { ev.push({ t: 'msg', text: `${u.name} の ${sk.name}… しかしうまくいかなかった！` }); u.lastGuard = false; continue; }
      ev.push({ t: 'use', s, slot: k, who: u.name, skill: sk.name });
      if (sk.kind !== 'guard') u.lastGuard = false;

      if (sk.kind === 'guard') {
        u.protect = true; u.lastGuard = true;
        ev.push({ t: 'msg', text: `${u.name} は身を守っている！` });
      } else if (sk.kind === 'dmg' || sk.kind === 'sp') {
        // 相手をえらぶ。えらんだ相手がたおれていたら、もう1体へ
        let ts = o.a.target === 1 ? 1 : 0;
        if (!alive(fighterAt(st, 1 - s, ts))) ts = 1 - ts;
        const d = fighterAt(st, 1 - s, ts);
        if (!alive(d)) continue;
        if (d.protect) { ev.push({ t: 'msg', text: `${d.name} は攻撃を防いだ！` }); continue; }
        if (sk.kind === 'dmg' && !BB.rollHit(u, d, rng)) { ev.push({ t: 'miss', s, slot: k }); continue; }
        let dmg, mult, crit = false;
        if (sk.kind === 'sp') {
          ({ dmg, mult } = BB.specialDamage(u, d, ATTACK_TIMING)); u.spCd = BB.SP_COOLDOWN;
        } else {
          ({ dmg, mult } = BB.calcDamage(u, d, ATTACK_TIMING * sk.power, rng));
          if (rng() < CRIT_RATE) { crit = true; dmg = Math.round(dmg * 1.5); }
        }
        dmg = Math.max(1, Math.round(dmg * fat));
        d.hp = Math.max(0, d.hp - dmg);
        ev.push({ t: 'dmg', s: 1 - s, slot: ts, idx: idxAt(st, 1 - s, ts), dmg, hp: d.hp, mult, crit, name: d.name });
        if (sk.kind === 'dmg') for (const key of BB.tryInflict(u, d, rng)) ev.push({ t: 'status', s: 1 - s, slot: ts, name: d.name, status: key });
        if (!alive(d)) ev.push({ t: 'faint', s: 1 - s, slot: ts, idx: idxAt(st, 1 - s, ts), name: d.name });
      } else if (sk.kind === 'herb' || sk.kind === 'power') {
        side.herbs--;
        const amount = sk.kind === 'herb' ? BB.healAmount(u, 1) : BB.powerHeal(u, 1.2, rng).amount;
        u.hp += amount;
        ev.push({ t: 'heal', s, slot: k, idx: idxAt(st, s, k), amount, hp: u.hp, herbs: side.herbs });
      } else if (sk.kind === 'item') {
        const name = u.item.name;
        const healed = BB.useConsumable(u);
        side.usedItems.push(u.item.itemId);
        ev.push({ t: 'heal', s, slot: k, idx: idxAt(st, s, k), amount: healed, hp: u.hp, item: name });
      }
    }

    // 3. ターンの終わり：ガードの解除・毒・特殊技の待ち時間
    for (const s of [0, 1]) for (const k of SLOTS) {
      const f = fighterAt(st, s, k);
      f.protect = false;
      if (alive(f) && f.status.poison > 0) {
        const p = Math.max(1, Math.round(f.maxHp * 0.06));
        f.hp = Math.max(0, f.hp - p); f.status.poison--;
        ev.push({ t: 'poison', s, slot: k, idx: idxAt(st, s, k), dmg: p, hp: f.hp, name: f.name });
        if (!alive(f)) ev.push({ t: 'faint', s, slot: k, idx: idxAt(st, s, k), name: f.name });
      }
    }
    for (const side of st.sides) for (const f of side.party) if (f.spCd > 0) f.spCd--;

    // 4. 勝敗：どちらかの全員がたおれたら終わり
    const left = [0, 1].map((s) => st.sides[s].party.some(alive));
    if (!left[0] || !left[1]) { st.over = true; st.winner = left[0] ? 0 : left[1] ? 1 : -1; }
    return ev;
  }

  // たおれたスロットのうち、控えから出せる人がいるもの
  function needReplace(st) {
    if (st.over) return [];
    const out = [];
    for (const s of [0, 1]) {
      const free = benchAlive(st.sides[s]).length;
      let n = 0;
      for (const k of SLOTS) if (!alive(fighterAt(st, s, k)) && n < free) { out.push({ s, slot: k }); n++; }
    }
    return out;
  }
  function replaceSlot(st, s, slot, to) {
    const side = st.sides[s];
    if (!benchAlive(side).includes(to)) return null;
    side.field[slot] = to; side.party[to].lastGuard = false;
    return { t: 'switch', s, slot, from: '', to: side.party[to].name, idx: to };
  }

  // ---- CPU ----
  function expectedDamage(u, d, skill) {
    if (skill === 'special') return BB.specialDamage(u, d, ATTACK_TIMING).dmg;
    return BB.calcDamage(u, d, ATTACK_TIMING * SKILLS[skill].power, () => 0.5).dmg * BB.hitChance(u, d);
  }
  // 攻撃の相手：倒せる相手を優先。なければ、相性と与えるダメージが大きい相手（ときどきランダム）
  function cpuTarget(st, s, u, skill, rng) {
    const foes = liveSlots(st, 1 - s);
    if (foes.length === 1) return foes[0];
    if (rng() < 0.2) return foes[Math.floor(rng() * foes.length)];
    const sc = foes.map((k) => {
      const d = fighterAt(st, 1 - s, k), dmg = expectedDamage(u, d, skill);
      return { k, v: (dmg >= d.hp ? 1000 : 0) + dmg / Math.max(1, d.hp) * 100 };
    }).sort((a, b) => b.v - a.v);
    return sc[0].k;
  }
  function cpuActionSlot(st, s, slot, rng, taken) {
    const side = st.sides[s], u = fighterAt(st, s, slot);
    const av = availableSkills(st, s, slot).filter((x) => !x.off).map((x) => x.id);
    const bench = benchAlive(side).filter((i) => !taken.has(i));
    const foes = liveSlots(st, 1 - s).map((k) => fighterAt(st, 1 - s, k));
    const atk = (skill) => ({ type: 'skill', skill, target: cpuTarget(st, s, u, skill, rng) });
    const kill = foes.some((d) => av.includes('quick') && expectedDamage(u, d, 'quick') >= d.hp);
    if (kill) { const a = atk('quick'); if (expectedDamage(u, fighterAt(st, 1 - s, a.target), 'quick') >= fighterAt(st, 1 - s, a.target).hp) return a; }
    // 場の相手2体のどちらにも相性が悪ければ、ときどき交代
    const bad = foes.every((d) => BB.affinity(d.attr, u.bodyAttr) > 1 && BB.affinity(u.atkAttr, d.attr) < 1);
    if (bad && bench.length && rng() < 0.35) {
      const best = bench.map((i) => ({ i, sc: foes.reduce((a, d) => a + BB.affinity(side.party[i].atkAttr, d.attr) - BB.affinity(d.attr, side.party[i].bodyAttr), 0) + side.party[i].hp / side.party[i].maxHp }))
        .sort((a, b) => b.sc - a.sc)[0];
      taken.add(best.i);
      return { type: 'switch', to: best.i };
    }
    if (u.hp < u.maxHp * 0.35) {
      if (av.includes('item') && rng() < 0.7) return { type: 'skill', skill: 'item' };
      if (av.includes('power') && rng() < 0.3) return { type: 'skill', skill: 'power' };
      if (av.includes('herb') && rng() < 0.55) return { type: 'skill', skill: 'herb' };
    }
    if (av.includes('guard') && rng() < 0.12) return { type: 'skill', skill: 'guard' };
    if (av.includes('special') && rng() < 0.55) return atk('special');
    return atk('attack');
  }
  // CPU側のすべての行動
  function cpuActions(st, s, rng) {
    const taken = new Set(), out = [];
    for (const k of SLOTS) out[k] = alive(fighterAt(st, s, k)) ? cpuActionSlot(st, s, k, rng, taken) : undefined;
    return out;
  }
  // CPUの代わりのキャラ：場にいる相手2体への相性がよい人
  function cpuReplace(st, s) {
    const side = st.sides[s], foes = liveSlots(st, 1 - s).map((k) => fighterAt(st, 1 - s, k));
    return benchAlive(side).map((i) => ({ i, sc: foes.reduce((a, d) => a + BB.affinity(side.party[i].atkAttr, d.attr) - BB.affinity(d.attr, side.party[i].bodyAttr), 0) + side.party[i].level / 100 }))
      .sort((a, b) => b.sc - a.sc)[0].i;
  }

  const api = { createSide, createBattle, availableSkills, resolveTurn, needReplace, replaceSlot, cpuActions, cpuReplace, fighterAt, idxAt, benchAlive, liveSlots, needsTarget, alive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Multi = api;
})(typeof window !== 'undefined' ? window : this);
