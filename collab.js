// コラボキャラの読み込み。collab.bin は「合言葉」で暗号化されていて、合言葉を知らない人には読めない。
// 合言葉は、いちど正しく入れるとこの端末に覚えておく（localStorage）。
(function (root) {
  const KEY = 'bb-collab-key', ITER = 200000;
  async function decrypt(buf, pass) {
    const b = new Uint8Array(buf), salt = b.slice(0, 16), iv = b.slice(16, 28), ct = b.slice(28);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)));
  }
  // 戻り値：'ok' | 'wrong'（合言葉がちがう）| 'missing'（ファイルがない）| 'error'
  async function unlock(pass) {
    if (!pass || !root.crypto || !crypto.subtle) return 'error';
    let buf;
    try {
      const r = await fetch('collab.bin', { cache: 'no-cache' });
      if (!r.ok) return 'missing';
      buf = await r.arrayBuffer();
    } catch (e) { return 'error'; }
    try {
      root.BB.setCollab(await decrypt(buf, pass));
    } catch (e) { return 'wrong'; }
    try { localStorage.setItem(KEY, pass); } catch (e) { /* 覚えられなくても使える */ }
    return 'ok';
  }
  async function tryStored() {
    let pass = '';
    try { pass = localStorage.getItem(KEY) || ''; } catch (e) { /* なし */ }
    return pass ? unlock(pass) : 'none';
  }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) { /* なし */ } }
  root.Collab = { unlock, tryStored, forget };
})(window);
