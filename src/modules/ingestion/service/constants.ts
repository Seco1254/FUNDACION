export const MAX_SNIPPET_CHARS = 600;
export const MIN_SNIPPET_CHARS = 80;
export const TEXT_MIN_LEN = parseInt(process.env.ARTICLE_TEXT_MIN_LEN ?? '800', 10);
export const MIN_LEN_META = parseInt(process.env.ARTICLE_MIN_LEN_META ?? '200', 10);
export const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS ?? '12000', 10);
export const SCRAPE_MEDIA_TIMEOUT_MS = parseInt(process.env.SCRAPE_MEDIA_TIMEOUT_MS ?? '25000', 10);
export const USER_AGENT = 'FundacionBot/0.1';
