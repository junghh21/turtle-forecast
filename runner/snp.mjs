import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';

const DIR = process.env.SNP_DIR || '/snp';
const PROVIDERS = (process.env.SNP_PROVIDERS || 'gemini,qwen,deepseek,kimi,grok').split(',');
const ADVISOR = process.env.ADVISOR_URL || 'http://192.168.75.225:8765';
const SECRET = process.env.ADVISOR_SECRET || '';
const MODE = process.argv[2] || 'run';
const now = new Date();

const ASSETS = [
  { key: 'spx', name: 'S&P 500', h1: 'ES=F', h1_name: 'E-mini S&P 500 futures (ES=F)', daily: '^GSPC', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'ndx', name: 'Nasdaq Composite', h1: 'NQ=F', h1_name: 'E-mini Nasdaq-100 futures (NQ=F)', daily: '^IXIC', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'tlt', name: 'TLT (iShares 20+Y Treasury ETF)', h1: 'TLT', h1_name: 'TLT', daily: 'TLT', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'boil', name: 'BOIL (ProShares Ultra 2x Natural Gas ETF)', h1: 'BOIL', h1_name: 'BOIL', daily: 'BOIL', tz: 'America/New_York', open: 570, close: 960 },
  { key: 'kospi', name: 'KOSPI', h1: '^KS11', h1_name: 'KOSPI index (^KS11)', daily: '^KS11', tz: 'Asia/Seoul', open: 540, close: 930 },
];

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

const P = (f) => `${DIR}/${f}`;
const readJsonl = (f) => fs.existsSync(P(f)) ? fs.readFileSync(P(f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const appendJsonl = (f, o) => fs.appendFileSync(P(f), JSON.stringify(o) + '\n');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(P(f), 'utf8')); } catch { return d; } };
const writeJson = (f, o) => fs.writeFileSync(P(f), JSON.stringify(o, null, 1));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const squash = (t) => String(t || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const BOILER = /newsletter|sign up|privacy|cookie|terms of|all rights reserved|news tip|get in touch|subscribe|advertis|delivered to your inbox/i;

function loadStrategy() {
  const s = readJson('strategy.json', null);
  if (s) return s;
  writeJson('strategy.json', DEFAULT_STRATEGY);
  appendJsonl('strategies.jsonl', DEFAULT_STRATEGY);
  return DEFAULT_STRATEGY;
}

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
    .map((m) => ({ title: m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), link: m[2], at: new Date(m[3]), query: q }))
    .filter((a) => a.at <= now).sort((a, b) => b.at - a.at).slice(0, n);
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
  const strat = loadStrategy();
  const norm = (u) => u.replace(/\/+$/, '');
  if (c.some((x) => norm(x.url) === norm(url)) || strat.sources.some((s) => norm(s.url) === norm(url))) return false;
  c.push({ label: String(label || url).slice(0, 60), url, origin, tries: 0, ok: 0, chars: 0, added_at: now.toISOString() });
  writeJson('candidates.json', c.slice(-80));
  return true;
}

async function scout(ctx, strategy) {
  const inUse = new Set(strategy.sources.map((s) => s.url.replace(/\/+$/, '')));
  const c = loadCandidates();
  const pick = c.filter((x) => !inUse.has(x.url.replace(/\/+$/, '')) && x.tries < 6)
    .sort((a, b) => a.tries - b.tries || (a.last_at || '').localeCompare(b.last_at || ''))[0];
  if (!pick) return null;
  const res = { label: pick.label, url: pick.url, at: now.toISOString() };
  try {
    const r = await readPage(ctx, pick.url, { max: 1500, wait: 4000 });
    Object.assign(res, { ok: r.text.length >= 200, chars: r.text.length, title: r.title, sample: r.text.slice(0, 240) });
  } catch (e) { Object.assign(res, { ok: false, chars: 0, why: e.message.slice(0, 100) }); }
  pick.tries++; pick.last_at = res.at; pick.last_ok = res.ok;
  if (res.ok) { pick.ok++; pick.chars += res.chars; }
  writeJson('candidates.json', c);
  appendJsonl('scouting.jsonl', res);
  return res;
}

async function fetchMarket(strategy) {
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
      try { bars[a.key] = { h1: await chart(a.h1, '5m', '5d'), daily: await chart(a.daily, '1d', '3mo') }; }
      catch (e) { log('bars failed', a.key, e.message); bars[a.key] = { h1: [], daily: [] }; }
    }
    const vix = await chart('^VIX', '1d', '1mo').catch(() => []);
    const cross = {};
    for (const [k, s] of [['US 10Y yield', '^TNX'], ['Dollar index', 'DX-Y.NYB'], ['USD/KRW', 'KRW=X'], ['WTI crude', 'CL=F'], ['Henry Hub natural gas futures', 'NG=F'], ['Nikkei 225', '^N225'], ['Euro Stoxx 50', '^STOXX50E']]) {
      try {
        const z = await chart(s, '1d', '5d');
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
    const scouted = MODE === 'dry' ? null : await scout(ctx, strategy).catch((e) => { log('scout failed', e.message); return null; });
    return { bars, vix, cross, news: news.slice(0, 16).map(({ title, at }) => ({ title, at: at.toISOString() })), newsFull: news, explored, failed, scouted };
  });
}

function dailyCloses(daily, a) {
  return daily.map((z) => { const date = tzParts(new Date(z.t * 1000), a.tz).date; return { date, close: z.c, closeAt: closeUtc(date, a) }; });
}

function assetSnap(m, a) {
  const b = m.bars[a.key] || { h1: [], daily: [] };
  const last = b.h1.filter((z) => z.t * 1000 <= now.getTime()).at(-1);
  const hourly = [];
  for (let h = 12; h >= 0; h--) {
    const z = b.h1.filter((y) => y.t * 1000 <= now.getTime() - h * 3600_000).at(-1);
    if (z && !hourly.some((x) => x.t === z.t)) hourly.push({ t: z.t, at: new Date(z.t * 1000).toISOString(), c: z.c });
  }
  const closes = dailyCloses(b.daily, a).filter((d) => d.closeAt.getTime() + 30 * 60_000 <= now.getTime());
  return {
    last: last ? { at: new Date(last.t * 1000).toISOString(), price: last.c, live: now.getTime() - last.t * 1000 < 15 * 60_000 } : null,
    hour_ago: hourly.find((x) => x.t * 1000 <= now.getTime() - 3600_000 && x.t * 1000 > now.getTime() - 3 * 3600_000)?.c ?? null,
    hourly: hourly.map(({ at, c }) => ({ at, c })),
    closes: closes.slice(-10).map(({ date, close }) => ({ date, close })),
    in_session: inSession(now, a),
  };
}

function snapshot(m) {
  return {
    assets: Object.fromEntries(ASSETS.map((a) => [a.key, assetSnap(m, a)])),
    vix: m.vix.at(-1)?.c ?? null,
    cross: m.cross,
    news: m.news,
    explored: m.explored.map(({ label, kind, url, text }) => ({ label, kind, url, chars: text.length })),
    failed: m.failed,
    scouted: m.scouted ? { label: m.scouted.label, url: m.scouted.url, ok: m.scouted.ok, chars: m.scouted.chars } : null,
  };
}

const fmt = (x) => (x == null ? 'n/a' : Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(3));

function buildPrompt(s, m, strategy) {
  const et = etParts(now);
  const kst = tzParts(now, 'Asia/Seoul');
  const hm = (e) => `${String(Math.floor(e.hm / 60)).padStart(2, '0')}:${String(e.hm % 60).padStart(2, '0')}`;
  const lines = [
    `Current time: ${now.toISOString()} (New York ${et.date} ${hm(et)} ${et.wd}; Seoul ${kst.date} ${hm(kst)}).`,
    `Everything below was fetched just now by a browser from Yahoo Finance, Google News and the linked pages. Use it; do not invent other figures.`,
    ``,
  ];
  for (const a of ASSETS) {
    const x = s.assets[a.key];
    lines.push(`## ${a.key} — ${a.name}`);
    lines.push(`1h instrument ${a.h1_name}: last ${fmt(x.last?.price)} at ${x.last?.at || 'n/a'}${x.last?.live ? '' : ' (NOT trading now — es_1h-style prediction will not be scored)'}`);
    if (x.hourly.length) lines.push(`hourly closes (UTC): ${x.hourly.map((h) => `${h.at.slice(5, 16)} ${fmt(h.c)}`).join('; ')}`);
    lines.push(`last regular closes of ${a.daily}: ${x.closes.map((d) => `${d.date} ${fmt(d.close)}`).join('; ')}`);
  }
  lines.push(``, `VIX last: ${s.vix}`);
  lines.push(`Cross-asset (last daily value, change vs previous): ${Object.entries(s.cross || {}).map(([k, v]) => `${k} ${v.last} (${v.chg_pct >= 0 ? '+' : ''}${v.chg_pct}%)`).join('; ')}`);
  lines.push(`Headlines (newest first):`, ...s.news.map((n) => `- [${n.at.slice(0, 16)}Z] ${n.title}`));
  lines.push(``, `Pages read just now (excerpts):`, ...m.explored.map((e) => `### ${e.label}\n${e.text}`));
  lines.push(``, `Analyst playbook v${strategy.version} (revised from scored past predictions):`, strategy.guidance, ``);
  lines.push(`For EACH asset key (${ASSETS.map((a) => a.key).join(', ')}) predict:`);
  lines.push(`- "1h": will the 1h instrument be HIGHER or LOWER exactly 60 minutes from now than its last price shown?`);
  lines.push(`- "close": will the NEXT regular-session close of the daily symbol (the first close after the current time) be HIGHER or LOWER than the last close shown?`);
  lines.push(``, `Reply with ONLY this JSON, nothing else:`);
  lines.push(`{"spx":{"1h":{"dir":"up|down","p_up":0.00},"close":{"dir":"up|down","p_up":0.00}},"ndx":{...},"tlt":{...},"boil":{...},"kospi":{...},"reason":"one or two short sentences","suggest_source":{"label":"...","url":"https://..."}}`);
  lines.push(`p_up is your probability (0 to 1) that the price ends higher; dir must agree with p_up. suggest_source (optional) is one public web page, not already listed above, that would most improve these predictions.`);
  return lines.join('\n');
}

function ask(provider, prompt, timeout_s = 240) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ provider, prompt, timeout_s });
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

const firstJson = (text) => { const m = String(text).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

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
  return Object.keys(out.assets).length ? out : null;
}

function score(m) {
  const preds = readJsonl('preds.jsonl');
  const done = new Set(readJsonl('scores.jsonl').map((s) => `${s.id}:${s.asset}:${s.horizon}`));
  let n = 0;
  for (const pr of preds) {
    if (!pr.parsed?.assets) continue;
    const t0 = new Date(pr.at).getTime();
    for (const a of ASSETS) {
      const pa = pr.parsed.assets[a.key];
      const sa = pr.snapshot.assets?.[a.key];
      if (!pa || !sa) continue;
      const b = m.bars[a.key] || { h1: [], daily: [] };
      const base = { id: pr.id, asset: a.key, provider: pr.provider, strategy_version: pr.strategy_version, at: pr.at, scored_at: now.toISOString() };
      if (pa.h1 && sa.last?.live && !done.has(`${pr.id}:${a.key}:1h`)) {
        const tgt = t0 + 3600_000;
        if (now.getTime() >= tgt + 10 * 60_000 && b.h1.length && b.h1[0].t * 1000 <= tgt) {
          const z = b.h1.filter((y) => y.t * 1000 <= tgt).at(-1);
          const px = sa.last.price;
          const rec = { ...base, horizon: '1h' };
          if (!z || tgt - z.t * 1000 > 10 * 60_000) rec.status = 'no_target_bar';
          else if (z.c === px) Object.assign(rec, { status: 'tie' });
          else {
            const up = z.c > px;
            Object.assign(rec, { status: 'scored', base: px, target: z.c, target_at: new Date(z.t * 1000).toISOString(), outcome_up: up,
              dir: pa.h1.dir, p_up: pa.h1.p_up, hit: (pa.h1.dir === 'up') === up,
              momentum_hit: sa.hour_ago != null && px !== sa.hour_ago ? (px > sa.hour_ago) === up : null });
          }
          appendJsonl('scores.jsonl', rec); n++;
        }
      }
      if (pa.close && !done.has(`${pr.id}:${a.key}:close`)) {
        const tgt = dailyCloses(b.daily, a).find((d) => d.closeAt.getTime() > t0);
        if (tgt && now.getTime() >= tgt.closeAt.getTime() + 60 * 60_000) {
          const ref = sa.closes.at(-1);
          const rec = { ...base, horizon: 'close', in_session: sa.in_session };
          if (!ref) rec.status = 'no_base';
          else if (tgt.close === ref.close) rec.status = 'tie';
          else {
            const up = tgt.close > ref.close;
            Object.assign(rec, { status: 'scored', base_date: ref.date, base: ref.close, target_date: tgt.date, target: tgt.close, outcome_up: up,
              dir: pa.close.dir, p_up: pa.close.p_up, hit: (pa.close.dir === 'up') === up });
          }
          appendJsonl('scores.jsonl', rec); n++;
        }
      }
    }
  }
  return n;
}

function archiveNews(m) {
  const seen = new Set(readJsonl('news.jsonl').slice(-2000).map((n) => n.title));
  for (const n of m.newsFull || []) {
    if (seen.has(n.title)) continue;
    seen.add(n.title);
    appendJsonl('news.jsonl', { title: n.title, at: n.at.toISOString(), query: n.query, link: n.link, seen_at: now.toISOString() });
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
  return o;
}

function report() {
  const S = readJsonl('scores.jsonl').filter((s) => s.status === 'scored');
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
  const out = {
    as_of: now.toISOString(), predictions: preds.length, parsed: preds.filter((p) => p.parsed).length,
    pooled: { h1: summarize(h1), close: summarize(cl) },
    assets,
    by_provider: Object.fromEntries(PROVIDERS.map((p) => [p, { h1: summarize(h1.filter((r) => r.provider === p)), close: summarize(cl.filter((r) => r.provider === p)) }])),
    by_strategy: Object.fromEntries(versions.map((v) => [v, { h1: summarize(h1.filter((r) => r.strategy_version === v)), close: summarize(cl.filter((r) => r.strategy_version === v)) }])),
    close_in_session_secondary: summarize(S.filter((s) => s.horizon === 'close' && s.in_session)),
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

async function evolve() {
  const cur = loadStrategy();
  const rep = report();
  const preds = Object.fromEntries(readJsonl('preds.jsonl').map((p) => [p.id, p]));
  const recent = readJsonl('scores.jsonl').filter((s) => s.status === 'scored').slice(-40)
    .map((s) => ({ at: s.at.slice(0, 16), asset: s.asset, horizon: s.horizon, provider: s.provider, v: s.strategy_version, dir: s.dir, p_up: s.p_up, outcome: s.outcome_up ? 'up' : 'down', hit: s.hit, reason: preds[s.id]?.parsed?.reason }));
  if (recent.length < 10) { log('evolve: too few scored predictions', recent.length); appendJsonl('evolutions.jsonl', { at: now.toISOString(), adopted: false, why: `only ${recent.length} scored predictions` }); return; }
  const st = readJson('state.json', { next: 0, evolve_next: 0 });
  const provider = PROVIDERS[(st.evolve_next || 0) % PROVIDERS.length];
  writeJson('state.json', { ...st, evolve_next: (st.evolve_next || 0) + 1 });
  const prompt = [
    `You maintain the information-gathering and reasoning playbook of an automated system that predicts, every hour, the 1-hour-ahead direction and the next-close direction of five markets: ${ASSETS.map((a) => `${a.key} = ${a.name}`).join('; ')}. Each hour a browser reads the pages and Google News queries in the playbook, and an LLM predicts using the playbook guidance. Revise the playbook to improve accuracy.`,
    ``,
    `Current playbook (JSON):`, JSON.stringify({ sources: cur.sources, queries: cur.queries, articles_per_query: cur.articles_per_query, guidance: cur.guidance }, null, 1),
    ``,
    `Scoreboard (hit = direction correct; Brier lower is better; always_up_hit and momentum_hit are naive baselines):`, JSON.stringify({ pooled: rep.pooled, assets: rep.assets, by_strategy: rep.by_strategy }),
    ``,
    `Current sources, reliability over the last 48 runs (ok = page read with >=200 chars):`, JSON.stringify(sourceStats()),
    ``,
    `Scouted candidate pages not yet in the playbook (each tried by the same browser; ok/tries and average readable chars). You may promote any of these, or propose new public pages:`, JSON.stringify(candidateStats()),
    ``,
    `Most recent scored predictions with the predictor's stated reason:`, ...recent.map((r) => JSON.stringify(r)),
    ``,
    `Rules: sources must be public web pages (no login, no paywall) with market-relevant text for these five markets; at most 7 sources and 6 news queries; articles_per_query 1-2; guidance at most 1000 characters, concrete and testable, can be per-asset, no claims of certainty. Drop sources that fail or add little. Do not overfit to a handful of outcomes.`,
    `Reply with ONLY this JSON:`,
    `{"sources":[{"label":"...","url":"https://...","max":1200}],"queries":["..."],"articles_per_query":1,"guidance":"...","changelog":"what you changed and why, one or two sentences","new_candidates":[{"label":"...","url":"https://..."}]}`,
  ].join('\n');
  let prop;
  try { const r = await ask(provider, prompt, 300); prop = firstJson(r.answer); }
  catch (e) { log('evolve ask failed', provider, e.message); appendJsonl('evolutions.jsonl', { at: now.toISOString(), provider, adopted: false, why: e.message.slice(0, 200) }); return; }
  if (!prop || !Array.isArray(prop.sources) || typeof prop.guidance !== 'string') {
    appendJsonl('evolutions.jsonl', { at: now.toISOString(), provider, adopted: false, why: 'unparseable proposal' }); return;
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
  if (checked.length < 2 || !queries.length) {
    appendJsonl('evolutions.jsonl', { at: now.toISOString(), provider, adopted: false, why: `only ${checked.length} reachable sources / ${queries.length} queries` });
    return;
  }
  const next = {
    version: cur.version + 1, created_at: now.toISOString(), author: provider,
    sources: checked, queries, articles_per_query: Math.min(Math.max(Number(prop.articles_per_query) || 1, 1), 2),
    guidance: prop.guidance.slice(0, 1000), changelog: String(prop.changelog || '').slice(0, 400),
    rejected_sources: cand.filter((c) => !checked.includes(c)).map((c) => c.url),
  };
  writeJson('strategy.json', next);
  appendJsonl('strategies.jsonl', next);
  appendJsonl('evolutions.jsonl', { at: now.toISOString(), provider, adopted: true, version: next.version, changelog: next.changelog });
  log('evolved to v' + next.version, provider, next.changelog);
}

function exportPublic(rep, m) {
  if (!fs.existsSync(P('site'))) return;
  const site = P('site/data');
  fs.mkdirSync(site, { recursive: true });
  const byId = {};
  for (const s of readJsonl('scores.jsonl')) ((byId[s.id] ||= {})[s.asset] ||= {})[s.horizon] = s.status === 'scored' ? { hit: s.hit, outcome_up: s.outcome_up, target: s.target } : { status: s.status };
  const preds = readJsonl('preds.jsonl').slice(-240).reverse().map((p) => ({
    id: p.id, at: p.at, provider: p.provider, strategy_version: p.strategy_version, ms: p.ms,
    assets: Object.fromEntries(ASSETS.map((a) => { const x = p.snapshot.assets?.[a.key]; return [a.key, x ? { last: x.last, ref: x.closes.at(-1), in_session: x.in_session } : null]; })),
    sources: (p.snapshot.explored || []).map(({ label, url }) => ({ label, url })), headlines: (p.snapshot.news || []).slice(0, 6), scouted: p.snapshot.scouted,
    parsed: p.parsed, failed: p.parsed ? undefined : (p.error ? 'error' : 'unparsed'), result: byId[p.id] || {},
  }));
  const prev = readJson('site/data/latest.json', {});
  const series = m ? Object.fromEntries(ASSETS.map((a) => [a.key, (m.bars[a.key]?.h1 || []).filter((z) => z.t * 1000 >= now.getTime() - 72 * 3600_000).filter((_, k, arr) => k % 3 === 0 || k === arr.length - 1).map((z) => [z.t, +z.c.toFixed(3)])])) : (prev.series || {});
  const strategies = readJsonl('strategies.jsonl').reverse().map(({ version, created_at, author, sources, queries, articles_per_query, guidance, changelog, rejected_sources }) =>
    ({ version, created_at, author, sources, queries, articles_per_query, guidance, changelog, rejected_sources }));
  fs.writeFileSync(`${site}/latest.json`, JSON.stringify({
    generated_at: now.toISOString(), providers: PROVIDERS, assets: ASSETS.map(({ key, name, h1, daily, tz }) => ({ key, name, h1, daily, tz })),
    report: rep, predictions: preds, series, strategies,
    evolutions: readJsonl('evolutions.jsonl').reverse().slice(0, 40),
    candidates: loadCandidates().map(({ label, url, origin, tries, ok, chars, last_ok, last_at }) => ({ label, url, origin, tries, ok, avg_chars: ok ? Math.round(chars / ok) : 0, last_ok, last_at })),
    scouting: readJsonl('scouting.jsonl').reverse().slice(0, 30).map(({ sample, ...s }) => s),
    news: readJsonl('news.jsonl').slice(-80).reverse().map(({ title, at, query, link }) => ({ title, at, query, link })),
    collected: m ? { at: now.toISOString(), vix: m.vix.at(-1)?.c ?? null, cross: m.cross,
      explored: m.explored.map(({ label, kind, url, text }) => ({ label, kind, url, chars: text.length, excerpt: text.slice(0, 280) })), failed: m.failed } : prev.collected,
  }));
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const strategy = loadStrategy();
  loadCandidates();
  if (MODE === 'report') { const r = report(); exportPublic(r, null); console.log(JSON.stringify(r, null, 1)); return; }
  if (MODE === 'evolve') { await evolve(); exportPublic(report(), null); return; }
  const m = await fetchMarket(strategy);
  if (MODE === 'dry') { const pr = buildPrompt(snapshot(m), m, strategy); console.log(pr); console.log('PROMPT_CHARS', pr.length, 'EXPLORED', m.explored.length, 'FAILED', JSON.stringify(m.failed)); return; }
  archiveNews(m);
  log('scored', score(m), 'scouted', m.scouted ? `${m.scouted.label} ok=${m.scouted.ok} chars=${m.scouted.chars}` : '-');
  if (MODE === 'run' && process.env.SNP_SKIP_ASK !== '1') {
    const st = readJson('state.json', { next: 0, evolve_next: 0 });
    const provider = PROVIDERS[st.next % PROVIDERS.length];
    writeJson('state.json', { ...st, next: st.next + 1 });
    const snap = snapshot(m);
    if (!Object.values(snap.assets).some((x) => x.last)) log('no market snapshot, skip ask');
    else {
      const prompt = buildPrompt(snap, m, strategy);
      const rec = { id: `${now.toISOString().replace(/[:.]/g, '')}-${provider}`, at: now.toISOString(), provider, strategy_version: strategy.version, snapshot: snap, prompt_chars: prompt.length };
      const t0 = Date.now();
      try {
        const r = await ask(provider, prompt);
        Object.assign(rec, { served_by: r.provider, answer: String(r.answer).slice(0, 3000), parsed: parseAnswer(r.answer), ms: Date.now() - t0 });
      } catch (e) { Object.assign(rec, { error: String(e.message).slice(0, 300), parsed: null, ms: Date.now() - t0 }); }
      appendJsonl('preds.jsonl', rec);
      if (rec.parsed?.suggest_source) addCandidate(rec.parsed.suggest_source.label, rec.parsed.suggest_source.url, `suggest:${provider}`);
      log('asked', provider, rec.parsed ? JSON.stringify(rec.parsed.assets).slice(0, 300) : `UNPARSED ${rec.error || String(rec.answer).slice(0, 160)}`);
    }
  }
  exportPublic(report(), m);
}

main().catch((e) => { log('FATAL', e.stack || e.message); process.exit(1); });
