/* ClipPost 画面の配線。計算は lib.js(ClipPostLib)、ここはDOM・通信だけ。 */
(function () {
  'use strict';
  const L = window.ClipPostLib;
  const CFG = Object.assign({ GOOGLE_CLIENT_ID: '', TAGS_API: '', CLIPSAVER_ORIGIN: 'https://clipsaver.trustsignalbot.workers.dev' }, window.CLIPPOST_CONFIG || {});
  const SCOPE = 'https://www.googleapis.com/auth/youtube.upload openid email';
  const LS_TAGS = 'clippost.tags.v1';
  const LS_PENDING = 'clippost.tags.pending.v1';
  const $ = (id) => document.getElementById(id);

  const state = {
    src: 'file',
    video: null,          // {blob, name, type, size, from}
    previewUrl: '',
    token: null,          // {access, expiresAt} メモリのみ
    email: '',
    mode: 'now',
    savedTags: [],
    tagEditing: false,
    uploading: false,
    uploaded: false,
    pendingUploadAfterLogin: false,
  };

  function setState(el, text, kind) {
    el.textContent = text || '';
    el.classList.remove('ok', 'err', 'warn', 'muted');
    el.classList.add(kind || 'muted');
  }

  // ============ 動画の入れ方 ============
  document.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
    state.src = b.dataset.src;
    document.querySelectorAll('[data-src]').forEach((x) => {
      const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-selected', String(on));
    });
    $('srcFile').hidden = state.src !== 'file';
    $('srcUrl').hidden = state.src !== 'url';
  }));

  function setVideo(blob, name, from) {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.video = { blob, name, type: blob.type || 'video/mp4', size: blob.size, from };
    state.previewUrl = URL.createObjectURL(blob);
    const v = $('preview');
    v.src = state.previewUrl; v.hidden = false;
    state.uploaded = false;
    setState($('videoState'), `${from === 'url' ? 'TikTokから取得' : '選択'}: ${name} (${(blob.size / 1048576).toFixed(1)}MB)`, 'ok');
    refresh();
  }

  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.type && !f.type.startsWith('video/')) {
      setState($('videoState'), `動画ファイルではありません(${f.type})。`, 'err');
      return;
    }
    setVideo(f, f.name, 'file');
  });

  async function fetchFromTikTok() {
    const url = $('urlInput').value.trim();
    const st = $('videoState');
    if (!/^https?:\/\//i.test(url)) { setState(st, 'TikTokのURLを貼ってください。', 'err'); return; }
    const btn = $('urlFetchBtn');
    btn.disabled = true;
    setState(st, 'TikTokの動画を調べています…', 'muted');
    try {
      const res = await fetch(L.absoluteUrl('/api/resolve', CFG.CLIPSAVER_ORIGIN), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      if (res.status === 429) throw new Error('取得の回数制限にかかりました。1分ほど待ってからもう一度押してください。');
      let data = null;
      try { data = await res.json(); } catch (_) { /* 下で扱う */ }
      if (!res.ok || !data || !data.ok) {
        throw new Error('動画の情報を取れませんでした' + (data && data.error ? `: ${data.error}` : ` (HTTP ${res.status})`));
      }
      const play = data.files && data.files.play;
      if (!play) throw new Error('この投稿には取れる動画がありませんでした。');
      setState(st, '動画を取得しています…', 'muted');
      const vres = await fetch(L.absoluteUrl(play, CFG.CLIPSAVER_ORIGIN));
      if (!vres.ok) throw new Error(`動画本体を取れませんでした (HTTP ${vres.status})`);
      const total = Number(vres.headers.get('Content-Length')) || 0;
      let blob;
      if (vres.body && vres.body.getReader) {
        const reader = vres.body.getReader();
        const chunks = []; let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length;
          setState(st, `動画を取得しています… ${(got / 1048576).toFixed(1)}MB${total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : ''}`, 'muted');
        }
        blob = new Blob(chunks, { type: vres.headers.get('Content-Type') || 'video/mp4' });
      } else {
        blob = await vres.blob();
      }
      if (!blob.size) throw new Error('取れた動画が空でした。');
      if (!blob.type || !blob.type.startsWith('video/')) blob = new Blob([blob], { type: 'video/mp4' });
      const item = data.item || {};
      setVideo(blob, `tiktok_${item.id || 'video'}.mp4`, 'url');
      // 説明文は欄が空の時だけ下書きに入れる(上書きしない)
      const desc = String(item.desc || '').trim();
      if (desc) {
        if (!$('titleInput').value.trim()) {
          $('titleInput').value = Array.from(desc.replace(/[<>]/g, '').replace(/\s+/g, ' ')).slice(0, L.TITLE_MAX).join('').trim();
        }
        if (!$('descInput').value.trim()) $('descInput').value = desc;
        refresh();
      }
    } catch (err) {
      setState(st, err && err.message ? err.message : '取得に失敗しました。', 'err');
    } finally {
      btn.disabled = false;
    }
  }
  $('urlFetchBtn').addEventListener('click', fetchFromTikTok);
  $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchFromTikTok(); } });

  // ============ 題名 ============
  $('titleInput').addEventListener('input', () => { state.uploaded = false; refresh(); });
  $('descInput').addEventListener('input', () => { state.uploaded = false; });
  $('hashtagInput').addEventListener('input', () => { state.uploaded = false; });

  // ============ よく使うハッシュタグ ============
  function readLocalTags() {
    try { return L.sanitizeTagList(JSON.parse(localStorage.getItem(LS_TAGS) || '[]')) || []; } catch (_) { return []; }
  }
  function writeLocalTags(list) {
    try {
      localStorage.setItem(LS_TAGS, JSON.stringify(list));
      return localStorage.getItem(LS_TAGS) === JSON.stringify(list);
    } catch (_) { return false; }
  }
  function setPending(on) { try { on ? localStorage.setItem(LS_PENDING, '1') : localStorage.removeItem(LS_PENDING); } catch (_) {} }
  function isPending() { try { return localStorage.getItem(LS_PENDING) === '1'; } catch (_) { return false; } }
  function tagsUrl() { return CFG.TAGS_API ? CFG.TAGS_API.replace(/\/+$/, '') + '/tags' : ''; }

  function renderTags() {
    const box = $('tagChips');
    box.textContent = '';
    state.savedTags.forEach((t) => {
      const chip = document.createElement('span'); chip.className = 'chip';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip-tag'; b.textContent = t;
      b.addEventListener('click', () => insertTag(t));
      chip.appendChild(b);
      if (state.tagEditing) {
        const d = document.createElement('button'); d.type = 'button'; d.className = 'chip-del'; d.textContent = '削除';
        d.setAttribute('aria-label', `${t} を削除`);
        d.addEventListener('click', () => removeTag(t));
        chip.appendChild(d);
      }
      box.appendChild(chip);
    });
    $('tagEmpty').hidden = state.savedTags.length > 0;
  }

  function insertTag(t) {
    const input = $('titleInput');
    const r = L.appendTagToTitle(input.value, t, L.TITLE_MAX);
    if (r.added) {
      input.value = r.title; state.uploaded = false; refresh();
      setState($('tagState'), '', 'muted');
    } else if (r.reason === 'duplicate') {
      setState($('tagState'), `${t} は題名に入っています。`, 'muted');
    } else if (r.reason === 'too_long') {
      setState($('tagState'), `${t} を足すと100字を超えるため貼りませんでした。`, 'warn');
    }
  }

  async function loadTags() {
    const local = readLocalTags();
    state.savedTags = local; renderTags();
    const url = tagsUrl();
    if (!url) { setState($('tagState'), '端末内の一覧を使っています(共有サーバー未設定)。', 'muted'); return; }
    if (isPending()) { setState($('tagState'), '端末内に未送信の変更があります。ログインすると共有へ送ります。', 'warn'); return; }
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = L.sanitizeTagList(await res.json());
      if (!list) throw new Error('形式が違います');
      state.savedTags = list; writeLocalTags(list); renderTags();
      setState($('tagState'), '', 'muted');
    } catch (err) {
      setState($('tagState'), `共有の一覧を読めなかったため、端末内の一覧を表示しています(${err.message})。`, 'warn');
    }
  }

  async function saveTags(list) {
    if (!writeLocalTags(list)) {
      setState($('tagState'), '端末に保存できませんでした(プライベートブラウズ等)。', 'err');
      return;
    }
    state.savedTags = list; renderTags();
    const url = tagsUrl();
    if (!url) { setState($('tagState'), '端末内に保存しました(共有サーバー未設定)。', 'ok'); return; }
    if (!hasToken()) {
      setPending(true);
      setState($('tagState'), '端末内に保存しました。他の端末と共有するにはログインしてください。', 'warn');
      return;
    }
    await pushTags(list);
  }

  async function pushTags(list) {
    try {
      const res = await fetch(tagsUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token.access },
        body: JSON.stringify(list),
      });
      let data = null; try { data = await res.json(); } catch (_) {}
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      setPending(false);
      setState($('tagState'), '共有に保存しました。', 'ok');
    } catch (err) {
      setPending(true);
      setState($('tagState'), `端末内には保存しましたが、共有へ送れませんでした(${err.message})。`, 'warn');
    }
  }

  function addTagsFromInput() {
    const input = $('tagNewInput');
    const next = L.addSavedTags(state.savedTags, input.value);
    if (next.length === state.savedTags.length) {
      setState($('tagState'), L.parseTags(input.value).length ? '登録済みのタグです。' : 'タグを入力してください。', 'muted');
      return;
    }
    input.value = '';
    saveTags(next);
  }
  function removeTag(t) {
    saveTags(state.savedTags.filter((x) => x !== t));
  }
  $('tagAddBtn').addEventListener('click', addTagsFromInput);
  $('tagNewInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTagsFromInput(); } });
  $('tagEditBtn').addEventListener('click', () => {
    state.tagEditing = !state.tagEditing;
    $('tagEditor').hidden = !state.tagEditing;
    $('tagEditBtn').textContent = state.tagEditing ? '編集を終える' : '編集';
    renderTags();
  });

  // ============ 投稿日時ホイール ============
  function makeWheel(el, onChange) {
    let items = []; let index = 0; let timer = 0;
    const itemH = () => (el.querySelector('.wheel-item') || {}).offsetHeight || 44;
    function render(list, keepIndex) {
      items = list;
      el.textContent = '';
      const top = document.createElement('div'); top.className = 'wheel-spacer'; el.appendChild(top);
      list.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'wheel-item'; d.textContent = it.label; d.dataset.i = String(i);
        d.addEventListener('click', () => setIndex(i, true, true));
        el.appendChild(d);
      });
      const bot = document.createElement('div'); bot.className = 'wheel-spacer'; el.appendChild(bot);
      index = Math.max(0, Math.min(list.length - 1, keepIndex || 0));
      mark(); sync();
    }
    function mark() {
      el.querySelectorAll('.wheel-item').forEach((d, i) => d.classList.toggle('is-sel', i === index));
    }
    function sync() { el.scrollTop = index * itemH(); }
    function setIndex(i, smooth, notify) {
      index = Math.max(0, Math.min(items.length - 1, i));
      mark();
      if (smooth && el.scrollTo) el.scrollTo({ top: index * itemH(), behavior: 'smooth' }); else sync();
      if (notify) onChange();
    }
    function settle() {
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / itemH())));
      if (i !== index) { index = i; mark(); onChange(); }
    }
    el.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(settle, 120); }, { passive: true });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(index + 1, true, true); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(index - 1, true, true); }
    });
    return {
      render, sync, setIndex,
      get index() { return index; },
      get value() { return items[index] && items[index].value; },
      findIndex: (pred) => items.findIndex(pred),
      setPast(pred) { el.querySelectorAll('.wheel-item').forEach((d, i) => d.classList.toggle('is-past', !!pred(items[i]))); },
    };
  }

  const wDate = makeWheel(document.querySelector('[data-wheel=date]'), onWheelChange);
  const wHour = makeWheel(document.querySelector('[data-wheel=hour]'), onWheelChange);
  const wMin = makeWheel(document.querySelector('[data-wheel=min]'), onWheelChange);
  let dateKeys = '';

  function buildWheels(initial) {
    const now = Date.now();
    const dates = L.candidateDates(now, 7);
    const keys = dates.map((d) => d.key).join(',');
    if (keys !== dateKeys) {
      const prev = wDate.value;
      dateKeys = keys;
      let idx = prev ? dates.findIndex((d) => d.key === prev.key) : -1;
      if (initial) {
        const s = L.nextSlot(now);
        idx = dates.findIndex((d) => d.y === s.y && d.m === s.m && d.d === s.d);
      }
      wDate.render(dates.map((d) => ({ label: d.label, value: d })), idx < 0 ? 0 : idx);
    }
    if (initial) {
      const s = L.nextSlot(now);
      wHour.render(Array.from({ length: 24 }, (_, h) => ({ label: L.pad2(h), value: h })), s.h);
      wMin.render(L.MINUTE_STEPS.map((m) => ({ label: L.pad2(m), value: m })), L.MINUTE_STEPS.indexOf(s.min));
    }
    updatePast();
  }

  function selected() {
    const d = wDate.value; const h = wHour.value; const m = wMin.value;
    if (!d || h == null || m == null) return null;
    return { y: d.y, m: d.m, d: d.d, h, min: m };
  }

  function updatePast() {
    const now = Date.now();
    const d = wDate.value;
    if (!d) return;
    wHour.setPast((it) => L.isPastJst(d.y, d.m, d.d, it.value, 50, now));
    wMin.setPast((it) => L.isPastJst(d.y, d.m, d.d, wHour.value, it.value, now));
    const s = selected();
    const st = $('scheduleState');
    if (!s) return;
    if (L.isPastJst(s.y, s.m, s.d, s.h, s.min, now)) {
      setState(st, `${L.formatJst(s.y, s.m, s.d, s.h, s.min)} は現在より前です。後の時刻を選んでください。`, 'err');
    } else {
      setState(st, `予約: ${L.formatJst(s.y, s.m, s.d, s.h, s.min)} (日本時間) に公開`, 'ok');
    }
  }
  function onWheelChange() { updatePast(); refresh(); }

  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((x) => {
      const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', String(on));
    });
    $('schedulePane').hidden = state.mode !== 'schedule';
    if (state.mode === 'schedule') {
      buildWheels(false);
      // 非表示の間は scrollTop が効かないので、表示した直後に位置を合わせ直す
      requestAnimationFrame(() => { wDate.sync(); wHour.sync(); wMin.sync(); updatePast(); });
    }
    state.uploaded = false;
    refresh();
  }));
  setInterval(() => { buildWheels(false); refresh(); }, 30000);

  // ============ ログイン(Google Identity Services・トークンはメモリのみ) ============
  let tokenClient = null;
  function hasToken() { return !!(state.token && state.token.expiresAt > Date.now()); }

  function renderAuth() {
    const st = $('authState'); const btn = $('loginBtn');
    if (!CFG.GOOGLE_CLIENT_ID) {
      btn.disabled = true;
      setState(st, 'OAuthクライアントID未設定', 'err');
      const note = $('configNote');
      note.textContent = 'OAuthクライアントID未設定のため、ログインと投稿はまだできません。(config.js の GOOGLE_CLIENT_ID)';
      note.hidden = false;
      return;
    }
    if (hasToken()) {
      setState(st, state.email ? `ログイン中: ${state.email}` : 'ログイン中', 'ok');
      btn.textContent = 'ログインし直す';
    } else {
      setState(st, state.token ? 'ログインが切れました' : '未ログイン', state.token ? 'warn' : 'muted');
      btn.textContent = 'Googleでログイン';
    }
    btn.disabled = !tokenClient;
  }

  function initGis(tries) {
    if (!CFG.GOOGLE_CLIENT_ID) return;
    const g = window.google && window.google.accounts && window.google.accounts.oauth2;
    if (!g) {
      if (tries > 50) { setState($('authState'), 'Googleのログイン部品を読み込めませんでした。', 'err'); return; }
      setTimeout(() => initGis(tries + 1), 200);
      return;
    }
    tokenClient = g.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: onToken,
      error_callback: (err) => {
        state.pendingUploadAfterLogin = false;
        setState($('authState'), `ログインできませんでした(${err && err.type ? err.type : '不明'})`, 'err');
      },
    });
    renderAuth();
  }

  async function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) {
      state.pendingUploadAfterLogin = false;
      setState($('authState'), `ログインできませんでした(${resp && resp.error ? resp.error : '不明'})`, 'err');
      return;
    }
    const granted = window.google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/youtube.upload');
    if (!granted) {
      state.pendingUploadAfterLogin = false;
      setState($('authState'), 'YouTubeへのアップロード許可が付いていません。もう一度ログインして許可してください。', 'err');
      return;
    }
    state.token = { access: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
    state.email = '';
    renderAuth(); refresh();
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + resp.access_token } });
      if (r.ok) { const u = await r.json(); state.email = u.email || ''; renderAuth(); }
    } catch (_) { /* 表示用なので失敗しても続ける */ }
    if (isPending() && tagsUrl()) await pushTags(state.savedTags);
    if (state.pendingUploadAfterLogin) { state.pendingUploadAfterLogin = false; startUpload(); }
  }

  function login() {
    if (!tokenClient) return;
    tokenClient.requestAccessToken({ prompt: hasToken() ? '' : 'consent' });
  }
  $('loginBtn').addEventListener('click', login);
  setInterval(renderAuth, 30000);

  // ============ 投稿 ============
  function blockers() {
    const r = [];
    if (!CFG.GOOGLE_CLIENT_ID) r.push('OAuthクライアントID未設定');
    if (!state.video) r.push('動画を選んでください');
    const te = L.validateTitle($('titleInput').value);
    if (te) r.push(te);
    if (state.mode === 'schedule') {
      const s = selected();
      if (!s || L.isPastJst(s.y, s.m, s.d, s.h, s.min, Date.now())) r.push('予約時刻が現在より前です');
    }
    return r;
  }

  function refresh() {
    const n = L.charCount($('titleInput').value);
    $('titleCount').textContent = String(L.TITLE_MAX - n);
    $('titleCount').parentElement.classList.toggle('over', n > L.TITLE_MAX);
    const b = blockers();
    const btn = $('uploadBtn');
    btn.disabled = state.uploading || state.uploaded || b.length > 0;
    btn.textContent = state.uploading ? '投稿中…' : state.uploaded ? '投稿済み' : state.mode === 'schedule' ? '予約投稿する' : '投稿する';
    if (!state.uploading && !state.uploaded) setState($('uploadState'), b.join(' / '), b.length ? 'muted' : 'muted');
  }

  function apiErrorMessage(status, data) {
    const e = data && data.error;
    const reason = e && e.errors && e.errors[0] && e.errors[0].reason;
    if (status === 401) return 'ログインが切れています。もう一度ログインしてから投稿してください。';
    if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') return `今日の投稿上限に達しました(${reason})。`;
    return `YouTubeが受け付けませんでした (HTTP ${status}${reason ? ' ' + reason : ''}${e && e.message ? ': ' + e.message : ''})`;
  }

  async function startUpload() {
    const b = blockers();
    if (b.length) { setState($('uploadState'), b.join(' / '), 'err'); return; }
    if (!hasToken()) {
      state.pendingUploadAfterLogin = true;
      setState($('uploadState'), 'ログインすると続けて投稿します。', 'muted');
      login();
      return;
    }
    let publishAt = '';
    if (state.mode === 'schedule') {
      const s = selected();
      publishAt = L.jstToUtcIso(s.y, s.m, s.d, s.h, s.min);
    }
    const resource = L.buildVideoResource({
      title: $('titleInput').value, description: $('descInput').value, hashtags: $('hashtagInput').value,
      mode: state.mode, publishAt,
    });
    const video = state.video;
    state.uploading = true; refresh();
    $('result').hidden = true;
    $('progressWrap').hidden = false; $('progressBar').style.width = '0%';
    setState($('uploadState'), 'アップロードの準備をしています…', 'muted');
    try {
      const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + state.token.access,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(video.size),
          'X-Upload-Content-Type': video.type,
        },
        body: JSON.stringify(resource),
      });
      if (!init.ok) {
        let data = null; try { data = await init.json(); } catch (_) {}
        if (init.status === 401) state.token = null;
        throw new Error(apiErrorMessage(init.status, data));
      }
      const location = init.headers.get('Location');
      if (!location) throw new Error('アップロード先のURLを受け取れませんでした。');
      const done = await putVideo(location, video);
      showResult(done, publishAt);
      state.uploaded = true;
      setState($('uploadState'), state.mode === 'schedule' ? '予約投稿しました。' : '投稿しました。', 'ok');
    } catch (err) {
      setState($('uploadState'), err && err.message ? err.message : '投稿に失敗しました。', 'err');
    } finally {
      state.uploading = false;
      renderAuth();
      refresh();
    }
  }

  function putVideo(location, video) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', location);
      xhr.setRequestHeader('Content-Type', video.type);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.floor((e.loaded / e.total) * 100);
        $('progressBar').style.width = pct + '%';
        setState($('uploadState'), `アップロード中… ${pct}% (${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)}MB)`, 'muted');
      };
      xhr.onload = () => {
        let data = null; try { data = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status === 200 || xhr.status === 201) {
          if (data && data.id) resolve(data); else reject(new Error('YouTubeの応答に動画IDがありませんでした。'));
        } else {
          if (xhr.status === 401) state.token = null;
          reject(new Error(apiErrorMessage(xhr.status, data)));
        }
      };
      xhr.onerror = () => reject(new Error('通信が切れました。電波の良い所でもう一度押してください。'));
      xhr.send(video.blob);
    });
  }

  function showResult(data, publishAt) {
    const box = $('result');
    box.textContent = '';
    const url = 'https://youtu.be/' + data.id;
    const line1 = document.createElement('div'); line1.textContent = '動画ID: ' + data.id;
    const line2 = document.createElement('div');
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url;
    line2.appendChild(a);
    box.appendChild(line1); box.appendChild(line2);
    if (publishAt) {
      const p = L.jstParts(Date.parse(publishAt));
      const line3 = document.createElement('div');
      line3.textContent = `公開予定: ${L.formatJst(p.y, p.m, p.d, p.h, p.min)} (日本時間)`;
      box.appendChild(line3);
    }
    box.hidden = false;
  }

  $('uploadBtn').addEventListener('click', startUpload);
  window.addEventListener('beforeunload', (e) => { if (state.uploading) { e.preventDefault(); e.returnValue = ''; } });

  // ============ 起動 ============
  buildWheels(true);
  renderAuth();
  initGis(0);
  loadTags();
  refresh();
})();
