"use strict";
/* TSLA Pulse — sister app of NVDA Pulse. Same architecture, TSLA data model.
   发版规范：GitHub Pages 对无版本号资源缓存极 aggressive，改本文件必须 bump
   index.html 里 app.js 的 ?v= 参数。 */

const NEWS_URL = "data/news.json";
const EARNINGS_URL = "data/earnings.json";
const ROADMAP_URL = "data/roadmap.json";
const FLEET_URL = "data/fleet.json";
const THESIS_URL = "data/thesis.json";
const FIN_URL = "data/financials_annual.json";
const PRICE_URL = "data/price_history.json";
const HIST_URL = "data/company_history.json";
const TARGETS_URL = "data/analyst_targets.json";
const GLOSS_URL = "data/glossary.json";
const SIG_URL = "data/signal_history.json";
const FRESH_URL = "data/freshness.json";
const QUOTE_URL = "data/quote.json";
const ARCH_URL = "data/archive/";
const PEERS_URL = "data/peers.json";
const REFRESH_MS = 5 * 60 * 1000;
const QUOTE_POLL_MS = 30 * 1000;
const QUOTE_MAX_AGE_MS = 12 * 60 * 1000;

let currentScreen = "today";
let currentCat = "全部";
let currentQuery = "";
let cachedNews = null;
let cachedExtra = null;
let liveQuote = null; // latest tick from price tick cron
let searchScope = "recent"; // "recent" | "history"
let historyPool = null;     // deduped archive + recent stories, loaded on demand
let historyLoading = false;
let historyUnavailable = false;
let glossary = [];          // [{term, en, explain}]，按 term 长度降序
let glossaryMap = {};       // 小写 term -> term 对象

/* ---------- 术语表 ----------
   支持两种 shape：{term, en, explain}（NVDA 口径）和 {term, def}（TSLA 口径） */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setGlossary(data) {
  glossary = [];
  glossaryMap = {};
  const terms = (data && data.terms) || [];
  terms.forEach(function (t) {
    if (!t || !t.term) return;
    const explain = t.explain || t.def;
    if (!explain) return;
    const norm = { term: t.term, en: t.en || t.en_name || "", explain: explain };
    glossary.push(norm);
  });
  glossary.sort(function (a, b) { return b.term.length - a.term.length; });
  glossary.forEach(function (t) {
    glossaryMap[t.term.toLowerCase()] = t;
  });
}

// 对已转义的纯文本做术语标注（最长优先、单次替换，避免重复包裹）
function escTag(s) {
  const t = esc(s == null ? "" : s);
  if (!glossary.length) return t;
  const re = new RegExp(
    "(" + glossary.map(function (g) { return escapeRe(g.term); }).join("|") + ")",
    "gi"
  );
  return t.replace(re, function (m) {
    const g = glossaryMap[m.toLowerCase()];
    if (!g) return m;
    return '<span class="term" data-term="' + esc(g.term) + '">' + m + "</span>";
  });
}

function openTermSheet(term) {
  const g = glossaryMap[String(term).toLowerCase()];
  if (!g) return;
  document.getElementById("term-title").textContent =
    g.term + (g.en ? " · " + g.en : "");
  document.getElementById("term-explain").textContent = g.explain;
  document.getElementById("term-backdrop").hidden = false;
  document.getElementById("term-sheet").hidden = false;
  document.body.classList.add("sheet-open");
}

function closeTermSheet() {
  document.getElementById("term-backdrop").hidden = true;
  document.getElementById("term-sheet").hidden = true;
  document.body.classList.remove("sheet-open");
}

function initGlossary() {
  const wrap = document.createElement("div");
  wrap.innerHTML =
    '<div class="term-backdrop" id="term-backdrop" hidden></div>' +
    '<div class="term-sheet" id="term-sheet" hidden role="dialog" aria-modal="true">' +
      '<div class="term-grip"></div>' +
      '<p class="term-title" id="term-title"></p>' +
      '<p class="term-explain" id="term-explain"></p>' +
      '<button class="term-close" id="term-close">知道了</button>' +
    "</div>";
  document.body.appendChild(wrap);
  document.addEventListener("click", function (e) {
    const t = e.target.closest ? e.target.closest(".term") : null;
    if (t) {
      // 术语可能嵌在新闻链接里：拦截跳转，只弹解释
      e.preventDefault();
      e.stopPropagation();
      openTermSheet(t.dataset.term);
      return;
    }
    if (e.target.closest &&
        (e.target.closest("#term-backdrop") || e.target.closest("#term-close"))) {
      closeTermSheet();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeTermSheet();
  });
}

/* ---------- utils ---------- */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (isNaN(then) || diff < 0) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " 小时前";
  const days = Math.floor(hours / 24);
  return days + " 天前";
}

function fmtUpdated(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "未知";
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes())
  );
}

/* 纯日期数学：dateStr "YYYY-MM-DD" -> 距今天（本地午夜）天数 */
function daysUntil(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return null;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function fmtWan(v) {
  // 辆 -> 万辆，保留 2 位小数
  return (v / 10000).toFixed(2);
}

function qShort(q) {
  // "Q3 2026" -> "Q3'26"
  return String(q).replace(/Q(\d)\s+20(\d\d)/, "Q$1'$2");
}

/* ---------- screen routing ---------- */
function showScreen(name, save) {
  currentScreen = name;
  document.querySelectorAll(".screen").forEach((s) => {
    s.hidden = s.dataset.screen !== name;
  });
  document.querySelectorAll("[data-screen].tnav, [data-screen].bnav").forEach((b) => {
    b.classList.toggle("active", b.dataset.screen === name);
  });
  if (save !== false) {
    try { localStorage.setItem("tsla_screen", name); } catch (e) {}
  }
  window.scrollTo(0, 0);
}

const SCREENS = ["today", "news", "track", "start"];

function initNav() {
  document.querySelectorAll("[data-screen].tnav, [data-screen].bnav").forEach((el) => {
    el.addEventListener("click", () => {
      showScreen(el.dataset.screen);
    });
  });
  // 首访：弹出分流浮层，由用户选择，不自动跳转
  if (initFirstVisit()) return;
  let saved = null, home = null;
  try {
    saved = localStorage.getItem("tsla_screen");
    home = localStorage.getItem("tsla_home");
  } catch (e) {}
  // 老用户行为不变：上次 tab 优先；其次用记住的偏好首页
  const target = SCREENS.indexOf(saved) >= 0 ? saved
    : SCREENS.indexOf(home) >= 0 ? home : null;
  if (target) showScreen(target, false);
}

/* ---------- story cards (shared) ---------- */
function badge(s) {
  return s.outlets_count > 1
    ? '<span class="badge">' + s.outlets_count + " 家媒体报道</span>"
    : "";
}

function metaRow(s) {
  const session = s.session
    ? '<span class="session">' + esc(s.session) + "</span>"
    : "";
  return (
    '<div class="card-meta">' +
      "<span>" + esc(s.source) + "</span>" +
      "<span>·</span>" +
      "<span>" + esc(relTime(s.published_at)) + "</span>" +
      session +
      badge(s) +
      reactionTag(s) +
      sentiDot(s) +
    "</div>"
  );
}

function reactionTag(s, big) {
  const pr = s.price_reaction;
  if (!pr || typeof pr.pct !== "number") return "";
  const cls = pr.pct > 0.05 ? "up" : pr.pct < -0.05 ? "down" : "flat";
  const sign = pr.pct > 0 ? "+" : "";
  const win = pr.window_h >= 1.95 ? "2h" : pr.window_h + "h";
  return '<span class="react' + (big ? " big" : "") + " " + cls + '">' +
    "发布后" + win + " " + sign + pr.pct.toFixed(1) + "%</span>";
}

function sentiDot(s) {
  if (typeof s.sentiment !== "number") return "";
  const label = s.sentiment > 0 ? "利多" : s.sentiment < 0 ? "利空" : "中性";
  const cls = s.sentiment > 0 ? "up" : s.sentiment < 0 ? "down" : "flat";
  return '<span class="senti ' + cls + '">' + label + "</span>";
}

function summaryRow(s) {
  return s.zh_summary
    ? '<p class="card-summary">' + escTag(s.zh_summary) + "</p>"
    : "";
}

function titleHtml(s) {
  if (s.title_zh) {
    return '<h2 class="card-title">' + escTag(s.title_zh) + "</h2>" +
      '<p class="card-title-en">' + escTag(s.title) + "</p>";
  }
  return '<h2 class="card-title">' + escTag(s.title) + "</h2>";
}

const ACTION_BADGE_CLASS = { "上调": "up", "下调": "down" };

function analystCard(s) {
  const a = s.analyst;
  const cls = ACTION_BADGE_CLASS[a.action] || "flat";
  const targetRow = a.target
    ? '<div class="analyst-target"><span class="target-num num">' +
      esc(a.target) + '</span><span class="target-label">目标价</span></div>'
    : "";
  const ratingRow = a.rating
    ? '<span class="analyst-rating">评级 ' + esc(a.rating) + "</span>"
    : "";
  return (
    '<a class="card analyst-card" href="' + esc(s.url) +
    '" target="_blank" rel="noopener">' +
      '<div class="analyst-head">' +
        '<span class="firm">' + esc(a.firm) + "</span>" +
        '<span class="abadge ' + cls + '">' + esc(a.action) + "</span>" +
        ratingRow +
      "</div>" +
      targetRow +
      titleHtml(s) +
      summaryRow(s) +
      metaRow(s) +
    "</a>"
  );
}

function breakingCard(s) {
  const big = reactionTag(s, true);
  return (
    '<a class="card breaking-card" href="' + esc(s.url) +
    '" target="_blank" rel="noopener">' +
      '<span class="breaking-badge">突发</span>' +
      (big ? '<div class="breaking-react">' + big + "</div>" : "") +
      titleHtml(s) +
      summaryRow(s) +
      metaRow(s) +
    "</a>"
  );
}

function storyCard(s) {
  return (
    '<a class="card" href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
      titleHtml(s) +
      summaryRow(s) +
      metaRow(s) +
    "</a>"
  );
}

/* ---------- 每日涨跌归因（一句话） ----------
   今日涨跌幅 + 当天 price_reaction 最大的 2 条新闻。
   驱动标注为"相关"而非因果：price_reaction 是新闻发布后 2 小时窗口的
   股价变动，用作"最可能相关"的启发式排序，不代表贡献度。 */
function renderAttrLine(market, stories) {
  const el = document.getElementById("attr-line");
  const chg = market && market.change_pct;
  if (typeof chg !== "number") { el.hidden = true; return; }
  let today = "";
  try {
    today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch (e) { el.hidden = true; return; }
  const cands = stories.filter(function (s) {
    return (s.published_at || "").slice(0, 10) === today &&
      s.price_reaction && typeof s.price_reaction.pct === "number";
  }).sort(function (a, b) {
    return Math.abs(b.price_reaction.pct) - Math.abs(a.price_reaction.pct);
  }).slice(0, 2);
  if (!cands.length) { el.hidden = true; return; }
  const up = chg >= 0;
  const drivers = cands.map(function (s) {
    let label = s.zh_summary || s.title_zh || s.title || "";
    if (label.length > 20) label = label.slice(0, 20) + "…";
    return esc(label);
  }).join('<span class="attr-sep">·</span>');
  el.innerHTML = '<span class="attr-chg ' + (up ? "up" : "down") + '">' +
    (up ? "▲" : "▼") + " " + (up ? "+" : "") + chg.toFixed(2) +
    '%</span><span class="attr-sep">·</span><span class="attr-drivers">' +
    drivers + "</span>";
  el.hidden = false;
}

/* ---------- header market line ----------
   特斯拉：交付报告比财报更能驱动股价，顶栏倒计时放交付。 */
function nextDelivery(market) {
  if (!market) return null;
  if (market.next_delivery && market.next_delivery.date) return market.next_delivery;
  const ne = market.next_earnings;
  if (ne && ne.next_delivery && ne.next_delivery.date) return ne.next_delivery;
  return null;
}

function renderMarket(market) {
  const el = document.getElementById("quote-line");
  if (!market) { el.hidden = true; return; }
  let html = "";
  if (typeof market.price === "number") {
    const up = market.change_pct >= 0;
    html += "<strong>$" + market.price.toFixed(2) + "</strong> " +
      '<span class="chg ' + (up ? "up" : "down") + '">' +
      (up ? "▲" : "▼") + " " + (up ? "+" : "") +
      market.change_pct.toFixed(2) + "%</span>";
    if (market._live) {
      html += '<span class="quote-live">· 约2分钟延迟</span>';
    }
  }
  const nd = nextDelivery(market);
  if (nd && nd.date) {
    const d = daysUntil(nd.date);
    const txt = d != null && d > 0
      ? "距离" + esc(nd.label) + "还有 " + d + " 天" + (nd.estimated ? "（预计）" : "")
      : esc(nd.label) + "即将到来";
    html += (html ? '<span class="quote-sep">·</span>' : "") +
      '<span class="earn">' + txt + "</span>";
  }
  el.innerHTML = html;
  el.hidden = !html;
}

/* ---------- 今日屏 ---------- */
function signalCardHtml(market) {
  const sig = market && market.daily_signal;
  const el = document.getElementById("signal-card");
  if (!sig || !Array.isArray(sig.dims)) {
    el.innerHTML = '<div class="signal-card"><p class="signal-empty">信号计算中…</p></div>';
    return;
  }
  const vcls = sig.verdict === "偏多" ? "up" : sig.verdict === "偏空" ? "down" : "flat";
  const dims = sig.dims.map((d) => {
    const c = d.score > 0 ? "up" : d.score < 0 ? "down" : "flat";
    return '<div class="dim"><span class="dot ' + c + '"></span>' +
      "<b>" + esc(d.key) + "</b><span>" + esc(d.note) + "</span></div>";
  }).join("");
  el.innerHTML =
    '<div class="signal-card">' +
      '<p class="eyebrow">DAILY SIGNAL · 每日信号</p>' +
      '<div class="signal-verdict ' + vcls + '">' + esc(sig.verdict) +
        '<span class="signal-score">' +
        (sig.score > 0 ? "+" : "") + sig.score + " / 5</span></div>" +
      '<div class="signal-dims">' + dims + "</div>" +
      '<p class="disclaimer">特斯拉叙事与动量驱动较强，信号仅供参考，不构成投资建议</p>' +
    "</div>";
}

/* 事件倒计时双卡：交付报告在前（更能驱动股价），财报在后 */
function renderEventCards(market) {
  const el = document.getElementById("event-cards");
  const ne = market && market.next_earnings;
  const nd = nextDelivery(market);
  const cards = [];
  if (nd && nd.date) {
    const d = daysUntil(nd.date);
    cards.push({ hot: true, label: esc(nd.label), days: d,
      sub: "交付量是特斯拉最重要的经营数字" + (nd.estimated ? " · 日期为预计" : "") });
  }
  if (ne && ne.date) {
    const d = daysUntil(ne.date);
    cards.push({ hot: false, label: esc(ne.label), days: d, sub: "盘后发布 + 电话会" });
  }
  if (!cards.length) { el.innerHTML = ""; return; }
  el.innerHTML = cards.map(function (c) {
    const daysHtml = c.days != null && c.days >= 0
      ? "<b>" + c.days + "</b> 天后"
      : "即将到来";
    return '<div class="event-card' + (c.hot ? " hot" : "") + '">' +
      '<p class="ev-label">' + c.label + "</p>" +
      '<p class="ev-days num">' + daysHtml + "</p>" +
      '<p class="ev-sub">' + c.sub + "</p></div>";
  }).join("");
}

/* earnings quarters：文件为 oldest-first（Q4 2023 … Q3 2026） */
function quarters() {
  return (cachedExtra && cachedExtra.earnings && cachedExtra.earnings.quarters) || [];
}
function latestQ() {
  const qs = quarters();
  return qs.length ? qs[qs.length - 1] : null;
}
function latestWith(key) {
  const qs = quarters();
  for (let i = qs.length - 1; i >= 0; i--) {
    if (qs[i][key] != null) return qs[i];
  }
  return null;
}

function renderKeyNums() {
  const el = document.getElementById("keynums");
  const q = latestQ();
  if (!q) { el.innerHTML = '<p class="track-empty">数字加载中…</p>'; return; }
  const cards = [];
  // 1. 最新季交付
  if (q.deliveries != null) {
    let yoy = "";
    const qs = quarters();
    const prev = qs.length >= 5 ? qs[qs.length - 5] : null; // 同比：4 个季度前
    if (prev && prev.deliveries) {
      const p = (q.deliveries / prev.deliveries - 1) * 100;
      yoy = " · 同比 " + (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
    }
    cards.push({ label: "最新季交付", val: fmtWan(q.deliveries) + "万辆",
      sub: qShort(q.q) + yoy });
  }
  // 2. 汽车毛利率（扣积分）
  const gmQ = latestWith("auto_gm_ex_credits_pct");
  if (gmQ) {
    cards.push({ label: '<span class="term" data-term="汽车毛利率（扣积分）">汽车毛利率（扣积分）</span>',
      val: gmQ.auto_gm_ex_credits_pct.toFixed(1) + "%", sub: qShort(gmQ.q),
      raw: true });
  }
  // 3. 能源装机 TTM
  const qs = quarters();
  let gwh = 0, n = 0;
  for (let i = qs.length - 1; i >= 0 && n < 4; i--) {
    if (qs[i].energy_gwh != null) { gwh += qs[i].energy_gwh; n++; }
  }
  if (n > 0) {
    cards.push({ label: "能源装机TTM", val: gwh.toFixed(1) + " GWh",
      sub: "近" + n + "季合计" });
  }
  // 4. FSD 订阅（策展数字，公开报道口径）
  cards.push({ label: '<span class="term" data-term="FSD">FSD</span> 订阅用户',
    val: "110万", sub: "媒体报道口径", raw: true });
  el.innerHTML = cards.map(function (c) {
    return '<div class="keynum"><p class="kn-label">' +
      (c.raw ? c.label : esc(c.label)) + '</p><p class="kn-val num"><b>' +
      esc(c.val) + '</b></p><p class="kn-sub">' + esc(c.sub) + "</p></div>";
  }).join("");
}

/* ---------- 估值一句话 ----------
   管线给了就用管线；否则前端按 TTM P/E + 近5年分位 + 目标价空间拼一条。 */
function ttmEPS() {
  const qs = quarters();
  let ni = 0, n = 0, shares = null;
  for (let i = qs.length - 1; i >= 0 && n < 4; i--) {
    if (qs[i].net_income_b != null) {
      ni += qs[i].net_income_b; n++;
      if (shares == null && qs[i].diluted_shares_b != null) shares = qs[i].diluted_shares_b;
    }
  }
  if (n < 4 || !shares) return null;
  return ni / shares;
}

function peSeries5y() {
  // 返回近 5 年（60 个月）月度 P/E 序列 [{m, pe}]，供分位计算
  const fin = (cachedExtra && cachedExtra.financials && cachedExtra.financials.years) || [];
  const epsMap = {};
  fin.forEach(function (y) {
    if (y.eps_gaap != null && y.eps_gaap > 0) epsMap[y.fy] = y.eps_gaap;
  });
  const maxFy = Math.max.apply(null, Object.keys(epsMap).map(Number).concat([0]));
  const ttm = ttmEPS();
  const pts = ((cachedExtra && cachedExtra.price && cachedExtra.price.points) || []);
  const cutoff = pts.length ? pts[pts.length - 1].m : "";
  const out = [];
  pts.forEach(function (p) {
    if (p.m < "2016-01") return;
    const yr = parseInt(p.m.slice(0, 4), 10);
    let eps = null;
    if (yr <= maxFy) eps = epsMap[yr] || null;
    else if (yr === maxFy + 1) eps = ttm; // 当年未出年报：用 TTM
    if (eps && p.c > 0) out.push({ m: p.m, pe: p.c / eps });
  });
  return out.slice(-60);
}

function pe5yPercentile() {
  const s = peSeries5y();
  if (s.length < 12) return null;
  const cur = s[s.length - 1].pe;
  let le = 0;
  s.forEach(function (p) { if (p.pe <= cur) le++; });
  return { pe: cur, pct: Math.round(le / s.length * 100), n: s.length };
}

function valuationSentence(market) {
  const vs = market && market.valuation_sentence;
  if (vs && !/暂无|不足/.test(vs)) return vs;
  const parts = [];
  const pp = pe5yPercentile();
  if (pp) {
    parts.push("TTM P/E 约 " + pp.pe.toFixed(0) + "x，处于近" +
      Math.min(5, Math.round(pp.n / 12)) + "年月度 P/E 的 " + pp.pct + "% 分位");
  }
  const ts = (cachedExtra && cachedExtra.targets && cachedExtra.targets.targets) || [];
  const vs2 = ts.map(function (t) { return t.target_num; })
    .filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
  if (vs2.length >= 5 && market && typeof market.price === "number") {
    const med = (vs2[(vs2.length - 1) >> 1] + vs2[vs2.length >> 1]) / 2;
    const up = (med / market.price - 1) * 100;
    parts.push("分析师目标价中位数 $" + med.toFixed(0) + "，隐含空间 " +
      (up >= 0 ? "+" : "") + up.toFixed(0) + "%");
  }
  if (!parts.length) return "";
  return parts.join("；") + "。";
}

function renderValSentence() {
  const el = document.getElementById("val-sentence");
  const s = valuationSentence(cachedNews && cachedNews.market);
  el.innerHTML = s
    ? '<div class="val-sentence-card num">' + esc(s) + "</div>"
    : "";
}

function renderToday(data) {
  const market = data.market || {};
  const stories = Array.isArray(data.stories) ? data.stories : [];

  document.getElementById("updated-at").textContent = fmtUpdated(data.updated_at);
  renderMarket(market);
  applyLiveQuote(); // re-apply tick after news.json refresh
  renderAttrLine(market, stories);
  signalCardHtml(market);
  renderEventCards(market);
  renderKeyNums();
  renderValSentence();
}

/* ---------- 新闻屏 ---------- */
function matchesQuery(s, q) {
  const hay = [s.title, s.title_zh, s.zh_summary, s.source]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

function renderNews(data) {
  const timeline = document.getElementById("timeline");
  const empty = document.getElementById("empty");
  const countEl = document.getElementById("search-count");

  const recent = Array.isArray(data.stories) ? data.stories : [];
  const inHistory = searchScope === "history" && historyPool;
  const stories = inHistory ? historyPool : recent;
  const q = currentQuery.toLowerCase();
  const filtered = stories.filter((s) => {
    if (currentCat !== "全部" && (s.category || "其他") !== currentCat) return false;
    if (q && !matchesQuery(s, q)) return false;
    return true;
  });

  if (q) {
    countEl.hidden = false;
    countEl.textContent = (inHistory ? "历史中找到 " : "找到 ") +
      filtered.length + " 条" +
      (searchScope === "history" && !inHistory ? "（历史归档整理中，仅搜索近7天）" : "");
  } else {
    countEl.hidden = true;
  }

  if (filtered.length === 0) {
    timeline.innerHTML = "";
    empty.hidden = false;
    empty.querySelector("p").textContent =
      stories.length === 0 ? "暂无新闻数据"
      : q ? "没有匹配的新闻，换个关键词试试"
      : "该分类暂无新闻";
    return;
  }
  empty.hidden = true;
  timeline.innerHTML = filtered.map((s) =>
    s.analyst ? analystCard(s) : storyCard(s)
  ).join("");
}

/* ---------- 跟踪屏 ---------- */
function renderTrack() {
  renderDeliveryChart();
  renderMix("chart-mix", "mix-legend-track");
  renderMixDonut("donut-mix");
  renderMarginChart();
  renderEnergyChart();
  renderQuarterTable();
  renderRoadmap(cachedExtra && cachedExtra.roadmap);
  renderRmCountdown();
  renderFleet(cachedExtra && cachedExtra.fleet);
  renderValuation(cachedNews && cachedNews.market);
  renderTargets();
  renderPE();
  renderPeers();
  renderThesis(cachedExtra && cachedExtra.thesis);
  renderCompany(cachedExtra && cachedExtra.history);
  renderSignalHistory();
  initTrackChips();
  syncChipsOffset();
}

/* Freshness suffixes on track-section eyebrows (data/freshness.json).
   Missing file -> leave spans empty (graceful). */
function daysAgoChicago(iso) {
  try {
    var d = new Date(iso + "T12:00:00");
    if (isNaN(d)) return null;
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var rev = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.max(0, Math.round((day - rev) / 86400000));
  } catch (e) { return null; }
}

function renderFresh() {
  var fr = cachedExtra && cachedExtra.fresh;
  if (!fr || !fr.sections) return;  // missing file: suffixes stay hidden
  fr.sections.forEach(function (s) {
    var el = document.getElementById("fresh-" + s.id);
    if (!el) return;
    el.className = "fresh";
    var txt = "";
    if (s.status === "stale") {
      txt = "· 待复核";
      el.className = "fresh stale";
    } else if (s.status === "attention") {
      txt = "· " + (s.note || "需关注");
      el.className = "fresh attention";
    } else {
      var n = daysAgoChicago(s.reviewed);
      txt = (n === 0) ? "· 今日已复核" : "· " + n + "天前复核";
    }
    el.textContent = txt;
  });
}

/* ---------- 跟踪屏：图表 ---------- */
const CW = 360;
const TRACK_EMPTY = '<p class="track-empty">图表数据加载中…</p>';

function fmtTick(v, unit) {
  if (unit === "%") return v.toFixed(1) + "%";
  if (unit === "$") return "$" + (v >= 100 ? Math.round(v) : v.toFixed(2));
  if (unit === "x") return (v >= 100 ? Math.round(v) : v.toFixed(1)) + "x";
  if (unit === "B") return "$" + v.toFixed(1) + "B";
  if (unit === "W") return v.toFixed(1) + "万";
  if (unit === "GWh") return v.toFixed(0) + "";
  return String(Math.round(v * 10) / 10);
}

function chartSvg(h, inner) {
  return '<svg viewBox="0 0 ' + CW + " " + h + '" class="csvg" role="img">' +
    inner + "</svg>";
}

/* 通用折线图：data=[{label, v}]，v 可为 null */
function renderLine(elId, data, o) {
  o = o || {};
  const el = document.getElementById(elId);
  const vals = data.map(function (d) { return d.v; })
    .filter(function (v) { return v != null; });
  if (!vals.length) { el.innerHTML = TRACK_EMPTY; return; }
  // 裁掉首尾无数据的空段，避免左侧大片空白（如 P/E 早期负 EPS 年份）
  let _a = 0, _b = data.length - 1;
  while (_a <= _b && data[_a].v == null) _a++;
  while (_b >= _a && data[_b].v == null) _b--;
  data = data.slice(_a, _b + 1);
  let lo = o.ymin != null ? o.ymin : Math.min.apply(null, vals);
  let hi = o.ymax != null ? o.ymax : Math.max.apply(null, vals);
  if (hi <= lo) hi = lo + 1;
  const pad = (hi - lo) * 0.14 || 1;
  // 显式 ymin（如 P/E 的 0 轴）不向下 padding，避免画出无意义的负刻度
  const tlo = o.ymin != null ? lo : lo - pad, thi = hi + pad;
  const H = o.h || 150, PT = 8, PB = 18, PL = 36, PR = 8;
  const W = CW - PL - PR, n = data.length;
  const X = function (i) { return PL + W * (n === 1 ? 0.5 : i / (n - 1)); };
  const Y = function (v) { return PT + (H - PT - PB) * (1 - (v - tlo) / (thi - tlo)); };
  let s = "";
  for (let g = 0; g <= 3; g++) {
    const tv = tlo + (thi - tlo) * g / 3, y = Y(tv);
    s += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (PL + W) +
      '" y2="' + y.toFixed(1) + '" class="grid"/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 3).toFixed(1) +
      '" class="ylab" text-anchor="end">' + fmtTick(tv, o.unit) + "</text>";
  }
  let d = "", started = false;
  data.forEach(function (p, i) {
    if (p.v == null) { started = false; return; }
    d += (started ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.v).toFixed(1) + " ";
    started = true;
  });
  s += '<path d="' + d + '" class="cline" stroke="' + (o.color || "#e82127") + '"/>';
  if (n <= 30) {
    data.forEach(function (p, i) {
      if (p.v == null) return;
      s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) +
        '" r="2.2" class="cdot"/>';
    });
  }
  const step = Math.max(1, Math.ceil(n / 5));
  for (let i = 0; i < n; i += step) {
    s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 5) +
      '" class="xlab" text-anchor="middle">' + esc(data[i].label) + "</text>";
  }
  el.innerHTML = chartSvg(H, s);
}

/* 通用柱状图：data=[{label, v, top}]，top 为柱顶文字 */
function renderBars(elId, data, o) {
  o = o || {};
  const el = document.getElementById(elId);
  const vals = data.map(function (d) { return d.v; })
    .filter(function (v) { return v != null; });
  if (!vals.length) { el.innerHTML = TRACK_EMPTY; return; }
  const hi = Math.max.apply(null, vals) * 1.18;
  const H = o.h || 160, PT = 16, PB = 18, PL = 30, PR = 6;
  const W = CW - PL - PR, n = data.length;
  const bw = W / n;
  const X = function (i) { return PL + bw * i + bw * 0.5; };
  const Y = function (v) { return PT + (H - PT - PB) * (1 - v / hi); };
  let s = "";
  for (let g = 0; g <= 2; g++) {
    const v = hi * g / 2, y = Y(v);
    s += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (PL + W) +
      '" y2="' + y.toFixed(1) + '" class="grid"/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 3).toFixed(1) +
      '" class="ylab" text-anchor="end">' + fmtTick(v, o.unit) + "</text>";
  }
  data.forEach(function (p, i) {
    if (p.v == null) return;
    const x = X(i), y = Y(p.v), w = Math.min(34, bw * 0.62);
    s += '<rect x="' + (x - w / 2).toFixed(1) + '" y="' + y.toFixed(1) +
      '" width="' + w.toFixed(1) + '" height="' + (H - PB - y).toFixed(1) +
      '" class="cbar"' + (o.barFill ? ' fill="' + o.barFill + '"' : "") + "/>";
    if (p.top) {
      s += '<text x="' + x.toFixed(1) + '" y="' + (y - 4).toFixed(1) +
        '" class="toplab" text-anchor="middle">' + esc(p.top) + "</text>";
    }
  });
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 5) +
      '" class="xlab" text-anchor="middle">' + esc(data[i].label) + "</text>";
  }
  el.innerHTML = chartSvg(H, s);
}

/* ---------- 交付量：交付柱 + 产量线 ---------- */
function renderDeliveryChart() {
  const el = document.getElementById("chart-delivery");
  const qs = quarters().filter(function (q) { return q.deliveries != null; });
  if (!qs.length) { el.innerHTML = TRACK_EMPTY; return; }
  const data = qs.map(function (q, i) {
    const prev = i > 0 ? qs[i - 1].deliveries : null;
    const qoq = prev ? (q.deliveries / prev - 1) * 100 : null;
    return {
      label: qShort(q.q),
      del: q.deliveries / 10000,                       // 万辆
      prod: q.production != null ? q.production / 10000 : null,
      top: (q.deliveries / 10000).toFixed(1),
      qoq: qoq
    };
  });
  const allV = [];
  data.forEach(function (p) {
    allV.push(p.del);
    if (p.prod != null) allV.push(p.prod);
  });
  const hi = Math.max.apply(null, allV) * 1.22;
  const H = 180, PT = 16, PB = 20, PL = 30, PR = 6;
  const W = CW - PL - PR, n = data.length, bw = W / n;
  const X = function (i) { return PL + bw * i + bw * 0.5; };
  const Y = function (v) { return PT + (H - PT - PB) * (1 - v / hi); };
  let s = "";
  for (let g = 0; g <= 2; g++) {
    const v = hi * g / 2, y = Y(v);
    s += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (PL + W) +
      '" y2="' + y.toFixed(1) + '" class="grid"/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 3).toFixed(1) +
      '" class="ylab" text-anchor="end">' + fmtTick(v, "W") + "</text>";
  }
  data.forEach(function (p, i) {
    const x = X(i), y = Y(p.del), w = Math.min(30, bw * 0.58);
    s += '<rect x="' + (x - w / 2).toFixed(1) + '" y="' + y.toFixed(1) +
      '" width="' + w.toFixed(1) + '" height="' + (H - PB - y).toFixed(1) +
      '" class="cbar"/>';
    s += '<text x="' + x.toFixed(1) + '" y="' + (y - 4).toFixed(1) +
      '" class="toplab" text-anchor="middle">' + p.top + "</text>";
  });
  // 产量虚线
  let d = "", started = false;
  data.forEach(function (p, i) {
    if (p.prod == null) { started = false; return; }
    d += (started ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.prod).toFixed(1) + " ";
    started = true;
  });
  s += '<path d="' + d + '" class="prodline"/>';
  data.forEach(function (p, i) {
    if (p.prod == null) return;
    s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.prod).toFixed(1) +
      '" r="2" class="proddot"/>';
  });
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) +
      '" class="xlab" text-anchor="middle">' + esc(data[i].label) + "</text>";
  }
  s += '<g class="legend"><rect x="' + PL + '" y="2" width="10" height="8" class="cbar"/>' +
    '<text x="' + (PL + 14) + '" y="9" class="xlab">交付量</text>' +
    '<line x1="' + (PL + 66) + '" y1="6" x2="' + (PL + 82) + '" y2="6" class="prodline"/>' +
    '<text x="' + (PL + 86) + '" y="9" class="xlab">产量</text></g>';
  el.innerHTML = chartSvg(H, s);
  // 最新一季注释
  const cap = document.getElementById("delivery-cap");
  const lq = latestQ();
  if (cap && lq && lq.note) cap.textContent = "最新（" + qShort(lq.q) + "）：" + lq.note;
}

/* ---------- 业务营收结构：100% 堆叠 + 环形 ---------- */
const MIX_SEGS = [
  { key: "auto",     label: "汽车",       color: "#e82127" },
  { key: "energy",   label: "能源",       color: "#4a9eff" },
  { key: "services", label: "服务及其他", color: "#b07fe8" },
];

function segColor(key) {
  for (let i = 0; i < MIX_SEGS.length; i++) {
    if (MIX_SEGS[i].key === key) return MIX_SEGS[i].color;
  }
  return "#8a8f98";
}

function segLabel(key) {
  for (let i = 0; i < MIX_SEGS.length; i++) {
    if (MIX_SEGS[i].key === key) return MIX_SEGS[i].label;
  }
  return key;
}

/* 各季度 -> 有序分段（汽车在下） */
function mixSegsFor(q) {
  const auto = (q.auto_sales_b || 0) + (q.auto_leasing_b || 0);
  return [
    { key: "auto", v: auto > 0 ? auto : null },
    { key: "energy", v: q.energy_b },
    { key: "services", v: q.services_b },
  ];
}

function mixQuarters() {
  return quarters().filter(function (q) {
    const segs = mixSegsFor(q);
    return segs.every(function (x) { return x.v != null && x.v >= 0; }) &&
      segs.some(function (x) { return x.v > 0; });
  });
}

/* 100% 堆叠条形图（elId/legendId 参数化，供跟踪屏与入门屏共用） */
function renderMix(elId, legendId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const qs = mixQuarters();
  if (!qs.length) { el.innerHTML = TRACK_EMPTY; return; }
  const H = 168, PT = 8, PB = 20, PL = 4, PR = 4;
  const W = CW - PL - PR, n = qs.length, bh = H - PT - PB;
  const bw = W / n;
  let s = "";
  qs.forEach(function (q, i) {
    const segs = mixSegsFor(q).filter(function (x) { return x.v != null && x.v > 0; });
    const tot = segs.reduce(function (a, x) { return a + x.v; }, 0);
    const x = PL + bw * i + bw * 0.5, w = Math.min(26, bw * 0.68);
    let y = PT + bh;
    segs.forEach(function (sg) {
      const frac = tot > 0 ? sg.v / tot : 0;
      const h = bh * frac;
      y -= h;
      s += '<rect x="' + (x - w / 2).toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + w.toFixed(1) + '" height="' + Math.max(h, 0.5).toFixed(1) +
        '" fill="' + segColor(sg.key) + '"/>';
    });
    // 汽车占比标注在红色段中央
    const autoFrac = tot > 0 ? segs[0].v / tot : 0;
    if (autoFrac > 0.2) {
      s += '<text x="' + x.toFixed(1) + '" y="' +
        (PT + bh - bh * autoFrac / 2 + 3).toFixed(1) +
        '" class="mixpct" text-anchor="middle">' + Math.round(autoFrac * 100) + "%</text>";
    }
  });
  const step = Math.max(1, Math.ceil(n / 4));
  for (let i = 0; i < n; i += step) {
    const x = PL + bw * i + bw * 0.5;
    s += '<text x="' + x.toFixed(1) + '" y="' + (H - 6) +
      '" class="xlab" text-anchor="middle">' + esc(qShort(qs[i].q)) + "</text>";
  }
  el.innerHTML = chartSvg(H, s);
  const lg = document.getElementById(legendId);
  if (lg) {
    lg.innerHTML = MIX_SEGS.map(function (m) {
      return '<span class="mix-lg"><i style="background:' + m.color + '"></i>' +
        esc(m.label) + "</span>";
    }).join("");
  }
}

/* 最新一季环形图：各业务占比明细 */
function renderMixDonut(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const qs = mixQuarters();
  const q = qs[qs.length - 1];
  if (!q) { el.innerHTML = TRACK_EMPTY; return; }
  const segs = mixSegsFor(q).filter(function (x) { return x.v != null && x.v > 0; });
  const tot = segs.reduce(function (a, x) { return a + x.v; }, 0);
  const cx = 70, cy = 70, r = 50, sw = 24;
  let s = "", ang = -Math.PI / 2;
  segs.forEach(function (sg) {
    const frac = tot > 0 ? sg.v / tot : 0;
    const a0 = ang, a1 = ang + frac * Math.PI * 2;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    s += '<path d="M' + x0.toFixed(1) + " " + y0.toFixed(1) +
      " A" + r + " " + r + " 0 " + large + " 1 " + x1.toFixed(1) + " " + y1.toFixed(1) +
      '" fill="none" stroke="' + segColor(sg.key) + '" stroke-width="' + sw + '"/>';
    ang = a1;
  });
  const top = segs.slice().sort(function (a, b) { return b.v - a.v; })[0];
  const topPct = tot > 0 ? top.v / tot * 100 : 0;
  s += '<text x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" class="donut-big">' +
    topPct.toFixed(1) + "%</text>" +
    '<text x="' + cx + '" y="' + (cy + 15) + '" text-anchor="middle" class="xlab">' +
    esc(segLabel(top.key)) + "</text>";
  const rows = segs.map(function (sg) {
    const pct = tot > 0 ? sg.v / tot * 100 : 0;
    return '<div class="donut-row"><i style="background:' + segColor(sg.key) + '"></i>' +
      '<span class="donut-lab">' + esc(segLabel(sg.key)) + "</span>" +
      '<span class="donut-val num">$' + sg.v.toFixed(1) + "B · " + pct.toFixed(1) + "%</span></div>";
  }).join("");
  el.innerHTML = '<svg viewBox="0 0 140 140" class="csvg donut-svg" role="img">' + s + "</svg>" +
    '<div class="donut-side"><p class="donut-title">最新一季（' + esc(qShort(q.q)) +
    "）营收结构</p>" + rows + "</div>";
}

/* ---------- 毛利率：双线（汽车扣积分 vs 整体） ---------- */
function renderMarginChart() {
  const el = document.getElementById("chart-margin");
  const qs = quarters();
  const data = qs.map(function (q) {
    const total = (q.gross_profit_b != null && q.revenue_b)
      ? q.gross_profit_b / q.revenue_b * 100 : null;
    return {
      label: qShort(q.q),
      auto: q.auto_gm_ex_credits_pct,
      total: total
    };
  });
  const series = [
    { key: "auto", color: "#e82127", name: "汽车毛利率（扣积分）" },
    { key: "total", color: "#4a9eff", name: "整体毛利率" },
  ];
  const vals = [];
  data.forEach(function (p) {
    series.forEach(function (sr) { if (p[sr.key] != null) vals.push(p[sr.key]); });
  });
  if (!vals.length) { el.innerHTML = TRACK_EMPTY; return; }
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (hi <= lo) hi = lo + 1;
  const pad = (hi - lo) * 0.2 || 1;
  const tlo = lo - pad, thi = hi + pad;
  const H = 170, PT = 18, PB = 20, PL = 38, PR = 8;
  const W = CW - PL - PR, n = data.length;
  const X = function (i) { return PL + W * (n === 1 ? 0.5 : i / (n - 1)); };
  const Y = function (v) { return PT + (H - PT - PB) * (1 - (v - tlo) / (thi - tlo)); };
  let s = "";
  for (let g = 0; g <= 3; g++) {
    const tv = tlo + (thi - tlo) * g / 3, y = Y(tv);
    s += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (PL + W) +
      '" y2="' + y.toFixed(1) + '" class="grid"/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 3).toFixed(1) +
      '" class="ylab" text-anchor="end">' + fmtTick(tv, "%") + "</text>";
  }
  series.forEach(function (sr) {
    let d = "", started = false;
    data.forEach(function (p, i) {
      const v = p[sr.key];
      if (v == null) { started = false; return; }
      d += (started ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1) + " ";
      started = true;
    });
    s += '<path d="' + d + '" class="cline" stroke="' + sr.color + '"/>';
    data.forEach(function (p, i) {
      const v = p[sr.key];
      if (v == null) return;
      s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(v).toFixed(1) +
        '" r="2.2" fill="' + sr.color + '"/>';
    });
  });
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) +
      '" class="xlab" text-anchor="middle">' + esc(data[i].label) + "</text>";
  }
  s += '<g class="legend">';
  let lx = PL;
  series.forEach(function (sr) {
    s += '<line x1="' + lx + '" y1="6" x2="' + (lx + 16) + '" y2="6" class="cline" stroke="' +
      sr.color + '"/>' +
      '<text x="' + (lx + 20) + '" y="9" class="xlab">' + esc(sr.name) + "</text>";
    lx += 20 + sr.name.length * 9 + 18;
  });
  s += "</g>";
  el.innerHTML = chartSvg(H, s);
}

/* ---------- 能源：季度装机 ---------- */
function renderEnergyChart() {
  const qs = quarters();
  renderBars("chart-energy", qs.map(function (q) {
    return {
      label: qShort(q.q), v: q.energy_gwh,
      top: q.energy_gwh != null ? q.energy_gwh.toFixed(1) : ""
    };
  }), { h: 160, unit: "GWh", barFill: "#4a9eff" });
}

/* ---------- 财报速览：近 4 季紧凑表 ---------- */
function renderQuarterTable() {
  const el = document.getElementById("qtable");
  const qs = quarters().slice(-4).reverse(); // 最新在前
  if (!qs.length) { el.innerHTML = TRACK_EMPTY; return; }
  const cell = function (v, fmt) {
    if (v == null) return "—";
    return fmt(v);
  };
  const rows = qs.map(function (q) {
    return "<tr><td class=\"qname num\">" + esc(qShort(q.q)) + "</td>" +
      "<td class=\"num\">" + cell(q.revenue_b, function (v) { return "$" + v.toFixed(1) + "B"; }) + "</td>" +
      "<td class=\"num" + (q.net_income_b != null && q.net_income_b < 0 ? " neg" : "") + "\">" +
        cell(q.net_income_b, function (v) { return "$" + v.toFixed(2) + "B"; }) + "</td>" +
      "<td class=\"num" + (q.eps_gaap != null && q.eps_gaap < 0 ? " neg" : "") + "\">" +
        cell(q.eps_gaap, function (v) { return "$" + v.toFixed(2); }) + "</td></tr>";
  }).join("");
  const lq = latestQ();
  const cap = (lq && lq.revenue_b == null)
    ? "<p class=\"qtable-cap\">" + esc(qShort(lq.q)) + " 财报将于 " +
      esc((lq.date || "").slice(5).replace("-", "/")) + " 盘后发布，届时自动更新。</p>"
    : "";
  el.innerHTML = '<div class="qtable-card"><table class="qtable">' +
    "<thead><tr><th>季度</th><th>营收</th><th>净利润</th><th>EPS(GAAP)</th></tr></thead>" +
    "<tbody>" + rows + "</tbody></table></div>" + cap;
}

/* ---------- Robotaxi 路线图 ---------- */
const RM_STATUS = {
  done: "已完成", in_progress: "进行中", planned: "计划中",
  "已完成": "done", "进行中": "in_progress", "计划中": "planned"
};

function rmStatusKey(s) {
  if (RM_STATUS[s] && (s === "done" || s === "in_progress" || s === "planned")) return s;
  return RM_STATUS[s] || "planned";
}
function rmStatusLabel(s) {
  const k = rmStatusKey(s);
  return k === "done" ? "已完成" : k === "in_progress" ? "进行中" : "计划中";
}

function renderRoadmap(rm) {
  const el = document.getElementById("roadmap");
  const items = (rm && rm.milestones) || [];
  if (!items.length) {
    el.innerHTML = '<p class="track-empty">Robotaxi / FSD / Optimus 路线图整理中…</p>';
    return;
  }
  el.innerHTML = '<div class="roadmap">' + items.map(function (it) {
    const k = rmStatusKey(it.status);
    return '<div class="rm-item">' +
      '<span class="rm-dot ' + k + '"></span>' +
      '<div class="rm-body">' +
        '<div class="rm-head"><b>' + escTag(it.title) + "</b>" +
          '<span class="rm-status ' + k + '">' + rmStatusLabel(it.status) + "</span></div>" +
        '<p class="rm-year num">' + esc(it.date_label || it.date || "") + "</p>" +
        (it.detail ? '<p class="rm-note">' + escTag(it.detail) + "</p>" : "") +
      "</div></div>";
  }).join("") + "</div>";
}

/* 路线图：下一个里程碑倒计时 */
function renderRmCountdown() {
  const el = document.getElementById("rm-countdown");
  const rm = cachedExtra && cachedExtra.roadmap;
  const nx = rm && rm.next;
  if (!nx || !nx.title) { el.innerHTML = ""; return; }
  let when = "";
  if (nx.expected) {
    const d = daysUntil(nx.expected);
    when = d != null
      ? (d >= 0 ? "约 " + d + " 天" : "已到")
      : "预计 " + String(nx.expected).replace("H1", "年上半年").replace("H2", "年下半年");
  } else if (nx.date_label) {
    when = "预计 " + nx.date_label;
  }
  el.innerHTML = '<p class="rm-countdown">下一里程碑 · <b>' + esc(nx.title) +
    "</b> " + esc(when) + "</p>";
}

/* 车队规模：德州 DMV 注册数 + 第三方活跃估计 + 预测 */
function renderFleet(fl) {
  const el = document.getElementById("fleet");
  if (!el) return;
  const reg = (fl && fl.registered) || [];
  if (!reg.length) { el.innerHTML = '<p class="track-empty">车队数据整理中…</p>'; return; }
  const latest = reg[reg.length - 1];
  const act = (fl && fl.active) || {};
  let html = '<div class="val-card">';
  html += '<div class="fleet-hero">' +
    '<div class="fleet-stat"><b class="num">' + (latest.total != null ? latest.total : "—") +
    '</b><span>注册车辆（德州 DMV）<br>' + esc(latest.label) + "</span></div>" +
    '<div class="fleet-stat"><b class="num">' + (act.passenger_carrying_7d != null ? act.passenger_carrying_7d : "—") +
    "</b><span>近7天实际载客<br>第三方车牌追踪</span></div></div>";
  html += '<div class="fleet-rows">';
  reg.forEach(function (r) {
    const bits = [];
    if (r.cybercab != null) bits.push("Cybercab " + r.cybercab);
    if (r.model_y != null) bits.push("Model Y " + r.model_y);
    const num = r.total != null ? r.total + " 辆" : "Cybercab " + r.cybercab + " 辆";
    html += '<div class="fleet-row"><div class="fr-top"><span class="fr-date">' + esc(r.label) +
      '</span><span class="fr-num num">' + esc(num) + "</span></div>" +
      (bits.length ? '<div class="fr-sub num">' + esc(bits.join(" · ")) + "</div>" : "") +
      "</div>";
  });
  html += "</div>";
  const fcs = (fl && fl.forecasts) || [];
  if (fcs.length) {
    html += '<p class="fleet-fc">第三方预测：' + fcs.map(function (f) {
      return esc(f.source) + " <b>" + esc(f.label) + "</b>";
    }).join("；") + "</p>";
  }
  const ctx = (fl && fl.context && fl.context.waymo_texas) || "";
  html += '<p class="val-sub">注册是数据库里的 VIN，不等于路上跑的车。数据来源：德州 DMV 公开查询（TxMCCS）与第三方追踪；Waymo 同期在德州约 ' +
    esc(ctx) + "。</p></div>";
  el.innerHTML = html;
}

/* ---------- 估值 ---------- */
function renderValuation(market) {
  const el = document.getElementById("valuation");
  const sig = market && market.daily_signal;
  const pp = pe5yPercentile();
  let html = '<div class="val-card num">';
  if (pp) {
    html += '<div class="val-row"><span>TTM P/E</span><b>' + pp.pe.toFixed(0) +
      'x</b><span class="val-sub">近12个月GAAP EPS</span></div>' +
      '<div class="val-row"><span>近5年 P/E 分位</span></div>' +
      '<div class="pct-bar"><div class="pct-fill" style="width:' + pp.pct + '%"></div>' +
      '<div class="pct-marker" style="left:' + pp.pct + '%"></div></div>' +
      '<p class="val-sub">当前 P/E 处于近 ' + pp.n + " 个月 P/E 的 " + pp.pct + "% 分位</p>";
  } else {
    html += '<p class="track-empty">P/E 数据计算中…</p>';
  }
  if (sig && sig.price_52w_pct != null) {
    const pct = sig.price_52w_pct;
    html += '<div class="val-row"><span>52周价格分位</span></div>' +
      '<div class="pct-bar"><div class="pct-fill" style="width:' + pct + '%"></div>' +
      '<div class="pct-marker" style="left:' + pct + '%"></div></div>' +
      '<p class="val-sub">现价处于52周区间 ' + pct + "% 分位" +
      (market.price != null ? " · $" + market.price.toFixed(2) : "") + "</p>";
  }
  if (sig && sig.target_median != null) {
    html += '<div class="val-row"><span>分析师目标价中位数</span><b>$' +
      sig.target_median.toFixed(0) + '</b><span class="val-sub">' +
      sig.target_count + " 家 · 隐含空间 " +
      (sig.implied_upside_pct >= 0 ? "+" : "") + sig.implied_upside_pct + "%</span></div>";
  }
  const sent = valuationSentence(market);
  if (sent) html += '<p class="val-sentence">' + esc(sent) + "</p>";
  html += "</div>";
  el.innerHTML = html;
}

/* ---------- 分析师目标价分布（条带图） ---------- */
function targetAction(t) {
  const s = (t.source_title || "") + " " + (t.rating || "");
  if (/下调/.test(s)) return "下调";
  if (/上调/.test(s)) return "上调";
  if (/维持|重申/.test(s)) return "维持";
  return "—";
}
function openInfoSheet(title, body) {
  document.getElementById("term-title").textContent = title;
  document.getElementById("term-explain").textContent = body;
  document.getElementById("term-backdrop").hidden = false;
  document.getElementById("term-sheet").hidden = false;
  document.body.classList.add("sheet-open");
}
function renderTargets() {
  const el = document.getElementById("chart-targets");
  const cap = document.getElementById("targets-cap");
  const ts = ((cachedExtra && cachedExtra.targets && cachedExtra.targets.targets) || [])
    .filter(function (t) { return t.target_num > 0 && t.date; })
    .sort(function (a, b) { return a.target_num - b.target_num; });
  if (ts.length < 5) {
    // 数据不足时整个区块隐藏，避免一个空卡片占地方
    const blk = document.getElementById("targets-block");
    if (blk) blk.hidden = true;
    return;
  }
  const blk = document.getElementById("targets-block");
  if (blk) blk.hidden = false;
  const vs = ts.map(function (t) { return t.target_num; });
  const cur = cachedExtra && cachedNews && cachedNews.market && cachedNews.market.price;
  let lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
  if (cur) { lo = Math.min(lo, cur); hi = Math.max(hi, cur); }
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  const med = (vs[(vs.length - 1) >> 1] + vs[vs.length >> 1]) / 2;
  const H = 200, PT = 16, PB = 22, PL = 40, PR = 12;
  const W = CW - PL - PR, LANES = 5, laneH = (H - PT - PB) / LANES;
  const X = function (v) { return PL + W * (v - lo) / (hi - lo); };
  let s = "";
  for (let g = 0; g <= 4; g++) {
    const v = lo + (hi - lo) * g / 4, x = X(v);
    s += '<line x1="' + x.toFixed(1) + '" y1="' + PT + '" x2="' + x.toFixed(1) +
      '" y2="' + (H - PB) + '" class="grid"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (H - 7) +
      '" class="xlab" text-anchor="middle">' + fmtTick(v, "$") + "</text>";
  }
  const medX = X(med);
  s += '<line x1="' + medX.toFixed(1) + '" y1="' + PT + '" x2="' + medX.toFixed(1) +
    '" y2="' + (H - PB) + '" class="med-line"/>' +
    '<text x="' + Math.min(medX + 4, CW - PR - 60).toFixed(1) + '" y="' + (PT - 4) +
    '" class="med-lab">中位数 $' + med.toFixed(0) + "</text>";
  if (cur) {
    const cx = X(cur);
    s += '<line x1="' + cx.toFixed(1) + '" y1="' + PT + '" x2="' + cx.toFixed(1) +
      '" y2="' + (H - PB) + '" class="cur-line"/>' +
      '<text x="' + Math.max(cx - 4, PL + 44).toFixed(1) + '" y="' + (PT - 4) +
      '" class="xlab cur-lab" text-anchor="end">现价 $' + cur.toFixed(0) + "</text>";
  }
  ts.forEach(function (t, i) {
    const lane = (i * 2 + 1) % LANES; // 确定性分 lane，相邻点错开
    const y = PT + laneH * (lane + 0.5), x = X(t.target_num);
    s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
      '" r="5" class="tdot"/>' +
      '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
      '" r="14" class="thit" data-ti="' + i + '"/>';
  });
  el.innerHTML = chartSvg(H, s);
  el.onclick = function (e) {
    const hit = e.target.closest ? e.target.closest(".thit") : null;
    if (!hit) return;
    const t = ts[parseInt(hit.dataset.ti, 10)];
    if (!t) return;
    const d = new Date(t.date);
    openInfoSheet(t.firm + " · $" + t.target_num.toFixed(0),
      "目标价 $" + t.target_num.toFixed(0) + " ｜ " + targetAction(t) +
      " ｜ " + (d.getMonth() + 1) + "/" + d.getDate() +
      (t.rating ? " ｜ 评级 " + t.rating : ""));
  };
  if (cap) cap.textContent = ts.length + " 家研报目标价分布；点击圆点看详情。红线为当前价，金线为中位数。数据来自媒体报道整理。";
}

/* ---------- TTM P/E（自然年财年） ---------- */
function renderPE() {
  const fin = (cachedExtra && cachedExtra.financials && cachedExtra.financials.years) || [];
  const epsMap = {};
  fin.forEach(function (y) {
    if (y.eps_gaap != null && y.eps_gaap > 0) epsMap[y.fy] = y.eps_gaap;
  });
  const maxFy = Math.max.apply(null, Object.keys(epsMap).map(Number).concat([0]));
  const ttm = ttmEPS();
  const pts = ((cachedExtra && cachedExtra.price && cachedExtra.price.points) || [])
    .filter(function (p) { return p.m >= "2016-01"; })
    .map(function (p) {
      const yr = parseInt(p.m.slice(0, 4), 10);
      let eps = null;
      if (yr <= maxFy) eps = epsMap[yr] || null;
      else if (yr === maxFy + 1) eps = ttm;
      return { label: p.m.slice(2), v: eps ? p.c / eps : null };
    });
  renderLine("chart-pe", pts, { h: 150, unit: "x", ymin: 0, color: "#4cc3ff" });
}

/* ---------- 同行对比 ---------- */
const PEER_ORDER = ["TSLA", "F", "GM", "RIVN", "BYDDY"];
const PEER_COLORS = { TSLA: "#e82127", F: "#4a9eff", GM: "#f0a13c", RIVN: "#f5d020", BYDDY: "#35c08a" };
const PEER_ZH = { TSLA: "特斯拉", F: "福特", GM: "通用汽车", RIVN: "Rivian", BYDDY: "比亚迪" };

function peerStats(closes) {
  // closes: [[date, close], ...] ascending by date
  const n = closes.length;
  const last = closes[n - 1][1];
  const pct = function (k) {
    if (n <= k) return null;
    const base = closes[n - 1 - k][1];
    if (!base) return null;
    return (last / base - 1) * 100;
  };
  return { last: last, d1m: pct(21), d3m: pct(63), d6m: pct(n - 1) };
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

function renderPeers() {
  const grid = document.getElementById("peers-grid");
  const chartEl = document.getElementById("chart-peers");
  const verdictEl = document.getElementById("peers-verdict");
  const peers = cachedExtra && cachedExtra.peers;
  const tk = (peers && peers.tickers) || {};
  const avail = PEER_ORDER.filter(function (s) {
    return tk[s] && tk[s].closes && tk[s].closes.length > 20;
  });
  if (!avail.length) {
    grid.innerHTML = "";
    chartEl.innerHTML = '<p class="track-empty">同行股价数据整理中…</p>';
    if (verdictEl) verdictEl.textContent = "";
    return;
  }
  const zhName = function (s) { return (tk[s] && tk[s].zh) || PEER_ZH[s] || s; };
  grid.innerHTML = avail.map(function (s) {
    const st = peerStats(tk[s].closes);
    const c3 = st.d3m != null && st.d3m < 0 ? "down" : "up";
    return '<div class="peer-card">' +
      '<div class="peer-name"><span class="peer-dot" style="background:' +
      PEER_COLORS[s] + '"></span>' + esc(zhName(s)) +
      ' <span class="peer-sym">' + s + "</span></div>" +
      '<div class="peer-price num">$' + st.last.toFixed(2) + "</div>" +
      '<div class="peer-chgs"><span>1M ' + fmtPct(st.d1m) + "</span>" +
      '<span class="' + c3 + '">3M ' + fmtPct(st.d3m) + "</span></div>" +
      "</div>";
  }).join("");
  const ranked = avail.map(function (s) {
    return { s: s, v: peerStats(tk[s].closes).d3m || 0 };
  }).sort(function (a, b) { return b.v - a.v; });
  const tslaRank = ranked.findIndex(function (r) { return r.s === "TSLA"; }) + 1;
  if (verdictEl) {
    verdictEl.textContent = "近3个月 " + ranked.map(function (r) {
      return r.s + " " + fmtPct(r.v);
    }).join(" · ") + (tslaRank > 0 ? "；TSLA 排第 " + tslaRank + "/" + ranked.length : "");
  }
  // 归一化走势（起点=100）
  const H = 170, PT = 8, PB = 20, PL = 38, PR = 6;
  const W = CW - PL - PR;
  const norm = {};
  let lo = Infinity, hi = -Infinity;
  avail.forEach(function (s) {
    const cs = tk[s].closes, base = cs[0][1];
    norm[s] = cs.map(function (p) { return p[1] / base * 100; });
    norm[s].forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
  });
  if (hi <= lo) hi = lo + 1;
  const pad = (hi - lo) * 0.12 || 1;
  const tlo = lo - pad, thi = hi + pad;
  const n = norm[avail[0]].length;
  const X = function (i) { return PL + W * (n === 1 ? 0.5 : i / (n - 1)); };
  const Y = function (v) { return PT + (H - PT - PB) * (1 - (v - tlo) / (thi - tlo)); };
  let svg = "";
  for (let g = 0; g <= 3; g++) {
    const tv = tlo + (thi - tlo) * g / 3, y = Y(tv);
    svg += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (PL + W) +
      '" y2="' + y.toFixed(1) + '" class="grid"/>' +
      '<text x="' + (PL - 4) + '" y="' + (y + 3).toFixed(1) +
      '" class="ylab" text-anchor="end">' + Math.round(tv) + "</text>";
  }
  avail.forEach(function (s) {
    let d = "";
    norm[s].forEach(function (v, i) {
      d += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1) + " ";
    });
    svg += '<path d="' + d + '" class="cline" stroke="' + PEER_COLORS[s] + '"/>';
  });
  const dates = tk[avail[0]].closes.map(function (p) { return p[0]; });
  const seenMo = {};
  dates.forEach(function (dt, i) {
    const mo = dt.slice(0, 7);
    if (!(mo in seenMo)) seenMo[mo] = i;
  });
  Object.keys(seenMo).forEach(function (mo) {
    svg += '<text x="' + X(seenMo[mo]).toFixed(1) + '" y="' + (H - 6) +
      '" class="xlab" text-anchor="middle">' + parseInt(mo.slice(5), 10) +
      "月</text>";
  });
  chartEl.innerHTML = chartSvg(H, svg);
}

/* ---------- 投资逻辑 ----------
   支持 items:[{side:"bull|bear", ...}]（TSLA 口径）与 {bull:[], bear:[]}（NVDA 口径） */
function thStatusClass(status) {
  const s = String(status || "");
  if (/支持|确认|ok/i.test(s)) return "st-ok";
  if (/证伪|失效|bad/i.test(s)) return "st-bad";
  return "st-wait";
}

function thesisItemHtml(it) {
  const tags = [];
  if (it.horizon) tags.push('<span class="th-tag">' + esc(it.horizon) + "</span>");
  if (it.strength) tags.push('<span class="th-tag' +
    (it.strength === "强" ? " strong" : "") + '">' + esc(it.strength) + "</span>");
  if (it.status) tags.push('<span class="th-status ' + thStatusClass(it.status) + '">' +
    esc(it.status) + "</span>");
  return '<details class="thesis-item"><summary>' +
    '<span class="th-title">' + escTag(it.title) + "</span>" +
    '<span class="th-tags">' + tags.join("") + "</span></summary>" +
    "<p>" + escTag(it.detail) + "</p>" +
    (it.evidence ? '<p class="th-evidence">依据：' + escTag(it.evidence) + "</p>" : "") +
    "</details>";
}

function thesisGroup(title, items, cls) {
  const rows = items.map(thesisItemHtml).join("");
  return '<div class="thesis-col ' + cls + '"><h3>' + title + "</h3>" + rows + "</div>";
}

function renderThesis(th) {
  const el = document.getElementById("thesis");
  const rev = document.getElementById("thesis-reviewed");
  let bull = [], bear = [];
  if (th) {
    if (Array.isArray(th.items)) {
      th.items.forEach(function (it) {
        (it.side === "bear" ? bear : bull).push(it);
      });
    } else {
      bull = th.bull || [];
      bear = th.bear || [];
    }
  }
  if (!bull.length && !bear.length) {
    el.innerHTML = '<p class="track-empty">投资逻辑整理中…</p>';
    if (rev) rev.textContent = "";
    return;
  }
  if (rev) {
    const r = (th && (th.reviewed || (th._meta && th._meta.reviewed))) || "";
    rev.textContent = r ? "上次复核 " + r + " · 每财报季复核" : "";
  }
  el.innerHTML = '<div class="thesis">' +
    thesisGroup("看多 · BULL", bull, "bull") +
    thesisGroup("看空 · BEAR", bear, "bear") +
  "</div>";
}

/* ---------- 公司大事记 ----------
   支持 events:[{date,title,detail}]（TSLA 口径）与 milestones 口径 */
function renderCompany(h) {
  const el = document.getElementById("company");
  const evs = (h && (h.events || h.milestones)) || [];
  if (!evs.length) {
    el.innerHTML = '<p class="track-empty">公司大事记整理中…</p>';
    return;
  }
  const ceo = (h && h.ceo) || {
    name: "埃隆·马斯克", name_en: "Elon Musk",
    desc: "特斯拉 CEO（2008 年起）兼最大个人股东。公司的产品路线、定价策略与叙事高度围绕其个人决策展开，是理解特斯拉不可绕开的变量。"
  };
  let html = '<div class="ceo-card"><p class="ceo-eyebrow">CEO</p>' +
    '<p class="ceo-name">' + esc(ceo.name || "") +
    (ceo.name_en ? ' <span class="ceo-en">' + esc(ceo.name_en) + "</span>" : "") + "</p>" +
    '<p class="ceo-desc">' + escTag(ceo.desc || "") + "</p></div>";
  html += '<div class="hist">' + evs.map(function (m) {
    return '<div class="hist-item"><span class="hist-dot"></span><div class="hist-body">' +
      '<p class="hist-date num">' + esc(m.date || "") + '</p>' +
      '<p class="hist-title">' + escTag(m.title) + '</p>' +
      '<p class="hist-desc">' + escTag(m.detail || m.desc || "") + "</p></div></div>";
  }).join("") + "</div>";
  el.innerHTML = html;
}

/* ---------- 信号历史 ---------- */
function renderSignalHistory() {
  const el = document.getElementById("chart-signal");
  const entries = (cachedExtra && cachedExtra.signal && cachedExtra.signal.entries) || [];
  if (!entries.length) { el.innerHTML = TRACK_EMPTY; return; }
  const H = 150, PT = 12, PB = 20, PL = 26, PR = 8;
  const W = CW - PL - PR, n = entries.length;
  const YMAX = 5;
  const X = function (i) { return PL + (n === 1 ? W / 2 : W * i / (n - 1)); };
  const Y = function (v) { return PT + (H - PT - PB) * (1 - (v + YMAX) / (2 * YMAX)); };
  const vcolor = { "偏多": "#e82127", "中性": "#8a8f98", "偏空": "#35c08a" };
  let s = "";
  // verdict 背景带
  const bands = [];
  entries.forEach(function (e, i) {
    const b = bands[bands.length - 1];
    if (b && b.v === e.verdict) b.j = i; else bands.push({ v: e.verdict, i: i, j: i });
  });
  bands.forEach(function (b) {
    const x0 = X(b.i) - (n === 1 ? 0 : W / (n - 1) / 2), x1 = X(b.j) + (n === 1 ? 0 : W / (n - 1) / 2);
    s += '<rect x="' + Math.max(PL, x0).toFixed(1) + '" y="' + PT + '" width="' +
      (Math.min(PL + W, x1) - Math.max(PL, x0)).toFixed(1) + '" height="' + (H - PT - PB) +
      '" class="sig-band" fill="' + (vcolor[b.v] || "#8a8f98") + '"/>';
  });
  // 零线
  s += '<line x1="' + PL + '" y1="' + Y(0).toFixed(1) + '" x2="' + (PL + W) +
    '" y2="' + Y(0).toFixed(1) + '" class="grid"/>';
  // 阶梯线
  let d = "";
  entries.forEach(function (e, i) {
    const x = X(i), y = Y(Math.max(-YMAX, Math.min(YMAX, e.score)));
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    if (i < n - 1) d += "L" + X(i + 1).toFixed(1) + " " + y.toFixed(1) + " ";
  });
  s += '<path d="' + d + '" class="sig-line"/>';
  entries.forEach(function (e, i) {
    s += '<circle cx="' + X(i).toFixed(1) + '" cy="' +
      Y(Math.max(-YMAX, Math.min(YMAX, e.score))).toFixed(1) + '" r="2.6" class="sig-dot" fill="' +
      (vcolor[e.verdict] || "#8a8f98") + '"/>';
  });
  // x 轴日期（稀疏标注）
  const step = Math.max(1, Math.ceil(n / 5));
  for (let i = 0; i < n; i += step) {
    s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) +
      '" class="xlab" text-anchor="middle">' + esc(entries[i].date.slice(5)) + "</text>";
  }
  const last = entries[n - 1];
  s += '<text x="' + (PL + W) + '" y="' + (PT - 2) + '" class="xlab" text-anchor="end">最新：' +
    esc(last.verdict) + "（" + last.score + "分）</text>";
  el.innerHTML = chartSvg(H, s);
}

/* ---------- 跟踪屏 chips 导航 ---------- */
const TRACK_SECS = ["sec-delivery", "sec-mix", "sec-margin", "sec-energy",
  "sec-quarter", "sec-roadmap", "sec-valuation", "sec-peers",
  "sec-thesis", "sec-history", "sec-signal"];
let trackChipsInit = false;
function initTrackChips() {
  if (trackChipsInit) return;
  trackChipsInit = true;
  document.getElementById("track-chips").addEventListener("click", function (e) {
    const b = e.target.closest(".tchip");
    if (!b) return;
    const sec = document.getElementById(b.dataset.sec);
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  window.addEventListener("resize", syncChipsOffset);
}

/* chips 吸顶时贴在顶栏下方：量顶栏实际高度设 top，各 section 设 scroll-margin
   让点 chip 跳转时标题不被顶栏+chips 挡住 */
function syncChipsOffset() {
  const header = document.querySelector(".brand-header");
  const chips = document.getElementById("track-chips-wrap");
  if (!header || !chips) return;
  const hh = header.offsetHeight;
  chips.style.top = hh + "px";
  const ch = chips.offsetHeight;
  TRACK_SECS.forEach(function (id) {
    const s = document.getElementById(id);
    if (s) s.style.scrollMarginTop = (hh + ch + 10) + "px";
  });
}

/* ---------- 入门屏 ---------- */
function startNum(label, val, term) {
  const lab = term
    ? '<span class="term" data-term="' + esc(term) + '">' + esc(label) + "</span>"
    : esc(label);
  return '<div class="start-num"><span class="sn-label">' + lab + "</span>" +
    '<b class="sn-val num">' + val + "</b></div>";
}

function renderStart() {
  const numsEl = document.getElementById("start-nums");
  const risksEl = document.getElementById("start-risks");
  const q = latestQ();
  const gmQ = latestWith("auto_gm_ex_credits_pct");
  const fin = (cachedExtra && cachedExtra.financials && cachedExtra.financials.years) || [];
  const fy25 = fin.filter(function (y) { return y.fy === 2025; })[0];

  if (q) {
    numsEl.innerHTML =
      startNum("最新季交付", q.deliveries != null ? fmtWan(q.deliveries) + "万辆" : "—", "交付量") +
      startNum("汽车毛利率（扣积分）",
        gmQ ? gmQ.auto_gm_ex_credits_pct.toFixed(1) + "%" : "—", "汽车毛利率（扣积分）") +
      startNum("2025 年营收",
        fy25 && fy25.revenue_b != null ? "$" + fy25.revenue_b.toFixed(1) + "B" : "—", null) +
      startNum("能源装机TTM", (function () {
        const qs = quarters();
        let gwh = 0, n = 0;
        for (let i = qs.length - 1; i >= 0 && n < 4; i--) {
          if (qs[i].energy_gwh != null) { gwh += qs[i].energy_gwh; n++; }
        }
        return n ? gwh.toFixed(1) + " GWh" : "—";
      })(), "储能");
  } else {
    numsEl.innerHTML = '<p class="track-empty">数字加载中…</p>';
  }

  const th = cachedExtra && cachedExtra.thesis;
  let bears = [];
  if (th) {
    if (Array.isArray(th.items)) bears = th.items.filter(function (it) { return it.side === "bear"; });
    else bears = th.bear || [];
  }
  if (bears.length) {
    // 强风险优先，取 3 条
    const top = bears.slice().sort(function (a, b) {
      return (b.strength === "强" ? 1 : 0) - (a.strength === "强" ? 1 : 0);
    }).slice(0, 3);
    risksEl.innerHTML = top.map(thesisItemHtml).join("");
  } else {
    risksEl.innerHTML = '<p class="track-empty">加载中…</p>';
  }
  renderMix("mix-chart", "mix-legend");
  renderMixDonut("mix-donut");
}

function initStartCtas() {
  document.getElementById("goto-today").addEventListener("click", function () {
    showScreen("today");
  });
  document.getElementById("goto-history").addEventListener("click", function () {
    showScreen("track");
    setTimeout(function () {
      const c = document.getElementById("company");
      if (c) c.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  });
  const setHome = document.getElementById("set-home");
  try {
    if (localStorage.getItem("tsla_home") === "today") {
      setHome.textContent = "✓ 已设为默认进「今日」";
    }
  } catch (e) {}
  setHome.addEventListener("click", function () {
    try { localStorage.setItem("tsla_home", "today"); } catch (e) {}
    setHome.textContent = "✓ 已设为默认进「今日」";
  });
}

/* ---------- 首访分流 ---------- */
function initFirstVisit() {
  let seen = null;
  try { seen = localStorage.getItem("tsla_pulse_seen"); } catch (e) {}
  if (seen) return false;
  const fv = document.getElementById("first-visit");
  fv.hidden = false;
  fv.querySelectorAll(".fv-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      const h = b.dataset.home === "start" ? "start" : "today";
      try {
        localStorage.setItem("tsla_pulse_seen", "1");
        localStorage.setItem("tsla_home", h);
      } catch (e) {}
      fv.hidden = true;
      showScreen(h);
    });
  });
  return true;
}

/* ---------- load ---------- */
async function fetchJson(url) {
  const res = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* ---------- live price tick (cron -> data/quote.json) ---------- */
function applyLiveQuote() {
  if (!liveQuote || !cachedNews || !cachedNews.market) return;
  const m = cachedNews.market;
  m.price = liveQuote.price;
  m.change_pct = liveQuote.change_pct;
  m._live = true;
  renderMarket(m);
}

function fetchLiveQuote() {
  if (document.hidden) return;
  fetchJson(QUOTE_URL).then(function (q) {
    if (!q || typeof q.price !== "number") return;
    const ts = q.updated_at || q.as_of;
    if (!ts) return;
    const ageMs = Date.now() - new Date(ts).getTime();
    if (!(ageMs >= 0 && ageMs <= QUOTE_MAX_AGE_MS)) return; // stale: keep news.json quote
    if (liveQuote && (liveQuote.updated_at || liveQuote.as_of) === ts) return; // unchanged
    liveQuote = q;
    applyLiveQuote();
  }).catch(function () { /* keep last good quote, silent */ });
}

async function load() {
  try {
    const [news, earnings, roadmap, fleet, thesis, financials, price, history, targets, gloss, signal, fresh, peers] = await Promise.all([
      fetchJson(NEWS_URL),
      fetchJson(EARNINGS_URL).catch(() => null),
      fetchJson(ROADMAP_URL).catch(() => null),
      fetchJson(FLEET_URL).catch(() => null),
      fetchJson(THESIS_URL).catch(() => null),
      fetchJson(FIN_URL).catch(() => null),
      fetchJson(PRICE_URL).catch(() => null),
      fetchJson(HIST_URL).catch(() => null),
      fetchJson(TARGETS_URL).catch(() => null),
      fetchJson(GLOSS_URL).catch(() => null),
      fetchJson(SIG_URL).catch(() => null),
      fetchJson(FRESH_URL).catch(() => null),
      fetchJson(PEERS_URL).catch(() => null),
    ]);
    cachedNews = news;
    cachedExtra = { earnings, roadmap, fleet, thesis, financials, price, history, targets, signal, fresh, peers };
    setGlossary(gloss);
    renderToday(news);
    renderNews(news);
    renderTrack();
    renderFresh();
    renderStart();
  } catch (e) {
    const updatedEl = document.getElementById("updated-at");
    if (updatedEl) updatedEl.textContent = "加载失败，稍后重试";
  }
}

function initTabs() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t === btn));
    currentCat = btn.dataset.cat;
    if (cachedNews) renderNews(cachedNews);
  });
}

/* ---------- 历史搜索：按月归档，按需加载 ----------
   简化版：归档由管线生成；若归档不存在，静默回落到近 7 天。 */
async function ensureHistory() {
  if (historyPool) return historyPool;
  const idx = await fetchJson(ARCH_URL + "index.json");
  const months = Array.isArray(idx.months) ? idx.months : [];
  const files = await Promise.all(months.map((m) =>
    fetchJson(ARCH_URL + m + ".json").catch(() => null)));
  const seen = new Set();
  const pool = [];
  const recent = (cachedNews && cachedNews.stories) || [];
  const archived = [];
  for (const f of files) {
    if (f && Array.isArray(f.stories)) archived.push(...f.stories);
  }
  for (const s of recent.concat(archived)) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    pool.push(s);
  }
  pool.sort((a, b) =>
    String(b.published_at || "").localeCompare(String(a.published_at || "")));
  historyPool = pool;
  return pool;
}

function loadHistoryThenRender() {
  if (!cachedNews) return;
  if (historyPool || historyLoading) {
    if (historyPool) renderNews(cachedNews);
    return;
  }
  historyLoading = true;
  const timeline = document.getElementById("timeline");
  const empty = document.getElementById("empty");
  const countEl = document.getElementById("search-count");
  empty.hidden = true;
  countEl.hidden = true;
  timeline.innerHTML = '<div class="history-loading">正在加载历史新闻…</div>';
  ensureHistory().then(() => {
    historyLoading = false;
    if (cachedNews && searchScope === "history" && currentQuery) {
      renderNews(cachedNews);
    }
  }).catch(() => {
    // 归档不存在：隐藏"全部历史"按钮，回落到近 7 天
    historyLoading = false;
    historyUnavailable = true;
    document.querySelectorAll('#search-scope .scope-btn[data-scope="history"]').forEach((b) => {
      b.style.display = "none";
    });
    setScope("recent");
  });
}

function setScope(scope) {
  searchScope = scope;
  document.querySelectorAll("#search-scope .scope-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.scope === scope));
  if (!cachedNews) return;
  if (scope === "history" && currentQuery && !historyUnavailable) loadHistoryThenRender();
  else renderNews(cachedNews);
}

function onQueryChange() {
  currentQuery = document.getElementById("search").value.trim();
  document.getElementById("search-clear").hidden = !currentQuery;
  document.getElementById("search-scope").hidden = !currentQuery;
  if (!currentQuery && searchScope !== "recent") {
    setScope("recent");
    return;
  }
  if (!cachedNews) return;
  if (searchScope === "history" && currentQuery) loadHistoryThenRender();
  else renderNews(cachedNews);
}

function initSearch() {
  const input = document.getElementById("search");
  const clear = document.getElementById("search-clear");
  input.addEventListener("input", onQueryChange);
  clear.addEventListener("click", () => {
    input.value = "";
    onQueryChange();
    input.blur();
  });
  document.querySelectorAll("#search-scope .scope-btn").forEach((b) =>
    b.addEventListener("click", () => setScope(b.dataset.scope)));
}

initNav();
initTabs();
initSearch();
initGlossary();
initStartCtas();
load();
setInterval(load, REFRESH_MS);
fetchLiveQuote();
setInterval(fetchLiveQuote, QUOTE_POLL_MS);
