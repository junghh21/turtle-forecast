import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';

const DIR = process.env.SNP_DIR || '/snp';
const PROVIDERS = (process.env.SNP_PROVIDERS || 'gemini,qwen,deepseek,kimi,grok').split(',');
const ADVISOR = process.env.ADVISOR_URL || 'http://192.168.75.225:8765';
const SECRET = process.env.ADVISOR_SECRET || '';
const MODE = process.argv[2] || 'run';
const SANDBOX = 10;
const MAX_SCRIPTS = 8;
const now = new Date();

const ASSETS = [
  { key: 'spx', name: 'S&P 500', h1: 'ES=F', h1_name: 'E-mini S&P 500 futures (ES=F)', daily: '^GSPC', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'ndx', name: 'Nasdaq Composite', h1: 'NQ=F', h1_name: 'E-mini Nasdaq-100 futures (NQ=F)', daily: '^IXIC', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'tlt', name: 'TLT (iShares 20+Y Treasury ETF)', h1: 'TLT', h1_name: 'TLT', daily: 'TLT', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'boil', name: 'BOIL (ProShares Ultra 2x Natural Gas ETF)', h1: 'BOIL', h1_name: 'BOIL', daily: 'BOIL', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'kospi', name: 'KOSPI', h1: '^KS11', h1_name: 'KOSPI index (^KS11)', daily: '^KS11', tz: 'Asia/Seoul', open: 540, close: 930 },
];
const CROSS = [['US 10Y yield', '^TNX'], ['Dollar index', 'DX-Y.NYB'], ['USD/KRW', 'KRW=X'], ['WTI crude', 'CL=F'], ['Henry Hub natural gas futures', 'NG=F'], ['Nikkei 225', '^N225'], ['Euro Stoxx 50', '^STOXX50E'], ['VIX', '^VIX']];

const DEFAULT_STRATEGY = {
  version: 1,
  created_at: '2026-10-28T13:30:00Z',
  author: 'seed',
  sources: [
    { label: 'CNBC markets', url: 'https://www.cnbc.com/markets/', max: 1200 },
    { label: 'CNBC pre-markets', url: 'https://www.cnbc.com/pre-markets/', max: 800 },
  ],
  queries: ['stock market S&P 500 Nasdaq', '10-year Treasury yield', 'natural gas futures Henry Hub', 'KOSPI index close'],
  articles_per_query: 1,
  guidance: 'Weigh scheduled macro events (Fed, CPI, jobs) and megacap earnings timing. For 1-hour moves, recent momentum and event timing matter more than narratives. Give probabilities near 0.5 when evidence is weak.',
  changelog: 'Seed strategy.',
};

const SEED_SCRIPTS = [
  { id: 'momentum', description: '1h: sign of the last hour return scaled by 5-min volatility. close: 5-day return scaled by daily volatility.', code: String.raw`
const out = {};
for (const [k, a] of Object.entries(data.assets)) {
  const h = a.h1.map((x) => x[1]);
  const o = {};
  if (h.length > 30) {
    const r5 = lib.returns(h.slice(-288));
    const r1h = h.at(-1) / h.at(-13) - 1;
    const z = r1h / ((lib.std(r5) || 1e-9) * Math.sqrt(12));
    o.h1 = 0.5 + 0.08 * Math.tanh(z);
  }
  const d = a.daily.map((x) => x[1]);
  if (d.length > 30) {
    const z = (d.at(-1) / d.at(-6) - 1) / ((lib.std(lib.returns(d.slice(-60))) || 1e-9) * Math.sqrt(5));
    o.close = 0.5 + 0.06 * Math.tanh(z);
  }
  out[k] = o;
}
return out;` },
  { id: 'daily_reversal', description: 'close: fade yesterday\'s move when it was large versus the 60-day volatility (z-score of the last daily return).', code: String.raw`
const out = {};
for (const [k, a] of Object.entries(data.assets)) {
  const d = a.daily.map((x) => x[1]);
  if (d.length < 62) continue;
  const r = lib.returns(d.slice(-61));
  const z = r.at(-1) / (lib.std(r.slice(0, -1)) || 1e-9);
  out[k] = { close: 0.5 - 0.07 * Math.tanh(z / 1.5) };
}
return out;` },
  { id: 'trend_20d', description: 'close: price above/below its 20-day average, strength by distance in volatility units.', code: String.raw`
const out = {};
for (const [k, a] of Object.entries(data.assets)) {
  const d = a.daily.map((x) => x[1]);
  if (d.length < 40) continue;
  const dist = (d.at(-1) - lib.mean(d.slice(-20))) / (lib.std(d.slice(-20)) || 1e-9);
  out[k] = { close: 0.5 + 0.05 * Math.tanh(dist / 2) };
}
return out;` },
];

const HARNESS = String.raw`
import fs from 'node:fs';
import vm from 'node:vm';
const data = JSON.parse(fs.readFileSync('/sbx/data.json', 'utf8'));
const jobs = JSON.parse(fs.readFileSync('/sbx/jobs.json', 'utf8'));
const LIB = ` + '`' + String.raw`
globalThis.lib = {
  mean: (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN,
  std: (a) => { if (a.length < 2) return NaN; const m = lib.mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); },
  returns: (a) => a.slice(1).map((x, i) => x / a[i] - 1),
  sma: (a, n) => lib.mean(a.slice(-n)),
  ema: (a, n) => { const k = 2 / (n + 1); let e = a[0]; for (const x of a) e = x * k + e * (1 - k); return e; },
  zscore: (a) => (a.at(-1) - lib.mean(a)) / (lib.std(a) || 1e-9),
  corr: (a, b) => { const n = Math.min(a.length, b.length); const x = a.slice(-n), y = b.slice(-n); const mx = lib.mean(x), my = lib.mean(y); let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sx * sy || 1e-18); },
  clamp: (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x)),
  logistic: (x) => 1 / (1 + Math.exp(-x)),
};` + '`' + String.raw`;
const out = {};
for (const j of jobs) {
  const t0 = Date.now();
  try {
    const ctx = vm.createContext({ data: JSON.parse(JSON.stringify(data)) });
    vm.runInContext(LIB, ctx, { timeout: 1000 });
    const r = vm.runInContext('(function (data, lib) {"use strict";\n' + j.code + '\n})(data, lib)', ctx, { timeout: 5000 });
    const s = JSON.stringify(r);
    if (s === undefined) throw new Error('script returned nothing');
    if (s.length > 20000) throw new Error('result larger than 20000 chars');
    out[j.id] = { ok: true, ms: Date.now() - t0, result: JSON.parse(s) };
  } catch (e) { out[j.id] = { ok: false, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 300) }; }
}
process.stdout.write(JSON.stringify(out));
`;

const P = (f) => `${DIR}/${f}`;
const readJsonl = (f) => fs.existsSync(P(f)) ? fs.readFileSync(P(f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const appendJsonl = (f, o) => fs.appendFileSync(P(f), JSON.stringify(o) + '\n');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(P(f), 'utf8')); } catch { return d; } };
const writeJson = (f, o) => fs.writeFileSync(P(f), JSON.stringify(o, null, 1));
const log = (...a) => console.log(new Date().toISOString(), MODE, ...a);
const squash = (t) => String(t || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const BOILER = /newsletter|sign up|privacy|cookie|terms of|all rights reserved|news tip|get in touch|subscribe|advertis|delivered to your inbox/i;

function loadStrategy() {
  const s = readJson('strategy.json', null);
  if (s) return s;
  writeJson('strategy.json', DEFAULT_STRATEGY);
  appendJsonl('strategies.jsonl', DEFAULT_STRATEGY);
  return DEFAULT_STRATEGY;
}

function loadScripts() {
  const s = readJson('scripts.json', null);
  if (s) return s;
  const seeded = SEED_SCRIPTS.map((x) => ({ ...x, author: 'seed', created_at: now.toISOString(), status: 'active' }));
  writeJson('scripts.json', seeded);
  return seeded;
}
const activeScripts = () => loadScripts().filter((s) => s.status === 'active');

function tzParts(d, tz = 'America/New_York') {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const o = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hm: Number(o.hour) % 24 * 60 + Number(o.minute), wd: o.weekday };
}
const etParts = (d) => tzParts(d, 'America/New_York');
function closeUtc(date, a) {
  const base = Date.parse(`${date}T00:00:00Z`) + a.close * 60_000;
  for (let off = -14; off <= 14; off++) {
    const t = new Date(base - off * 3600_000);
    const e = tzParts(t, a.tz);
    if (e.date === date && e.hm === a.close) return t;
  }
  throw new Error('close time ' + date + ' ' + a.key);
}
const inSession = (d, a) => { const e = tzParts(d, a.tz); return !['Sat', 'Sun'].includes(e.wd) && e.hm >= a.open && e.hm < a.close; };

async function withBrowser(fn) {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', locale: 'en-US' });
  try { return await fn(ctx); } finally { await b.close(); }
}

async function readPage(ctx, url, { max = 1500, wait = 2500 } = {}) {
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(wait);
    const title = await p.title();
    const text = await p.evaluate(() => {
      const el = document.querySelector('article') || document.querySelector('main') || document.body;
      const ps = [...el.querySelectorAll('p, h1, h2, h3, li')].map((n) => n.innerText.trim()).filter((t) => t.length > 40);
      return ps.length >= 3 ? ps.join('\n') : el.innerText;
    });
    const lines = [...new Set(squash(text).split('\n').map((l) => l.trim()))].filter((l) => l.length > 25 && !BOILER.test(l));
    return { url: p.url(), title: title.slice(0, 150), text: lines.join('\n').slice(0, max) };
  } finally { await p.close(); }
}

async function newsFor(ctx, q, n) {
  const r = await ctx.request.get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=en-US&gl=US&ceid=US:en`, { timeout: 30000 });
  const x = await r.text();
  return [...x.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>/g)]
    .map((m) => ({ title: m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), link: m[2], at: new Date(m[3]).toISOString(), query: q }))
    .filter((a) => new Date(a.at) <= now).sort((a, b) => b.at.localeCompare(a.at)).slice(0, n);
}

const SEED_CANDIDATES = [
  ['Yahoo Finance markets', 'https://finance.yahoo.com/markets/'],
  ['MarketWatch markets', 'https://www.marketwatch.com/markets'],
  ['Reuters markets', 'https://www.reuters.com/markets/'],
  ['AP business', 'https://apnews.com/business'],
  ['Investing.com natural gas news', 'https://www.investing.com/commodities/natural-gas-news'],
  ['EIA natural gas weekly update', 'https://www.eia.gov/naturalgas/weekly/'],
  ['US Treasury daily yield curve', 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve'],
  ['CME FedWatch', 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html'],
  ['Yonhap economy (English)', 'https://en.yna.co.kr/economy/index'],
  ['Korea Herald finance', 'https://www.koreaherald.com/list.php?ct=020300000000'],
  ['Naver Finance market (KR)', 'https://finance.naver.com/sise/'],
  ['Trading Economics calendar', 'https://tradingeconomics.com/calendar'],
];

function loadCandidates() {
  const c = readJson('candidates.json', null);
  if (c) return c;
  const seeded = SEED_CANDIDATES.map(([label, url]) => ({ label, url, origin: 'seed', tries: 0, ok: 0, chars: 0 }));
  writeJson('candidates.json', seeded);
  return seeded;
}

function addCandidate(label, url, origin) {
  if (!/^https?:\/\/[^\s]+$/.test(String(url || ''))) return false;
  const c = loadCandidates();
  const norm = (u) => u.replace(/\/+$/, '');
  if (c.some((x) => norm(x.url) === norm(url)) || loadStrategy().sources.some((s) => norm(s.url) === norm(url))) return false;
  c.push({ label: String(label || url).slice(0, 60), url, origin, tries: 0, ok: 0, chars: 0, added_at: now.toISOString() });
  writeJson('candidates.json', c.slice(-80));
  return true;
}

async function scout(ctx, strategy) {
  const inUse = new Set(strategy.sources.map((s) => s.url.replace(/\/+$/, '')));
  const c = loadCandidates();
  const pick = c.filter((x) => !inUse.has(x.url.replace(/\/+$/, '')) && x.tries < 6 && !x.dead && !(x.tries >= 2 && !x.ok))
    .sort((a, b) => a.tries - b.tries || (a.last_at || '').localeCompare(b.last_at || ''))[0];
  if (!pick) return null;
  const res = { label: pick.label, url: pick.url, at: now.toISOString() };
  try {
    const r = await readPage(ctx, pick.url, { max: 1500, wait: 4000 });
    Object.assign(res, { ok: r.text.length >= 200, chars: r.text.length, title: r.title, sample: r.text.slice(0, 240) });
  } catch (e) { Object.assign(res, { ok: false, chars: 0, why: e.message.slice(0, 100) }); }
  if (/^(404|not found|page not found)\b/i.test(res.title || '') || /ERR_NAME_NOT_RESOLVED/.test(res.why || '')) pick.dead = true;
  pick.tries++; pick.last_at = res.at; pick.last_ok = res.ok;
  if (res.ok) { pick.ok++; pick.chars += res.chars; }
  writeJson('candidates.json', c);
  appendJsonl('scouting.jsonl', res);
  return res;
}

async function fetchMarket(strategy, { withScout = true } = {}) {
  return withBrowser(async (ctx) => {
    const p = await ctx.newPage();
    await p.goto('https://finance.yahoo.com/quote/ES%3DF/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(3000);
    const chart = (sym, interval, range) => p.evaluate(async ([s, i, r]) => {
      const x = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=${i}&range=${r}`, { credentials: 'include' });
      if (!x.ok) throw new Error(`${s} ${x.status}`);
      const j = (await x.json()).chart.result[0];
      const q = j.indicators.quote[0];
      return (j.timestamp || []).map((t, k) => ({ t, c: q.close[k] })).filter((z) => z.c != null);
    }, [sym, interval, range]);
    const bars = {};
    for (const a of ASSETS) {
      try { bars[a.key] = { h1: await chart(a.h1, '5m', '5d'), daily: await chart(a.daily, '1d', '1y') }; }
      catch (e) { log('bars failed', a.key, e.message); bars[a.key] = { h1: [], daily: [] }; }
    }
    const crossSeries = {};
    const cross = {};
    for (const [k, s] of CROSS) {
      try {
        const z = await chart(s, '1d', '3mo');
        crossSeries[k] = z;
        if (z.length >= 2) cross[k] = { last: +z.at(-1).c.toFixed(3), chg_pct: +((z.at(-1).c / z.at(-2).c - 1) * 100).toFixed(2) };
      } catch (e) { log('cross failed', s, e.message); }
    }
    const news = [];
    for (const q of strategy.queries) {
      try { for (const a of await newsFor(ctx, q, 6)) if (!news.some((x) => x.title === a.title)) news.push(a); }
      catch (e) { log('news failed', q, e.message); }
    }
    const deadline = Date.now() + 150_000;
    const explored = [];
    const failed = [];
    const targets = [
      ...strategy.sources.map((s) => ({ ...s, kind: 'source' })),
      ...strategy.queries.flatMap((q) => news.filter((a) => a.query === q).slice(0, strategy.articles_per_query || 1)
        .map((a) => ({ label: `Article: ${a.title.slice(0, 90)}`, url: a.link, max: 1000, wait: 5000, kind: 'article' }))),
    ];
    for (const t of targets) {
      if (Date.now() > deadline) { failed.push({ label: t.label, kind: t.kind, why: 'time budget' }); continue; }
      try {
        const r = await readPage(ctx, t.url, { max: t.max || 1200, wait: t.wait });
        if (r.text.length >= 200 && !/news\.google\.com/.test(r.url)) explored.push({ label: t.label, kind: t.kind, url: r.url, text: r.text });
        else failed.push({ label: t.label, kind: t.kind, why: `thin ${r.text.length}` });
      } catch (e) { failed.push({ label: t.label, kind: t.kind, why: e.message.slice(0, 80) }); }
    }
    const scouted = withScout ? await scout(ctx, strategy).catch((e) => { log('scout failed', e.message); return null; }) : null;
    return { at: now.toISOString(), bars, crossSeries, cross, news, explored, failed, scouted };
  });
}

function dailyCloses(daily, a) {
  return daily.map((z) => { const date = tzParts(new Date(z.t * 1000), a.tz).date; return { date, close: z.c, closeAt: closeUtc(date, a) }; });
}

function scriptData(m) {
  const at = new Date(m.at).getTime();
  const assets = {};
  for (const a of ASSETS) {
    const b = m.bars[a.key] || { h1: [], daily: [] };
    const closes = dailyCloses(b.daily, a).filter((d) => d.closeAt.getTime() + 30 * 60_000 <= at);
    assets[a.key] = { h1: b.h1.map((z) => [z.t, z.c]), daily: closes.map((d) => [Math.floor(d.closeAt.getTime() / 1000), d.close]) };
  }
  return {
    now: m.at, assets,
    cross: Object.fromEntries(Object.entries(m.crossSeries || {}).map(([k, z]) => [k, z.map((x) => [x.t, x.c])])),
    news: m.news.map(({ title, at: t }) => ({ title, at: t })),
    pages: m.explored.map(({ label, text }) => ({ label, text })),
  };
}

function queueSandbox(m, jobs) {
  fs.mkdirSync(P('work/sbx'), { recursive: true });
  fs.writeFileSync(P('work/sbx/harness.mjs'), HARNESS);
  fs.writeFileSync(P('work/sbx/data.json'), JSON.stringify(scriptData(m)));
  fs.writeFileSync(P('work/sbx/jobs.json'), JSON.stringify(jobs));
  try { fs.unlinkSync(P('work/sbx_out.json')); } catch {}
}
const sandboxResults = () => readJson('work/sbx_out.json', {});

function signalOf(result) {
  if (!result || typeof result !== 'object') return null;
  const out = {};
  for (const a of ASSETS) {
    const x = result[a.key];
    if (!x || typeof x !== 'object') continue;
    const o = {};
    for (const hz of ['h1', 'close']) { const v = Number(x[hz] ?? (hz === 'h1' ? x['1h'] : undefined)); if (v >= 0 && v <= 1) o[hz] = +v.toFixed(4); }
    if (Object.keys(o).length) out[a.key] = o;
  }
  return Object.keys(out).length ? out : null;
}

function assetSnap(m, a) {
  const at = new Date(m.at).getTime();
  const b = m.bars[a.key] || { h1: [], daily: [] };
  const last = b.h1.filter((z) => z.t * 1000 <= at).at(-1);
  const hourly = [];
  for (let h = 12; h >= 0; h--) {
    const z = b.h1.filter((y) => y.t * 1000 <= at - h * 3600_000).at(-1);
    if (z && !hourly.some((x) => x.t === z.t)) hourly.push({ t: z.t, at: new Date(z.t * 1000).toISOString(), c: z.c });
  }
  const closes = dailyCloses(b.daily, a).filter((d) => d.closeAt.getTime() + 30 * 60_000 <= at);
  return {
    last: last ? { at: new Date(last.t * 1000).toISOString(), price: last.c, live: at - last.t * 1000 < 15 * 60_000 } : null,
    hour_ago: hourly.find((x) => x.t * 1000 <= at - 3600_000 && x.t * 1000 > at - 3 * 3600_000)?.c ?? null,
    hourly: hourly.map(({ at: t, c }) => ({ at: t, c })),
    closes: closes.slice(-10).map(({ date, close }) => ({ date, close })),
    in_session: inSession(new Date(m.at), a),
  };
}

function snapshot(m) {
  return {
    assets: Object.fromEntries(ASSETS.map((a) => [a.key, assetSnap(m, a)])),
    vix: m.cross?.VIX?.last ?? null,
    cross: m.cross,
    news: m.news.slice(0, 16).map(({ title, at }) => ({ title, at })),
    explored: m.explored.map(({ label, kind, url, text }) => ({ label, kind, url, chars: text.length })),
    failed: m.failed,
    scouted: m.scouted ? { label: m.scouted.label, url: m.scouted.url, ok: m.scouted.ok, chars: m.scouted.chars } : null,
  };
}

const fmt = (x) => (x == null ? 'n/a' : Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(3));

const SCRIPT_API = [
  `Scripts are JavaScript function BODIES run as (function (data, lib) { <body> })(data, lib) in an isolated sandbox (no network, no require/import, 5 s limit, result <= 20000 chars).`,
  `data = { now: ISO time, assets: { spx|ndx|tlt|boil|kospi: { h1: [[unixSec, close], ...] 5-minute bars of the 1h instrument, last 5 days; daily: [[unixSec, close], ...] completed regular closes, ~1 year } }, cross: { "US 10Y yield"|"Dollar index"|"USD/KRW"|"WTI crude"|"Henry Hub natural gas futures"|"Nikkei 225"|"Euro Stoxx 50"|"VIX": [[unixSec, close], ...] daily, 3 months }, news: [{title, at}], pages: [{label, text}] }`,
  `lib = { mean, std, returns(arr) -> simple returns, sma(arr,n), ema(arr,n), zscore(arr) -> z of last value, corr(a,b), clamp(x,lo,hi), logistic(x) }`,
].join('\n');

function buildPrompt(s, m, strategy, signals, scriptBoard) {
  const et = etParts(new Date(m.at));
  const kst = tzParts(new Date(m.at), 'Asia/Seoul');
  const hm = (e) => `${String(Math.floor(e.hm / 60)).padStart(2, '0')}:${String(e.hm % 60).padStart(2, '0')}`;
  const lines = [
    `Current time: ${m.at} (New York ${et.date} ${hm(et)} ${et.wd}; Seoul ${kst.date} ${hm(kst)}).`,
    `Everything below was fetched just now by a browser from Yahoo Finance, Google News and the linked pages. Use it; do not invent other figures.`,
    ``,
  ];
  for (const a of ASSETS) {
    const x = s.assets[a.key];
    lines.push(`## ${a.key} — ${a.name}`);
    lines.push(`1h instrument ${a.h1_name}: last ${fmt(x.last?.price)} at ${x.last?.at || 'n/a'}${x.last?.live ? '' : ' (NOT trading now — the 1h prediction will not be scored)'}`);
    if (x.hourly.length) lines.push(`hourly closes (UTC): ${x.hourly.map((h) => `${h.at.slice(5, 16)} ${fmt(h.c)}`).join('; ')}`);
    lines.push(`last regular closes of ${a.daily}: ${x.closes.map((d) => `${d.date} ${fmt(d.close)}`).join('; ')}`);
  }
  lines.push(``, `Cross-asset (last daily value, change vs previous): ${Object.entries(s.cross || {}).map(([k, v]) => `${k} ${v.last} (${v.chg_pct >= 0 ? '+' : ''}${v.chg_pct}%)`).join('; ')}`);
  lines.push(`Headlines (newest first):`, ...s.news.map((n) => `- [${n.at.slice(0, 16)}Z] ${n.title}`));
  lines.push(``, `Pages read just now (excerpts):`, ...m.explored.map((e) => `### ${e.label}\n${e.text}`));
  if (Object.keys(signals).length) {
    lines.push(``, `Signal scripts (p_up per asset from quantitative scripts that run every hour; track record = scored hit rate so far):`);
    for (const [id, sig] of Object.entries(signals)) {
      const b = scriptBoard[id] || {};
      const tr = ['h1', 'close'].map((hz) => b[hz]?.n ? `${hz} ${Math.round(b[hz].hit * 100)}% of ${b[hz].n}${b[hz].days ? ` over ${b[hz].days} target day(s)` : ''}` : `${hz} unscored`).join(', ');
      lines.push(`- ${id} [${tr}]: ${Object.entries(sig).map(([k, v]) => `${k} ${Object.entries(v).map(([hz, p]) => `${hz}=${p.toFixed(2)}`).join('/')}`).join('; ')}`);
    }
  }
  lines.push(``, `Analyst playbook v${strategy.version} (revised from scored past predictions):`, strategy.guidance, ``);
  lines.push(`For EACH asset key (${ASSETS.map((a) => a.key).join(', ')}) predict:`);
  lines.push(`- "1h": will the 1h instrument be HIGHER or LOWER exactly 60 minutes from now than its last price shown?`);
  lines.push(`- "close": will the NEXT regular-session close of the daily symbol (the first close after the current time) be HIGHER or LOWER than the last close shown?`);
  lines.push(``, `You can run code before answering. If you want to, reply with ONLY {"run_script":{"code":"<function body>"}} inside a \`\`\`json code block and you will receive its output in this chat, then give the prediction JSON. At most one script run.`);
  lines.push(SCRIPT_API);
  lines.push(``, `Final answer: reply with ONLY this JSON inside a single \`\`\`json code block (the block keeps characters like * intact), nothing else:`);
  lines.push(`{"spx":{"1h":{"dir":"up|down","p_up":0.00},"close":{"dir":"up|down","p_up":0.00}},"ndx":{...},"tlt":{...},"boil":{...},"kospi":{...},"reason":"one or two short sentences","suggest_source":{"label":"...","url":"https://..."},"new_script":{"id":"snake_case_name","description":"one sentence","code":"<function body returning {spx:{h1:p_up,close:p_up},...}>"}}`);
  lines.push(`p_up is your probability (0 to 1) that the price ends higher; dir must agree with p_up. suggest_source (optional): one public web page not listed above that would most improve these predictions. new_script (optional): a persistent signal script that will run every hour and be scored like you; propose one only if you believe it adds information the existing scripts lack.`);
  return lines.join('\n');
}

function ask(provider, prompt, { timeout_s = 240, chat_id } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ provider, prompt, timeout_s, ...(chat_id ? { chat_id } : {}) });
    const req = http.request(new URL('/ask', ADVISOR), { method: 'POST', headers: { 'content-type': 'application/json', 'x-advisor-secret': SECRET, 'content-length': Buffer.byteLength(body) }, timeout: (timeout_s + 90) * 1000 }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { const j = JSON.parse(s); res.statusCode === 200 ? resolve(j) : reject(new Error(`${res.statusCode} ${s.slice(0, 200)}`)); } catch { reject(new Error(`${res.statusCode} ${s.slice(0, 200)}`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function cooled(p, preds) {
  const mine = preds.filter((x) => x.provider === p).slice(-2);
  return mine.length === 2 && mine.every((x) => x.error) && now.getTime() - new Date(mine[1].at).getTime() < 6 * 3600_000;
}

function pickProvider(start, exclude = []) {
  const preds = readJsonl('preds.jsonl');
  for (let k = 0; k < PROVIDERS.length; k++) { const p = PROVIDERS[(start + k) % PROVIDERS.length]; if (!exclude.includes(p) && !cooled(p, preds)) return p; }
  return null;
}

async function repairAsk(rec) {
  if (!rec.chat_id) return null;
  const t0 = Date.now();
  try {
    const r = await ask(rec.provider, 'Your reply could not be parsed as JSON. Reply again with ONLY the complete prediction JSON in the format given earlier, inside a ```json code block.', { chat_id: rec.chat_id, timeout_s: 180 });
    const p = parseAnswer(r.answer);
    rec.repair = { ok: !!p, ms: Date.now() - t0, answer: String(r.answer).slice(0, 4000) };
    return p;
  } catch (e) { rec.repair = { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 200) }; return null; }
}

function jsonIn(t) {
  const start = t.indexOf('{');
  if (start < 0) return null;
  for (let end = t.lastIndexOf('}'); end > start; end = t.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  for (const tail of ['}', '}}', '"}}', '"}}}']) { try { return JSON.parse(t.slice(start).trimEnd() + tail); } catch {} }
  return null;
}

function firstJson(text) {
  const t = String(text);
  for (const s of [...[...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]), t]) { const j = jsonIn(s); if (j) return j; }
  return null;
}

function normCode(code) {
  const s = String(code).trim().replace(/^```(?:javascript|js)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  return /^(async\s+)?function\b[^(]*\(|^\(\s*data\b[^)]*\)\s*=>|^data\s*=>/.test(s) ? `return (${s})(data, lib);` : s;
}

function scriptRequest(text) {
  const j = firstJson(text);
  if (j?.run_script?.code && typeof j.run_script.code === 'string') return normCode(j.run_script.code.slice(0, 12000));
  if (/run_script/.test(text)) { const m = String(text).match(/```(?:javascript|js)\s*\n([\s\S]*?)```/); if (m) return normCode(m[1].slice(0, 12000)); }
  return null;
}

function parseAnswer(text) {
  const j = firstJson(text);
  if (!j) return null;
  const norm = (x) => {
    if (!x) return null;
    const p = Number(x.p_up);
    const dir = String(x.dir || '').toLowerCase();
    if (!['up', 'down'].includes(dir) || !(p >= 0 && p <= 1)) return null;
    return { dir, p_up: p };
  };
  const out = { assets: {}, reason: String(j.reason || '').slice(0, 400) };
  for (const a of ASSETS) {
    const x = j[a.key] || {};
    const h1 = norm(x['1h'] || x.h1);
    const close = norm(x.close);
    if (h1 || close) out.assets[a.key] = { h1, close };
  }
  if (j.suggest_source?.url) out.suggest_source = { label: String(j.suggest_source.label || '').slice(0, 60), url: String(j.suggest_source.url).slice(0, 300) };
  if (j.new_script?.code && typeof j.new_script.code === 'string') out.new_script = { id: String(j.new_script.id || 'script').replace(/[^a-z0-9_]/gi, '_').slice(0, 40).toLowerCase(), description: String(j.new_script.description || '').slice(0, 300), code: normCode(j.new_script.code.slice(0, 12000)) };
  return Object.keys(out.assets).length ? out : null;
}

function outcomes(pr, a, b) {
  const t0 = new Date(pr.at).getTime();
  const sa = pr.snapshot.assets?.[a.key];
  const res = {};
  if (!sa) return res;
  if (sa.last?.live) {
    const tgt = t0 + 3600_000;
    if (now.getTime() >= tgt + 10 * 60_000 && b.h1.length && b.h1[0].t * 1000 <= tgt) {
      const z = b.h1.filter((y) => y.t * 1000 <= tgt).at(-1);
      const px = sa.last.price;
      if (!z || tgt - z.t * 1000 > 10 * 60_000) res.h1 = { status: 'no_target_bar' };
      else if (z.c === px) res.h1 = { status: 'tie' };
      else res.h1 = { status: 'scored', base: px, target: z.c, target_at: new Date(z.t * 1000).toISOString(), outcome_up: z.c > px,
        momentum_hit: sa.hour_ago != null && px !== sa.hour_ago ? (px > sa.hour_ago) === (z.c > px) : null };
    }
  }
  const tgt = dailyCloses(b.daily, a).find((d) => d.closeAt.getTime() > t0);
  if (tgt && now.getTime() >= tgt.closeAt.getTime() + 60 * 60_000) {
    const ref = sa.closes.at(-1);
    if (!ref) res.close = { status: 'no_base' };
    else if (tgt.close === ref.close) res.close = { status: 'tie' };
    else res.close = { status: 'scored', base_date: ref.date, base: ref.close, target_date: tgt.date, target: tgt.close, outcome_up: tgt.close > ref.close, in_session: sa.in_session };
  }
  return res;
}

function reparse() {
  const preds = readJsonl('preds.jsonl');
  let n = 0;
  for (const p of preds) {
    if (p.parsed || p.error || !p.answer) continue;
    const q = parseAnswer(p.answer);
    if (q) { delete q.new_script; delete q.suggest_source; p.parsed = q; p.reparsed_at = now.toISOString(); n++; }
  }
  if (n) fs.writeFileSync(P('preds.jsonl'), preds.map((p) => JSON.stringify(p)).join('\n') + '\n');
  return n;
}

function score(m) {
  const preds = readJsonl('preds.jsonl');
  const done = new Set(readJsonl('scores.jsonl').map((s) => `${s.id}:${s.script || ''}:${s.asset}:${s.horizon}`));
  let n = 0;
  for (const pr of preds) {
    for (const a of ASSETS) {
      const pa = pr.parsed?.assets?.[a.key];
      const sigs = Object.entries(pr.signals || {}).filter(([, v]) => v?.[a.key]);
      if (!pa && !sigs.length) continue;
      const oc = outcomes(pr, a, m.bars[a.key] || { h1: [], daily: [] });
      for (const hz of ['h1', 'close']) {
        const o = oc[hz];
        if (!o) continue;
        const horizon = hz === 'h1' ? '1h' : 'close';
        const base = { id: pr.id, asset: a.key, horizon, strategy_version: pr.strategy_version, at: pr.at, scored_at: now.toISOString(), in_session: o.in_session };
        const emit = (extra, dir, p) => {
          const key = `${pr.id}:${extra.script || ''}:${a.key}:${horizon}`;
          if (done.has(key)) return;
          done.add(key);
          const rec = { ...base, ...extra };
          if (o.status !== 'scored') rec.status = o.status;
          else Object.assign(rec, { status: 'scored', base: o.base, target: o.target, target_at: o.target_at || o.target_date, base_date: o.base_date, target_date: o.target_date, outcome_up: o.outcome_up, dir, p_up: p, hit: (dir === 'up') === o.outcome_up, momentum_hit: o.momentum_hit });
          appendJsonl('scores.jsonl', rec); n++;
        };
        if (pa?.[hz]) emit({ provider: pr.provider }, pa[hz].dir, pa[hz].p_up);
        for (const [id, v] of sigs) {
          const p = v[a.key]?.[hz];
          if (p == null || p === 0.5) continue;
          emit({ provider: 'script', script: id }, p > 0.5 ? 'up' : 'down', p);
        }
      }
    }
  }
  return n;
}

function archiveNews(m) {
  const seen = new Set(readJsonl('news.jsonl').slice(-2000).map((n) => n.title));
  for (const n of m.news || []) {
    if (seen.has(n.title)) continue;
    seen.add(n.title);
    appendJsonl('news.jsonl', { title: n.title, at: n.at, query: n.query, link: n.link, seen_at: now.toISOString() });
  }
}

function summarize(rows) {
  if (!rows.length) return { n: 0 };
  const hit = rows.filter((r) => r.hit).length / rows.length;
  const brier = rows.reduce((a, r) => a + (r.p_up - (r.outcome_up ? 1 : 0)) ** 2, 0) / rows.length;
  const upRate = rows.filter((r) => r.outcome_up).length / rows.length;
  const mom = rows.filter((r) => r.momentum_hit != null);
  const o = { n: rows.length, hit: +hit.toFixed(3), brier: +brier.toFixed(4), always_up_hit: +upRate.toFixed(3) };
  if (mom.length) o.momentum_hit = +(mom.filter((r) => r.momentum_hit).length / mom.length).toFixed(3);
  const days = new Set(rows.filter((r) => r.horizon === 'close').map((r) => r.target_date)).size;
  if (days) o.days = days;
  return o;
}

function report() {
  const all = readJsonl('scores.jsonl').filter((s) => s.status === 'scored');
  const S = all.filter((s) => !s.script);
  const SC = all.filter((s) => s.script);
  const preds = readJsonl('preds.jsonl');
  const h1 = S.filter((s) => s.horizon === '1h');
  const cl = S.filter((s) => s.horizon === 'close' && !s.in_session);
  const versions = [...new Set(S.map((s) => s.strategy_version))].sort((a, b) => a - b);
  const assets = {};
  for (const a of ASSETS) {
    const ah = h1.filter((r) => r.asset === a.key);
    const ac = cl.filter((r) => r.asset === a.key);
    assets[a.key] = { name: a.name, h1: summarize(ah), close: { ...summarize(ac), target_dates: new Set(ac.map((r) => r.target_date)).size },
      ready: { h1: ah.length >= 300, close: new Set(ac.map((r) => r.target_date)).size >= 40 } };
  }
  const scripts = {};
  for (const id of new Set(SC.map((s) => s.script))) {
    const r = SC.filter((s) => s.script === id);
    scripts[id] = { h1: summarize(r.filter((s) => s.horizon === '1h')), close: summarize(r.filter((s) => s.horizon === 'close' && !s.in_session)),
      by_asset: Object.fromEntries(ASSETS.map((a) => [a.key, { h1: summarize(r.filter((s) => s.asset === a.key && s.horizon === '1h')), close: summarize(r.filter((s) => s.asset === a.key && s.horizon === 'close' && !s.in_session)) }])) };
  }
  const out = {
    as_of: now.toISOString(), predictions: preds.length, parsed: preds.filter((p) => p.parsed).length,
    script_runs: preds.filter((p) => p.analysis).length,
    pooled: { h1: summarize(h1), close: summarize(cl) },
    assets,
    by_provider: Object.fromEntries(PROVIDERS.map((p) => [p, { h1: summarize(h1.filter((r) => r.provider === p)), close: summarize(cl.filter((r) => r.provider === p)) }])),
    by_strategy: Object.fromEntries(versions.map((v) => [v, { h1: summarize(h1.filter((r) => r.strategy_version === v)), close: summarize(cl.filter((r) => r.strategy_version === v)) }])),
    with_analysis: { h1: summarize(h1.filter((r) => preds.find((p) => p.id === r.id)?.analysis)), close: summarize(cl.filter((r) => preds.find((p) => p.id === r.id)?.analysis)) },
    close_in_session_secondary: summarize(S.filter((s) => s.horizon === 'close' && s.in_session)),
    scripts,
    matrix: Object.fromEntries(PROVIDERS.map((p) => [p, Object.fromEntries(ASSETS.map((a) => [a.key, {
      h1: summarize(h1.filter((r) => r.provider === p && r.asset === a.key)),
      close: summarize(cl.filter((r) => r.provider === p && r.asset === a.key)) }]))])),
    curve: Object.fromEntries(['1h', 'close'].map((hz) => [hz, Object.fromEntries(PROVIDERS.map((p) => {
      const rows = (hz === '1h' ? h1 : cl).filter((r) => r.provider === p).sort((a, b) => a.scored_at.localeCompare(b.scored_at));
      let k = 0;
      return [p, rows.map((r, i) => { if (r.hit) k++; return [r.at, +(k / (i + 1)).toFixed(4), i + 1]; }).filter((_, i, arr) => arr.length <= 120 || i % Math.ceil(arr.length / 120) === 0 || i === arr.length - 1)];
    }))])),
  };
  out.interim = !Object.values(assets).some((a) => a.ready.h1 || a.ready.close);
  writeJson('report.json', out);
  return out;
}

function sourceStats(lastN = 48) {
  const st = {};
  for (const p of readJsonl('preds.jsonl').slice(-lastN)) {
    for (const e of p.snapshot?.explored || []) { const s = (st[e.label] ||= { ok: 0, fail: 0, chars: 0, kind: e.kind }); s.ok++; s.chars += e.chars; }
    for (const f of p.snapshot?.failed || []) { const s = (st[f.label] ||= { ok: 0, fail: 0, chars: 0, kind: f.kind }); s.fail++; s.last_fail = f.why; }
  }
  return Object.entries(st).filter(([, s]) => s.kind === 'source').map(([label, s]) => ({ label, ok: s.ok, fail: s.fail, avg_chars: s.ok ? Math.round(s.chars / s.ok) : 0, last_fail: s.last_fail }));
}

function candidateStats() {
  return loadCandidates().filter((c) => c.tries > 0)
    .map((c) => ({ label: c.label, url: c.url, origin: c.origin, tries: c.tries, ok: c.ok, avg_chars: c.ok ? Math.round(c.chars / c.ok) : 0 }))
    .sort((a, b) => b.ok / b.tries - a.ok / a.tries || b.avg_chars - a.avg_chars).slice(0, 20);
}

function addScript(s, author) {
  const all = loadScripts();
  let id = s.id || 'script';
  while (all.some((x) => x.id === id)) id = `${s.id}_${Math.random().toString(36).slice(2, 5)}`;
  all.push({ id, description: s.description, code: s.code, author, created_at: now.toISOString(), status: 'active' });
  const act = all.filter((x) => x.status === 'active');
  if (act.length > MAX_SCRIPTS) {
    const board = readJson('report.json', {}).scripts || {};
    const worst = act.filter((x) => x.author !== 'seed' && x.id !== id)
      .sort((a, b) => (board[a.id]?.h1?.hit ?? 0.5) + (board[a.id]?.close?.hit ?? 0.5) - (board[b.id]?.h1?.hit ?? 0.5) - (board[b.id]?.close?.hit ?? 0.5))[0];
    if (worst) { worst.status = 'retired'; worst.retired_at = now.toISOString(); worst.retired_why = 'cap reached; weakest record'; }
  }
  writeJson('scripts.json', all);
  appendJsonl('script_events.jsonl', { at: now.toISOString(), event: 'added', id, author });
  return id;
}

function exportPublic(rep, m) {
  if (!fs.existsSync(P('site'))) return;
  const site = P('site/data');
  fs.mkdirSync(site, { recursive: true });
  const byId = {};
  for (const s of readJsonl('scores.jsonl')) if (!s.script) ((byId[s.id] ||= {})[s.asset] ||= {})[s.horizon] = s.status === 'scored' ? { hit: s.hit, outcome_up: s.outcome_up, target: s.target } : { status: s.status };
  const preds = readJsonl('preds.jsonl').slice(-240).reverse().map((p) => ({
    id: p.id, at: p.at, provider: p.provider, strategy_version: p.strategy_version, ms: p.ms,
    assets: Object.fromEntries(ASSETS.map((a) => { const x = p.snapshot.assets?.[a.key]; return [a.key, x ? { last: x.last, ref: x.closes.at(-1), in_session: x.in_session } : null]; })),
    sources: (p.snapshot.explored || []).map(({ label, url }) => ({ label, url })), headlines: (p.snapshot.news || []).slice(0, 6), scouted: p.snapshot.scouted,
    signals: p.signals, analysis: p.analysis ? { code: p.analysis.code.slice(0, 3000), ok: p.analysis.ok, output: JSON.stringify(p.analysis.result ?? p.analysis.error ?? null).slice(0, 1500) } : undefined,
    new_script: p.new_script_id ? { id: p.new_script_id, ok: p.new_script_ok, why: p.new_script_why } : undefined,
    parsed: p.parsed ? { ...p.parsed, new_script: undefined } : null, failed: p.parsed ? undefined : (p.error ? 'error' : 'unparsed'), result: byId[p.id] || {},
  }));
  const prev = readJson('site/data/latest.json', {});
  const series = m ? Object.fromEntries(ASSETS.map((a) => [a.key, (m.bars[a.key]?.h1 || []).filter((z) => z.t * 1000 >= now.getTime() - 72 * 3600_000).filter((_, k, arr) => k % 3 === 0 || k === arr.length - 1).map((z) => [z.t, +z.c.toFixed(3)])])) : (prev.series || {});
  const strategies = readJsonl('strategies.jsonl').reverse().map(({ version, created_at, author, sources, queries, articles_per_query, guidance, changelog, rejected_sources }) =>
    ({ version, created_at, author, sources, queries, articles_per_query, guidance, changelog, rejected_sources }));
  const lastSignals = readJsonl('preds.jsonl').reverse().find((p) => p.signals)?.signals || {};
  fs.writeFileSync(`${site}/latest.json`, JSON.stringify({
    generated_at: now.toISOString(), providers: PROVIDERS, assets: ASSETS.map(({ key, name, h1, daily, tz }) => ({ key, name, h1, daily, tz })),
    report: rep, predictions: preds, series, strategies,
    evolutions: readJsonl('evolutions.jsonl').reverse().slice(0, 40),
    candidates: loadCandidates().map(({ label, url, origin, tries, ok, chars, last_ok, last_at }) => ({ label, url, origin, tries, ok, avg_chars: ok ? Math.round(chars / ok) : 0, last_ok, last_at })),
    scouting: readJsonl('scouting.jsonl').reverse().slice(0, 30).map(({ sample, ...s }) => s),
    scripts: loadScripts().map((s) => ({ ...s, last: lastSignals[s.id] || null })),
    news: readJsonl('news.jsonl').slice(-80).reverse().map(({ title, at, query, link }) => ({ title, at, query, link })),
    collected: m ? { at: m.at, vix: m.cross?.VIX?.last ?? null, cross: Object.fromEntries(Object.entries(m.cross || {}).filter(([k]) => k !== 'VIX')),
      explored: m.explored.map(({ label, kind, url, text }) => ({ label, kind, url, chars: text.length, excerpt: text.slice(0, 280) })), failed: m.failed } : prev.collected,
  }));
}

function clearWork() { fs.rmSync(P('work'), { recursive: true, force: true }); }
const phase = () => readJson('work/phase.json', {});
const setPhase = (o) => { fs.mkdirSync(P('work'), { recursive: true }); writeJson('work/phase.json', o); };
const loadM = () => readJson('work/m.json', null);

function dropStaleWork() {
  try { if (Date.now() - fs.statSync(P('work/phase.json')).mtimeMs > 30 * 60_000) { log('stale work dropped', JSON.stringify(phase())); clearWork(); } } catch {}
}

async function runPhases() {
  const ph = phase();
  const strategy = loadStrategy();
  if (!ph.step) {
    const m = await fetchMarket(strategy);
    fs.mkdirSync(P('work'), { recursive: true });
    writeJson('work/m.json', m);
    writeJson('last_m.json', m);
    archiveNews(m);
    const rp = reparse();
    if (rp) log('reparsed', rp);
    log('scored', score(m), 'scouted', m.scouted ? `${m.scouted.label} ok=${m.scouted.ok} chars=${m.scouted.chars}` : '-');
    if (process.env.SNP_SKIP_ASK === '1') { exportPublic(report(), m); clearWork(); return 0; }
    const st = readJson('state.json', { next: 0, evolve_next: 0 });
    const provider = pickProvider(st.next) || PROVIDERS[st.next % PROVIDERS.length];
    writeJson('state.json', { ...st, next: PROVIDERS.indexOf(provider) + 1 });
    const scripts = activeScripts();
    setPhase({ step: 'predict', provider });
    if (scripts.length) { queueSandbox(m, scripts.map((s) => ({ id: s.id, code: s.code }))); return SANDBOX; }
    return runPhases();
  }
  const m = loadM();
  if (ph.step === 'predict') {
    const sb = sandboxResults();
    const signals = {};
    const script_errors = {};
    for (const [id, r] of Object.entries(sb)) { const sig = r.ok ? signalOf(r.result) : null; if (sig) signals[id] = sig; else script_errors[id] = r.error || 'invalid output'; }
    const snap = snapshot(m);
    const rec = { id: `${now.toISOString().replace(/[:.]/g, '')}-${ph.provider}`, at: m.at, provider: ph.provider, strategy_version: strategy.version, snapshot: snap, signals, script_errors };
    if (!Object.values(snap.assets).some((x) => x.last)) { log('no market snapshot, skip ask'); exportPublic(report(), m); clearWork(); return 0; }
    const prompt = buildPrompt(snap, m, strategy, signals, readJson('report.json', {}).scripts || {});
    rec.prompt_chars = prompt.length;
    const t0 = Date.now();
    try {
      const r = await ask(ph.provider, prompt);
      rec.ms = Date.now() - t0; rec.chat_id = r.chat_id; rec.served_by = r.provider;
      const code = scriptRequest(r.answer);
      if (code) {
        rec.analysis = { code, asked_at: new Date().toISOString() };
        writeJson('work/rec.json', rec);
        setPhase({ step: 'followup', provider: ph.provider });
        queueSandbox(m, [{ id: 'analysis', code }]);
        log('analysis script requested', ph.provider, code.length, 'chars');
        return SANDBOX;
      }
      rec.answer = String(r.answer).slice(0, 4000);
      rec.parsed = parseAnswer(r.answer) || await repairAsk(rec);
    } catch (e) {
      Object.assign(rec, { error: String(e.message).slice(0, 300), parsed: null, ms: Date.now() - t0 });
      const tried = [...(ph.tried || []), ph.provider];
      const fb = tried.length < 2 ? pickProvider(PROVIDERS.indexOf(ph.provider) + 1, tried) : null;
      if (fb) {
        appendJsonl('preds.jsonl', rec);
        log('asked', rec.provider, 'FAILED', rec.error.replace(/\s+/g, ' ').slice(0, 120), '-> fallback', fb);
        writeJson('state.json', { ...readJson('state.json', {}), next: PROVIDERS.indexOf(fb) + 1 });
        setPhase({ step: 'predict', provider: fb, tried });
        return runPhases();
      }
    }
    return finalize(rec, m);
  }
  if (ph.step === 'followup') {
    const rec = readJson('work/rec.json', null);
    const r0 = sandboxResults().analysis || { ok: false, error: 'sandbox produced no result' };
    Object.assign(rec.analysis, { ok: r0.ok, ms: r0.ms, result: r0.result, error: r0.error });
    const out = r0.ok ? JSON.stringify(r0.result).slice(0, 6000) : `ERROR: ${r0.error}`;
    const t0 = Date.now();
    try {
      const r = await ask(ph.provider, `Script output:\n${out}\n\nNow reply with ONLY the final prediction JSON in the format given earlier, inside a \`\`\`json code block (no further script runs).`, { chat_id: rec.chat_id });
      rec.ms += Date.now() - t0;
      rec.answer = String(r.answer).slice(0, 4000);
      rec.parsed = parseAnswer(r.answer) || await repairAsk(rec);
    } catch (e) { Object.assign(rec, { error: String(e.message).slice(0, 300), parsed: null }); }
    return finalize(rec, m);
  }
  if (ph.step === 'validate') {
    const rec = readJson('work/rec.json', null);
    const r0 = sandboxResults().candidate;
    const sig = r0?.ok ? signalOf(r0.result) : null;
    if (sig) { rec.new_script_id = addScript(rec.parsed.new_script, `suggest:${rec.provider}`); rec.new_script_ok = true; }
    else {
      rec.new_script_id = rec.parsed.new_script.id; rec.new_script_ok = false; rec.new_script_why = r0?.error || 'output had no valid p_up values';
      appendJsonl('script_events.jsonl', { at: now.toISOString(), event: 'rejected', id: rec.new_script_id, author: `suggest:${rec.provider}`, why: rec.new_script_why, output: r0?.ok ? JSON.stringify(r0.result).slice(0, 300) : undefined, code: rec.parsed.new_script.code.slice(0, 3000) });
    }
    return finalize(rec, m, true);
  }
  log('unknown phase', JSON.stringify(ph)); clearWork(); return 0;
}

function finalize(rec, m, validated = false) {
  if (!validated && rec.parsed?.new_script) {
    writeJson('work/rec.json', rec);
    setPhase({ step: 'validate', provider: rec.provider });
    queueSandbox(m, [{ id: 'candidate', code: rec.parsed.new_script.code }]);
    return SANDBOX;
  }
  appendJsonl('preds.jsonl', rec);
  if (rec.parsed?.suggest_source) addCandidate(rec.parsed.suggest_source.label, rec.parsed.suggest_source.url, `suggest:${rec.provider}`);
  log('asked', rec.provider, rec.analysis ? `[script ${rec.analysis.ok ? 'ok' : 'fail'}]` : '', rec.parsed ? JSON.stringify(rec.parsed.assets).slice(0, 260) : `UNPARSED ${rec.error || String(rec.answer).slice(0, 160)}`, rec.new_script_id ? `new_script=${rec.new_script_id}:${rec.new_script_ok}` : '');
  exportPublic(report(), m);
  clearWork();
  return 0;
}

async function evolvePhases() {
  const ph = phase();
  if (ph.step === 'evolve_validate') {
    const pend = readJson('work/evolve.json', null);
    const sb = sandboxResults();
    const added = [];
    const rejected = [];
    for (const s of pend.add) { const r = sb[`add_${s.id}`]; if (r?.ok && signalOf(r.result)) added.push(addScript(s, `evolve:${pend.provider}`)); else rejected.push({ id: s.id, why: r?.error || 'no valid p_up', output: r?.ok ? JSON.stringify(r.result).slice(0, 300) : undefined, code: s.code.slice(0, 3000) }); }
    appendJsonl('script_events.jsonl', { at: now.toISOString(), event: 'evolve', provider: pend.provider, added, rejected, retired: pend.retired });
    rejected.forEach((x) => { delete x.code; delete x.output; });
    if (pend.entry) { pend.entry.scripts = { added, rejected, retired: pend.retired }; appendJsonl('evolutions.jsonl', pend.entry); }
    exportPublic(report(), null);
    clearWork();
    return 0;
  }
  const cur = loadStrategy();
  const rep = report();
  const preds = Object.fromEntries(readJsonl('preds.jsonl').map((p) => [p.id, p]));
  const recent = readJsonl('scores.jsonl').filter((s) => s.status === 'scored' && !s.script).slice(-40)
    .map((s) => ({ at: s.at.slice(0, 16), asset: s.asset, horizon: s.horizon, provider: s.provider, v: s.strategy_version, dir: s.dir, p_up: s.p_up, outcome: s.outcome_up ? 'up' : 'down', hit: s.hit, reason: preds[s.id]?.parsed?.reason }));
  if (recent.length < 10) { log('evolve: too few scored predictions', recent.length); appendJsonl('evolutions.jsonl', { at: now.toISOString(), adopted: false, why: `only ${recent.length} scored predictions` }); exportPublic(rep, null); return 0; }
  const st = readJson('state.json', { next: 0, evolve_next: 0 });
  const provider = pickProvider(st.evolve_next || 0) || PROVIDERS[(st.evolve_next || 0) % PROVIDERS.length];
  writeJson('state.json', { ...st, evolve_next: PROVIDERS.indexOf(provider) + 1 });
  const scripts = activeScripts();
  const prompt = [
    `You maintain an automated system that predicts, every hour, the 1-hour-ahead direction and the next-close direction of five markets: ${ASSETS.map((a) => `${a.key} = ${a.name}`).join('; ')}. Each hour a browser reads the pages and Google News queries in the playbook, quantitative signal scripts run in a sandbox, and an LLM predicts using all of it plus the playbook guidance. Improve accuracy by revising the playbook AND the signal scripts.`,
    ``,
    `Current playbook (JSON):`, JSON.stringify({ sources: cur.sources, queries: cur.queries, articles_per_query: cur.articles_per_query, guidance: cur.guidance }, null, 1),
    ``,
    `LLM scoreboard (hit = direction correct; Brier lower is better; always_up_hit and momentum_hit are naive baselines):`, JSON.stringify({ pooled: rep.pooled, assets: rep.assets, by_strategy: rep.by_strategy, with_analysis_script: rep.with_analysis }),
    ``,
    `Active signal scripts with their own scored record:`,
    ...scripts.map((s) => `### ${s.id} (by ${s.author}) — ${s.description}\nrecord: ${JSON.stringify({ h1: rep.scripts[s.id]?.h1, close: rep.scripts[s.id]?.close })}\n\`\`\`js\n${s.code.slice(0, 1800)}\n\`\`\``),
    ``,
    SCRIPT_API,
    `Signal scripts must return { <asset>: { h1: p_up, close: p_up } } with p_up in [0,1]; 0.5 or omitted = abstain.`,
    ``,
    `Current sources, reliability over the last 48 runs (ok = page read with >=200 chars):`, JSON.stringify(sourceStats()),
    ``,
    `Scouted candidate pages not yet in the playbook (ok/tries, average readable chars). You may promote any of these, or propose new public pages:`, JSON.stringify(candidateStats()),
    ``,
    `Most recent scored LLM predictions with the predictor's stated reason:`, ...recent.map((r) => JSON.stringify(r)),
    ``,
    `Rules: sources must be public web pages (no login, no paywall) with market-relevant text for these five markets; at most 7 sources and 6 news queries; articles_per_query 1-2; guidance at most 1000 characters, concrete and testable, can be per-asset, can tell the predictor how to weigh specific scripts. Retire scripts only with enough scored evidence; add at most 2 scripts. Do not overfit to a handful of outcomes.`,
    `Reply with ONLY this JSON inside a single \`\`\`json code block:`,
    `{"sources":[{"label":"...","url":"https://...","max":1200}],"queries":["..."],"articles_per_query":1,"guidance":"...","changelog":"what you changed and why, one or two sentences","new_candidates":[{"label":"...","url":"https://..."}],"scripts":{"add":[{"id":"snake_case","description":"...","code":"<function body>"}],"retire":["script_id"]}}`,
  ].join('\n');
  let prop;
  try { const r = await ask(provider, prompt, { timeout_s: 300 }); prop = firstJson(r.answer); }
  catch (e) { log('evolve ask failed', provider, e.message); appendJsonl('evolutions.jsonl', { at: now.toISOString(), provider, adopted: false, why: e.message.slice(0, 200) }); exportPublic(rep, null); return 0; }
  if (!prop || !Array.isArray(prop.sources) || typeof prop.guidance !== 'string') {
    appendJsonl('evolutions.jsonl', { at: now.toISOString(), provider, adopted: false, why: 'unparseable proposal' }); exportPublic(rep, null); return 0;
  }
  for (const c of Array.isArray(prop.new_candidates) ? prop.new_candidates.slice(0, 5) : []) addCandidate(c?.label, c?.url, `evolve:${provider}`);
  const cand = prop.sources.filter((s) => s && /^https?:\/\//.test(s.url)).slice(0, 7)
    .map((s) => ({ label: String(s.label || s.url).slice(0, 60), url: s.url, max: Math.min(Math.max(Number(s.max) || 1200, 400), 2000) }));
  const checked = await withBrowser(async (ctx) => {
    const ok = [];
    for (const s of cand) {
      try { const r = await readPage(ctx, s.url, { max: s.max, wait: 3500 }); if (r.text.length >= 200) ok.push(s); else log('evolve reject thin', s.url, r.text.length); }
      catch (e) { log('evolve reject', s.url, e.message.slice(0, 80)); }
    }
    return ok;
  });
  const queries = (Array.isArray(prop.queries) ? prop.queries : []).map((q) => String(q).slice(0, 80)).filter(Boolean).slice(0, 6);
  let entry;
  if (checked.length < 2 || !queries.length) entry = { at: now.toISOString(), provider, adopted: false, why: `only ${checked.length} reachable sources / ${queries.length} queries` };
  else {
    const next = {
      version: cur.version + 1, created_at: now.toISOString(), author: provider,
      sources: checked, queries, articles_per_query: Math.min(Math.max(Number(prop.articles_per_query) || 1, 1), 2),
      guidance: prop.guidance.slice(0, 1000), changelog: String(prop.changelog || '').slice(0, 400),
      rejected_sources: cand.filter((c) => !checked.includes(c)).map((c) => c.url),
    };
    writeJson('strategy.json', next);
    appendJsonl('strategies.jsonl', next);
    entry = { at: now.toISOString(), provider, adopted: true, version: next.version, changelog: next.changelog };
    log('evolved to v' + next.version, provider, next.changelog);
  }
  const retireIds = Array.isArray(prop.scripts?.retire) ? prop.scripts.retire.map(String) : [];
  const all = loadScripts();
  const retired = [];
  for (const s of all) if (s.status === 'active' && retireIds.includes(s.id)) { s.status = 'retired'; s.retired_at = now.toISOString(); s.retired_why = `evolve:${provider}`; retired.push(s.id); }
  writeJson('scripts.json', all);
  const add = (Array.isArray(prop.scripts?.add) ? prop.scripts.add : []).filter((s) => s?.code && typeof s.code === 'string').slice(0, 2)
    .map((s) => ({ id: String(s.id || 'script').replace(/[^a-z0-9_]/gi, '_').slice(0, 40).toLowerCase(), description: String(s.description || '').slice(0, 300), code: normCode(s.code.slice(0, 12000)) }));
  if (add.length) {
    const m = readJson('last_m.json', null);
    if (m) {
      writeJson('work/evolve.json', { provider, add, retired, entry });
      setPhase({ step: 'evolve_validate' });
      queueSandbox(m, add.map((s) => ({ id: `add_${s.id}`, code: s.code })));
      return SANDBOX;
    }
  }
  entry.scripts = { added: [], rejected: add.map((s) => ({ id: s.id, why: 'no data snapshot to validate on' })), retired };
  appendJsonl('evolutions.jsonl', entry);
  exportPublic(report(), null);
  return 0;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  loadStrategy(); loadCandidates(); loadScripts(); dropStaleWork();
  if (MODE === 'report') { exportPublic(report(), readJson('last_m.json', null)); return 0; }
  if (MODE === 'evolve') return evolvePhases();
  if (MODE === 'dry') {
    const m = await fetchMarket(loadStrategy(), { withScout: false });
    const pr = buildPrompt(snapshot(m), m, loadStrategy(), {}, {});
    console.log(pr); console.log('PROMPT_CHARS', pr.length);
    return 0;
  }
  return runPhases();
}

main().then((code) => process.exit(code || 0)).catch((e) => { log('FATAL', e.stack || e.message); try { clearWork(); } catch {} process.exit(1); });
