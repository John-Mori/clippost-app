/* ClipPost 純関数(時刻計算・ハッシュタグ・メタデータ組み立て)
 * ブラウザでは window.ClipPostLib、node では module.exports として使う。
 * DOM・ネットワークには触らない(テストで直接実行するため)。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.ClipPostLib = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // 日本はサマータイム無し=常に+9時間
  const MINUTE_STEPS = [0, 10, 20, 30, 40, 50];
  const TITLE_MAX = 100;
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** UTCミリ秒 → JSTの暦の部品 {y,m,d,h,min,wd} */
  function jstParts(utcMs) {
    const t = new Date(utcMs + JST_OFFSET_MS);
    return {
      y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
      h: t.getUTCHours(), min: t.getUTCMinutes(), wd: t.getUTCDay(),
    };
  }

  /** JSTの日時 → UTCミリ秒 */
  function jstToUtcMs(y, m, d, h, min) {
    return Date.UTC(y, m - 1, d, h, min, 0, 0) - JST_OFFSET_MS;
  }

  /** JSTの日時 → UTCのISO8601(秒まで・末尾Z)。例 2026-11-10 23:50 → 2026-11-10T14:50:00Z */
  function jstToUtcIso(y, m, d, h, min) {
    return new Date(jstToUtcMs(y, m, d, h, min)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** 予約の候補日付: JSTの今日から days 日後まで(既定7日後=8件) */
  function candidateDates(nowMs, days) {
    const n = days == null ? 7 : days;
    const today = jstParts(nowMs);
    const base = Date.UTC(today.y, today.m - 1, today.d);
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = new Date(base + i * 86400000);
      const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
      const wd = WEEKDAYS[t.getUTCDay()];
      const rel = i === 0 ? '今日 ' : i === 1 ? '明日 ' : '';
      out.push({ y, m, d, key: `${y}-${pad2(m)}-${pad2(d)}`, label: `${rel}${m}/${d}(${wd})` });
    }
    return out;
  }

  /** 指定のJST日時が現在(nowMs)以前なら true。marginMin 分の余裕を求める時は正の数を渡す */
  function isPastJst(y, m, d, h, min, nowMs, marginMin) {
    return jstToUtcMs(y, m, d, h, min) <= nowMs + (marginMin || 0) * 60000;
  }

  /** 今より後で最初の10分刻みの枠(JST)。日付をまたぐ場合も正しく繰り上がる */
  function nextSlot(nowMs) {
    const step = 10 * 60000;
    const next = Math.floor(nowMs / step) * step + step;
    const p = jstParts(next);
    return { y: p.y, m: p.m, d: p.d, h: p.h, min: p.min };
  }

  /** JST日時を画面用の文字へ */
  function formatJst(y, m, d, h, min) {
    const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${y}/${m}/${d}(${wd}) ${pad2(h)}:${pad2(min)}`;
  }

  // ---------- ハッシュタグ ----------

  /** 1語をハッシュタグの形へ。空白は除き、先頭の#(全角含む)を1つにそろえる。空なら '' */
  function normalizeTag(s) {
    const body = String(s == null ? '' : s).replace(/[\s　#＃]+/g, '');
    return body ? '#' + body : '';
  }

  /** 入力欄の文字(空白・読点・カンマ区切り)→ 重複なしのタグ配列 */
  function parseTags(s) {
    const out = [];
    String(s == null ? '' : s).split(/[\s　,、，]+|(?=[#＃])/).forEach((w) => {
      const t = normalizeTag(w);
      if (t && t !== '#' && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    });
    return out;
  }

  /** 文字数(サロゲートペアを1字と数える) */
  function charCount(s) { return Array.from(String(s == null ? '' : s)).length; }

  /** 文字列の中にタグが「語として」既にあるか(大文字小文字は区別しない) */
  function hasTag(text, tag) {
    const t = normalizeTag(tag).toLowerCase();
    if (!t) return false;
    return String(text || '').split(/[\s　]+/).some((w) => w.toLowerCase() === t);
  }

  /** タイトル末尾へタグを貼る。空白1つで区切り、既にあれば足さない。上限超えなら足さない。
   *  戻り値 {title, added, reason} reason: 'ok' | 'duplicate' | 'empty' | 'too_long' */
  function appendTagToTitle(title, tag, maxLen) {
    const max = maxLen == null ? TITLE_MAX : maxLen;
    const t = normalizeTag(tag);
    const cur = String(title == null ? '' : title);
    if (!t) return { title: cur, added: false, reason: 'empty' };
    if (hasTag(cur, t)) return { title: cur, added: false, reason: 'duplicate' };
    const trimmed = cur.replace(/[\s　]+$/, '');
    const next = trimmed ? `${trimmed} ${t}` : t;
    if (charCount(next) > max) return { title: cur, added: false, reason: 'too_long' };
    return { title: next, added: true, reason: 'ok' };
  }

  /** 登録済みタグの一覧へ追加(重複なし)。新しい配列を返す */
  function addSavedTags(list, input) {
    const out = Array.isArray(list) ? list.slice() : [];
    parseTags(input).forEach((t) => {
      if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    });
    return out;
  }

  /** 保存されたタグ配列の検査(Workerと共通の形)。不正なら null */
  function sanitizeTagList(v) {
    if (!Array.isArray(v)) return null;
    const out = [];
    for (const x of v) {
      if (typeof x !== 'string') return null;
      const t = normalizeTag(x);
      if (!t || charCount(t) > 100) return null;
      if (!out.some((y) => y.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out.length > 200 ? null : out;
  }

  // ---------- 投稿メタデータ ----------

  /** タイトルの検査。YouTubeは < > を受け付けない */
  function validateTitle(title) {
    const s = String(title || '').trim();
    if (!s) return '題名が空です';
    if (charCount(s) > TITLE_MAX) return `題名が${TITLE_MAX}字を超えています`;
    if (/[<>]/.test(s)) return '題名に < と > は使えません';
    return '';
  }

  /** YouTube Data API v3 videos.insert の本文。
   *  ハッシュタグ欄の内容は説明欄の末尾へ付け、#を外した語を snippet.tags にも入れる。 */
  function buildVideoResource(opts) {
    const title = String(opts.title || '').trim();
    const tags = parseTags(opts.hashtags || '');
    let description = String(opts.description || '').replace(/\s+$/, '');
    const missing = tags.filter((t) => !hasTag(description, t));
    if (missing.length) description = (description ? description + '\n\n' : '') + missing.join(' ');
    const snippet = { title, description, categoryId: '22' };
    if (tags.length) snippet.tags = tags.map((t) => t.slice(1));
    const status = {};
    if (opts.mode === 'schedule') {
      status.privacyStatus = 'private';
      status.publishAt = opts.publishAt;
    } else {
      status.privacyStatus = 'public';
    }
    return { snippet, status };
  }

  /** clipsaver の相対パスを絶対URLへ */
  function absoluteUrl(path, origin) {
    return new URL(path, origin).href;
  }

  return {
    JST_OFFSET_MS, MINUTE_STEPS, TITLE_MAX, pad2,
    jstParts, jstToUtcMs, jstToUtcIso, candidateDates, isPastJst, nextSlot, formatJst,
    normalizeTag, parseTags, charCount, hasTag, appendTagToTitle, addSavedTags, sanitizeTagList,
    validateTitle, buildVideoResource, absoluteUrl,
  };
});
