// node app/test/lib.test.js で実行(依存なし)
'use strict';
const assert = require('node:assert/strict');
const L = require('../lib.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
const utc = (s) => Date.parse(s);

// ---- JST → UTC ----
t('JST 2026-11-10 23:50 → 2026-11-10T14:50:00Z', () => assert.equal(L.jstToUtcIso(2026, 11, 10, 23, 50), '2026-11-10T14:50:00Z'));
t('JST 2026-11-11 00:00 → 前日 15:00Z', () => assert.equal(L.jstToUtcIso(2026, 11, 11, 0, 0), '2026-11-10T15:00:00Z'));
t('JST 2026-11-11 08:50 → 前日 23:50Z', () => assert.equal(L.jstToUtcIso(2026, 11, 11, 8, 50), '2026-11-10T23:50:00Z'));
t('JST 2027-01-01 05:00 → 年またぎ 2026-12-31T20:00:00Z', () => assert.equal(L.jstToUtcIso(2027, 1, 1, 5, 0), '2026-12-31T20:00:00Z'));
t('JST 2028-03-01 03:10 → うるう日 2028-02-29T18:10:00Z', () => assert.equal(L.jstToUtcIso(2028, 3, 1, 3, 10), '2028-02-29T18:10:00Z'));
t('jstParts は UTC 15:00 を翌日0時と読む', () => {
  const p = L.jstParts(utc('2026-11-10T15:00:00Z'));
  assert.deepEqual([p.y, p.m, p.d, p.h, p.min], [2026, 11, 11, 0, 0]);
});

// ---- 候補日付 ----
t('候補日付は今日から7日後まで8件(JST基準)', () => {
  const ds = L.candidateDates(utc('2026-11-10T03:00:00Z'), 7); // JST 11/10 12:00
  assert.equal(ds.length, 8);
  assert.equal(ds[0].key, '2026-11-10');
  assert.equal(ds[7].key, '2026-11-17');
  assert.equal(ds[0].label, '今日 11/10(火)');
  assert.equal(ds[1].label, '明日 11/11(水)');
});
t('UTCではまだ前日でもJSTで日付が変わっていれば翌日を今日にする', () => {
  const ds = L.candidateDates(utc('2026-11-10T15:30:00Z'), 7); // JST 11/11 00:30
  assert.equal(ds[0].key, '2026-11-11');
});
t('候補日付は月末をまたぐ', () => {
  const ds = L.candidateDates(utc('2026-11-27T00:00:00Z'), 7);
  assert.deepEqual(ds.map((d) => d.key).slice(-4), ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']);
});

// ---- 過去判定 ----
const now = utc('2026-11-10T14:45:00Z'); // JST 23:45
t('JST 23:40 は過去', () => assert.equal(L.isPastJst(2026, 11, 10, 23, 40, now), true));
t('JST 23:45 ちょうどは過去扱い', () => assert.equal(L.isPastJst(2026, 11, 10, 23, 45, now), true));
t('JST 23:50 は未来', () => assert.equal(L.isPastJst(2026, 11, 10, 23, 50, now), false));
t('翌日 00:00 は未来', () => assert.equal(L.isPastJst(2026, 11, 11, 0, 0, now), false));
t('余裕10分なら 23:50 は過去扱い', () => assert.equal(L.isPastJst(2026, 11, 10, 23, 50, now, 10), true));
t('次の枠: JST 23:45 → 23:50', () => assert.deepEqual(L.nextSlot(now), { y: 2026, m: 11, d: 10, h: 23, min: 50 }));
t('次の枠: JST 23:55 → 翌日 00:00', () => assert.deepEqual(L.nextSlot(utc('2026-11-10T14:55:00Z')), { y: 2026, m: 11, d: 11, h: 0, min: 0 }));
t('次の枠: JST 10:20ちょうど → 10:30', () => assert.deepEqual(L.nextSlot(utc('2026-11-10T01:20:00Z')), { y: 2026, m: 11, d: 10, h: 10, min: 30 }));
t('表示はJST', () => assert.equal(L.formatJst(2026, 11, 10, 9, 0), '2026/11/10(火) 09:00'));

// ---- ハッシュタグ ----
t('normalizeTag: #を補い空白を除く', () => {
  assert.equal(L.normalizeTag('vtuber'), '#vtuber');
  assert.equal(L.normalizeTag('  #推し 活 '), '#推し活');
  assert.equal(L.normalizeTag('＃ホロライブ'), '#ホロライブ');
  assert.equal(L.normalizeTag('##a'), '#a');
  assert.equal(L.normalizeTag('   '), '');
  assert.equal(L.normalizeTag('#'), '');
});
t('parseTags: 区切りと重複', () => {
  assert.deepEqual(L.parseTags('#a b、c, #A　d#e'), ['#a', '#b', '#c', '#d', '#e']);
});
t('appendTag: 空の題名へ', () => assert.deepEqual(L.appendTagToTitle('', 'shorts'), { title: '#shorts', added: true, reason: 'ok' }));
t('appendTag: 空白1つで末尾へ', () => assert.equal(L.appendTagToTitle('題名', '#shorts').title, '題名 #shorts'));
t('appendTag: 末尾の空白を詰めてから足す', () => assert.equal(L.appendTagToTitle('題名   ', '#shorts').title, '題名 #shorts'));
t('appendTag: 全角空白も詰める', () => assert.equal(L.appendTagToTitle('題名　', '#a').title, '題名 #a'));
t('appendTag: 重複は足さない(大文字小文字無視)', () => {
  const r = L.appendTagToTitle('題名 #Shorts もっと', '#shorts');
  assert.equal(r.added, false); assert.equal(r.reason, 'duplicate'); assert.equal(r.title, '題名 #Shorts もっと');
});
t('appendTag: 句読点で区切られた既存タグも重複にしない', () => {
  const r = L.appendTagToTitle('題名 #Shorts, #news。', '#shorts');
  assert.equal(r.added, false); assert.equal(r.reason, 'duplicate');
});
t('appendTag: 前方一致は重複にしない(#shortsと#shortsfan)', () => {
  assert.equal(L.appendTagToTitle('題名 #shortsfan', '#shorts').title, '題名 #shortsfan #shorts');
});
t('appendTag: 100字を超えるなら足さない', () => {
  const r = L.appendTagToTitle('あ'.repeat(95), '#abcde');
  assert.equal(r.added, false); assert.equal(r.reason, 'too_long');
});
t('appendTag: ちょうど100字なら足す', () => {
  const r = L.appendTagToTitle('あ'.repeat(94), '#abcd'); // 94+1+5=100
  assert.equal(r.added, true); assert.equal(L.charCount(r.title), 100);
});
t('appendTag: 空タグは足さない', () => assert.equal(L.appendTagToTitle('x', ' # ').reason, 'empty'));
t('addSavedTags: 重複なしで追加', () => assert.deepEqual(L.addSavedTags(['#a'], 'A #b b'), ['#a', '#b']));
t('sanitizeTagList: 文字列以外を拒否', () => {
  assert.equal(L.sanitizeTagList([1]), null);
  assert.equal(L.sanitizeTagList('x'), null);
  assert.deepEqual(L.sanitizeTagList(['a', '#a', '#b']), ['#a', '#b']);
});
t('charCount: 絵文字1字', () => assert.equal(L.charCount('😀a'), 2));

// ---- メタデータ ----
t('即時: public・publishAtなし・categoryId 22', () => {
  const r = L.buildVideoResource({ title: ' 題 ', description: '本文', hashtags: '#a b', mode: 'now' });
  assert.deepEqual(r, { snippet: { title: '題', description: '本文\n\n#a #b', categoryId: '22', tags: ['a', 'b'] }, status: { privacyStatus: 'public' } });
});
t('予約: private + publishAt', () => {
  const r = L.buildVideoResource({ title: '題', description: '', hashtags: '', mode: 'schedule', publishAt: '2026-11-10T14:50:00Z' });
  assert.deepEqual(r.status, { privacyStatus: 'private', publishAt: '2026-11-10T14:50:00Z' });
  assert.equal(r.snippet.description, '');
  assert.equal('tags' in r.snippet, false);
});
t('説明欄に既にあるタグは二重に付けない', () => {
  const r = L.buildVideoResource({ title: '題', description: '本文 #a', hashtags: '#a #b', mode: 'now' });
  assert.equal(r.snippet.description, '本文 #a\n\n#b');
});
t('validateTitle', () => {
  assert.equal(L.validateTitle(''), '題名が空です');
  assert.match(L.validateTitle('a<b'), /使えません/);
  assert.match(L.validateTitle('あ'.repeat(101)), /超えて/);
  assert.equal(L.validateTitle('あ'.repeat(100)), '');
});
t('clipsaver相対パスを絶対URLへ', () => {
  assert.equal(L.absoluteUrl('/api/file?id=1&kind=play', 'https://clipsaver.trustsignalbot.workers.dev'), 'https://clipsaver.trustsignalbot.workers.dev/api/file?id=1&kind=play');
  assert.equal(L.absoluteUrl('https://x.example/a.mp4', 'https://clipsaver.trustsignalbot.workers.dev'), 'https://x.example/a.mp4');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
