/* ClipPost 設定。秘密情報はここに置かない(公開ページなので誰でも読める)。
 * GOOGLE_CLIENT_ID: Google Cloud の OAuth クライアントID(ウェブアプリ)。未設定の間はログインできない。
 * TAGS_API: ハッシュタグ共有Worker(clippost-tags)のURL。空なら端末内(localStorage)だけで動く。
 * CLIPSAVER_ORIGIN: TikTok URLから動画を取る clipsaver のURL。
 */
window.CLIPPOST_CONFIG = {
  GOOGLE_CLIENT_ID: '',
  TAGS_API: 'https://clippost-tags.trustsignalbot.workers.dev',
  CLIPSAVER_ORIGIN: 'https://clipsaver.trustsignalbot.workers.dev',
};
