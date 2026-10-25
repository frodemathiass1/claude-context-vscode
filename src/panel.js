(function () {
  "use strict";
  const countEl = document.querySelector('[data-testid="count"]');
  const scopeWorkspaceEl = document.querySelector('[data-testid="scope-workspace"]');
  const scopeAllEl = document.querySelector('[data-testid="scope-all"]');
  const scopeNameEl = document.querySelector('[data-testid="scope-name"]');
  const scopeMoreEl = document.querySelector('[data-testid="scope-more"]');
  const errorsEl = document.querySelector('[data-testid="errors"]');
  const listEl = document.querySelector('[data-testid="list"]');
  const zoneScaleEl = document.querySelector('[data-testid="zone-scale"]');
  const zoneCountsEl = document.querySelector(".kx-zone-counts");
  const cacheWarmEl = document.querySelector('[data-testid="cache-warm"]');
  const cacheColdEl = document.querySelector('[data-testid="cache-cold"]');
  const startMedianEl = document.querySelector('[data-testid="start-median"]');
  const abandonedEl = document.querySelector('[data-testid="abandoned-count"]');
  const ABANDONED_WHY = abandonedEl.title;
  const cacheCountsEl = document.querySelector('[data-testid="cache-counts"]');
  const refreshEl = document.querySelector('[data-testid="refresh"]');
  const compactEl = document.querySelector('[data-testid="compact"]');
  const refreshedEl = document.querySelector('[data-testid="refreshed"]');
  const showingEl = document.querySelector('[data-testid="showing"]');
  const sortEl = document.querySelector('[data-testid="sort"]');
  const hotEl = document.querySelector('[data-testid="filter-hot"]');
  const modelsEl = document.querySelector('[data-testid="models"]');
  const resetEl = document.querySelector('[data-testid="reset"]');
  const headerEl = document.querySelector("header");
  const controlsEl = document.querySelector('[data-testid="controls"]');
  const detailEl = document.querySelector('[data-testid="detail"]');
  const vscode = acquireVsCodeApi();

  // ── Remembered choices (the folded groups, the view, the open session): the webview's state ──
  const store = {
    get(key) { return (vscode.getState() || {})[key]; },
    set(key, value) { vscode.setState({ ...(vscode.getState() || {}), [key]: value }); },
  };
  // group keys: "busy", "waiting", "idle" and "abandoned" fold that group in every project; "project:<name>" folds a whole project.
  // A group in FOLDED_FIRST starts folded, so `unfolded` remembers the opposite choice for it.
  const FOLDED_FIRST = ["abandoned"];
  const keys = (name) => new Set(Array.isArray(store.get(name)) ? store.get(name).filter((k) => typeof k === "string") : []);
  const folded = keys("folded"), unfolded = keys("unfolded");
  const isFolded = (key) => (FOLDED_FIRST.includes(key) ? !unfolded.has(key) : folded.has(key));
  function toggleFold(key) {
    const set = FOLDED_FIRST.includes(key) ? unfolded : folded;
    if (set.has(key)) set.delete(key); else set.add(key);
    store.set(set === folded ? "folded" : "unfolded", [...set]);
  }
  let lastData = null; // the last list rendered, drawn again when a group is folded or unfolded, or the view changes

  // ── The view: the sort and the filters, remembered like the folds. The sort orders the rows inside each
  // group (busy stays first); the filters apply to the idle groups only, a busy or waiting session is never hidden.
  // hiddenModels holds short model names the user switched off; a model that leaves the list takes its choice with it. ──
  const SORTS = ["last", "size", "cold", "started", "title"];
  const VIEW_DEFAULT = { sort: "last", hotOnly: false, hiddenModels: [] };
  function loadView() {
    const v = store.get("view");
    const o = v && typeof v === "object" ? v : {};
    return {
      sort: SORTS.includes(o.sort) ? o.sort : VIEW_DEFAULT.sort, hotOnly: !!o.hotOnly,
      hiddenModels: Array.isArray(o.hiddenModels) ? o.hiddenModels.filter((m) => typeof m === "string") : [],
    };
  }
  let view = loadView();
  function saveView() { store.set("view", view); if (lastData) render(lastData); }
  const viewIsDefault = () => view.sort === VIEW_DEFAULT.sort && !view.hotOnly && !view.hiddenModels.length;
  const modelName = (s) => s.modelShort || "unknown";
  const HOT_ZONES = ["orange", "red"];
  function passes(s) {
    if (s.busy || s.waiting) return true;
    if (view.hotOnly && !HOT_ZONES.includes(s.zone)) return false;
    return !view.hiddenModels.includes(modelName(s));
  }
  // the sort key per row: null sorts last, ties keep the list's order (busy first, then waiting, then last turn newest first)
  const NO_DEADLINE = Number.MAX_SAFE_INTEGER; // a cold cache has no time until cold: after every warm one, before unknown
  const SORT_KEY = {
    last: () => 0,
    size: (s) => (Number.isFinite(s.tokens) ? -s.tokens : null),
    cold: (s) => (!Number.isFinite(s.coldInMs) ? null : s.coldInMs > 0 ? s.coldInMs : NO_DEADLINE),
    started: (s) => { const t = Date.parse(s.startedAt); return Number.isFinite(t) ? -t : null; },
    title: (s) => (s.title ? String(s.title).toLocaleLowerCase() : null),
  };
  function sorted(list) {
    const key = SORT_KEY[view.sort] || SORT_KEY.last;
    return list.map((s, i) => ({ s, i, k: key(s) }))
      .sort((a, b) => {
        if (a.k === null || b.k === null) return (a.k === null) - (b.k === null) || a.i - b.i;
        return (typeof a.k === "string" ? a.k.localeCompare(b.k) : a.k - b.k) || a.i - b.i;
      })
      .map((x) => x.s);
  }

  // ── The zones and the scale, as data. The core decides a session's zone (core.cjs zone()) and sends the zones
  // with every list (core.cjs ZONE_LIST): their limits, range texts and advice. This list orders the zones in the
  // counts, names them, and picks the colour pair --kx-<zone> (text) and --kx-<zone>-fill (fills) defined in the
  // style above. LIMITS, taken from the core's zones (applyZones), are the boundaries drawn as dashed lines on the
  // curve, gaps on the context bar and labels on the axis; SCALE is the full width of the bar and the strip.
  // A new zone is one entry here, one in the core and one colour pair in the style. ─────────────────
  const ZONES = ["green", "orange", "red"];
  const ZONE_NAME = Object.fromEntries(ZONES.map((z) => [z, z]));
  let LIMITS = [], ZONE_LIST = [], MARKS_TEXT = ""; // until the first list with zones: no limits drawn, no marks named
  // past red's 200K, so the red band is on the strip and few sessions run off the bar: of the owner's 395 sessions in
  // the 60 days to 2026-10-25 (peak context, counts only), 18 % went above 200K and 7 % above 300K (#58)
  const SCALE = 300000;
  // The prompt cache (core.cjs: cacheTtlMs, coldInMs, hitShare). The core decides warm, cold and "soon"
  // (cacheSoon); the panel only shows the state, it never sends a turn.
  const TTL_TEXT = { 3600000: "1h", 300000: "5m" };
  const TTL_WORDS = { "1h": "1-hour", "5m": "5-minute" };
  /** The TTL as a pill ("1h", or "5m" in orange), for the row's cache item and the detail's facts; null for another or none. */
  function ttlPill(session) {
    const ttl = TTL_TEXT[session.cacheTtlMs];
    if (!ttl) return null;
    const pill = el("span", "kx-ttl", ttl);
    pill.dataset.ttl = ttl;
    return pill;
  }

  // ── Rendering (DOM API only, never innerHTML with data) ────────────────────
  // the number format ("850", "43K", "1.2M", "unknown") is the core's: panelPage puts its source here (core.cjs PANEL_FROM_CORE)
  /* core: tokensText */

  function sinceText(ms) {
    if (ms === null || ms === undefined) return "no turn";
    if (ms < 60000) return "just now";
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  /** "47 min" until the cache goes cold; "<1 min" in the last minute. The TTL is at most an hour, so minutes suffice. */
  function leftText(ms) {
    return ms < 60000 ? "<1 min" : `${Math.ceil(ms / 60000)} min`;
  }

  /** "1 min 54 s", "40 s"; empty without a number. */
  function durationText(ms) {
    if (!Number.isFinite(ms)) return "";
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  }

  /** "auto-compacted 1.0M → 66K (1 min 54 s)": one compaction for the curve's tooltip. */
  function compactionText(c) {
    const how = c.trigger === "auto" ? "auto-compacted" : c.trigger === "manual" ? "compacted (/compact)" : "compacted";
    const counts = Number.isFinite(c.preTokens) && Number.isFinite(c.postTokens) ? ` ${tokensText(c.preTokens)} → ${tokensText(c.postTokens)}` : "";
    const took = durationText(c.durationMs);
    return `${how}${counts}${took ? ` (${took})` : ""}`;
  }

  // made once: toLocaleTimeString builds a formatter per call, about 111 µs against 1.5 µs for a kept one (measured
  // 2026-10-25, #67), and a list formats a time for every warm row
  const CLOCK = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
  const DAY = new Intl.DateTimeFormat([], { day: "2-digit", month: "short" });
  function clockText(iso) {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? CLOCK.format(d) : "";
  }

  /** "200K", "150K and 200K", "a, b and c": the limits as words for tooltips. */
  function listText(items) {
    return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** "24 Oct 00:06": a day and a time for the facts table; "unknown" without a date. */
  function dayText(iso) {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? `${DAY.format(d)} ${clockText(iso)}` : "unknown";
  }

  /** The title as the core composed it (titleText), marked when it is "new session" or "untitled session". */
  function titled(e, session) {
    e.textContent = session.titleText || "";
    if (session.titleFallback) e.dataset.fallback = "";
    return e;
  }
  const startText = (session) => (session.startedAt ? `started ${clockText(session.startedAt)}` : "start unknown");
  /** The count, or "—" before the first turn: an empty session is not an unknown count. */
  const countText = (session) => (session.turns || Number.isFinite(session.tokens) ? tokensText(session.tokens) : "—");
  const countLabel = (session) => (session.turns || Number.isFinite(session.tokens) ? `${tokensText(session.tokens)} tokens, zone ${ZONE_NAME[session.zone] || "unknown"}` : "no turns yet");
  const SCALE_TEXT = `0–${tokensText(SCALE)}`;
  const share = (tokens) => (Number.isFinite(tokens) ? Math.min(1, tokens / SCALE) : 0);
  const pct = (n) => String(Math.round(n * 10000) / 100);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    return e;
  }

  /**
   * Marks an element with its zone: data-zone for styling and tests, and the two custom properties the
   * style reads (--kx-zone-fill, --kx-zone-text), set through the CSSOM (allowed under the CSP, unlike a
   * style attribute). Children inherit them, so one call per row colours the dot, the bar, the curve and
   * the count. An unknown zone sets neither, and the style falls back to the muted colour.
   */
  function zoned(e, zone) {
    const known = ZONES.includes(zone);
    e.dataset.zone = known ? zone : "unknown";
    if (known) {
      e.style.setProperty("--kx-zone-fill", `var(--kx-${zone}-fill)`);
      e.style.setProperty("--kx-zone-text", `var(--kx-${zone})`);
    }
    return e;
  }

  // Icons: Lucide paths drawn inline (no image files, no icon font)
  const ICON = {
    clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 6v6l4 2"],
    repeat: ["m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"],
    cpu: ["M4 4h16v16H4z", "M9 9h6v6H9z", "M9 1v3", "M15 1v3", "M9 20v3", "M15 20v3", "M20 9h3", "M20 14h3", "M1 9h3", "M1 14h3"],
    zap: ["M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"],
    folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
    moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
    timer: ["M10 2h4", "m12 14 3-3", "M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"],
    pen: ["M12 20h9", "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"],
    chevron: ["m9 18 6-6-6-6"],
    refresh: ["M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16", "M16 16h5v5"],
    back: ["m12 19-7-7 7-7", "M19 12H5"],
    play: ["M5 3v18l15-9z"],
    rows: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M21 9H3", "M21 15H3"],
    bot: ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
    bell: ["M10.268 21a2 2 0 0 0 3.464 0", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"],
  };
  function icon(name) {
    const svg = svgEl("svg", { class: "kx-ico", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    for (const d of ICON[name]) svg.appendChild(svgEl("path", { d }));
    return svg;
  }

  // ── Sparkline: tokens per turn, oldest left. The viewBox is 100 × 24 and stretched to its column
  // (preserveAspectRatio none), so x is the turn's share of the width and strokes are non-scaling. The
  // y-axis runs from 0 to the larger of SCALE and the series' top, so the limit lines always show and rows
  // compare. Fewer than two points: no curve.
  const CURVE_W = 100, CURVE_H = 24;
  const num = (n) => String(Math.round(n * 100) / 100);

  /** The dips and the compactions of a session that fall on its series, for the row's curve and the detail's. */
  function curveMarks(session, series) {
    return {
      dips: Array.isArray(session.dips) ? session.dips.filter((i) => i > 0 && i < series.length) : [],
      compactions: Array.isArray(session.compactions) ? session.compactions.filter((c) => c && c.at >= 0 && c.at < series.length) : [],
    };
  }

  /**
   * What the row's curve and the detail's draw alike into `svg` (w × h, with `x` and `y` from index and tokens):
   * a dashed line per limit, the area and the line, a dotted line per dip and a solid one per compaction. `turn`
   * gives their data-turn: the row's index, the detail's turn number.
   */
  function drawCurve(svg, { series, dips, compactions, x, y, w, h, turn }) {
    for (const g of LIMITS) svg.appendChild(svgEl("line", { class: "kx-limit", "data-limit": g, x1: 0, x2: w, y1: num(y(g)), y2: num(y(g)), "vector-effect": "non-scaling-stroke" }));
    const points = series.map((v, i) => `${num(x(i))},${num(y(v))}`).join(" L");
    svg.appendChild(svgEl("path", { class: "kx-area", d: `M0,${h} L${points} L${w},${h} Z` }));
    svg.appendChild(svgEl("path", { class: "kx-line", d: `M${points}`, "vector-effect": "non-scaling-stroke" }));
    for (const i of dips) svg.appendChild(svgEl("line", { class: "kx-dip", "data-turn": turn(i), x1: num(x(i)), x2: num(x(i)), y1: 0, y2: h, "vector-effect": "non-scaling-stroke" }));
    for (const c of compactions) svg.appendChild(svgEl("line", { class: "kx-compact", "data-turn": turn(c.at), "data-trigger": c.trigger || "unknown", x1: num(x(c.at)), x2: num(x(c.at)), y1: 0, y2: h, "vector-effect": "non-scaling-stroke" }));
  }

  /** The turn number of the series' first point (core.cjs firstTurn: the list keeps the last SERIES_MAX turns), 1 without a usable one. */
  const firstTurnOf = (session) => (Number.isInteger(session.firstTurn) && session.firstTurn >= 1 ? session.firstTurn : 1);

  function curveFor(session) {
    // the core only pushes numbers, and dips index this very list, so it is drawn as it comes
    const series = Array.isArray(session.series) ? session.series : [];
    if (series.length < 2) return null;
    const top = Math.max(SCALE, ...series);
    const x = (i) => (i / (series.length - 1)) * CURVE_W;
    const y = (v) => CURVE_H - 1 - (v / top) * (CURVE_H - 2); // 1 px margin top and bottom for the stroke
    const { dips, compactions } = curveMarks(session, series);
    const label = `Tokens per turn, ${plural(series.length, "turn", "turns")}, ${plural(compactions.length, "compaction", "compactions")}, ${plural(dips.length, "other drop", "other drops")}`;
    const svg = svgEl("svg", {
      class: "kx-curve", viewBox: `0 0 ${CURVE_W} ${CURVE_H}`, preserveAspectRatio: "none", role: "img",
      "data-testid": "curve", "data-points": series.length, "aria-label": label,
    });
    const title = svgEl("title", {});
    const first = firstTurnOf(session);
    const marks = compactions.map((c) => ` · turn ${first + c.at}: ${compactionText(c)}`).join("");
    title.textContent = `${label} · ${MARKS_TEXT ? `dashed lines at ${MARKS_TEXT}` : "no limits yet"}${marks}${dips.length ? " · dotted marks: drops without a compaction entry" : ""}`;
    svg.appendChild(title);
    drawCurve(svg, { series, dips, compactions, x, y, w: CURVE_W, h: CURVE_H, turn: (i) => i });
    return svg;
  }

  const OUT_H = 8;
  /**
   * The output bars into `svg`, for the row's strip and the detail's field: per turn its output (faint) and the
   * thinking part of it (strong) over it, rising from `base` by up to `height` for the largest turn (`top`), in
   * slots `slot` wide after `offset` empty ones; a gap between the bars while there are 60 slots or fewer.
   */
  function drawOutput(svg, { output, thinking, top, offset, slot, base, height }) {
    const gap = offset + output.length <= 60 ? slot * 0.2 : 0;
    const bar = (o, v) => (v > 0 ? `M${num((o + offset) * slot)},${base} h${num(slot - gap)} v${num(-(v / top) * height)} h${num(gap - slot)} Z` : "");
    svg.appendChild(svgEl("path", { class: "kx-out-all", d: output.map((v, o) => bar(o, v)).join(" ") || "M0,0" }));
    svg.appendChild(svgEl("path", { class: "kx-out-think", d: output.map((v, o) => bar(o, Math.min(thinking[o] || 0, v || 0))).join(" ") || "M0,0" }));
  }

  /**
   * Output per turn as bars under the curve, one per turn of the series (the output series is aligned to its
   * right end, so an older state with a shorter one still lines up), scaled to the session's own largest turn.
   * The thinking part of each bar is drawn over it, from the bottom. Nothing when no turn wrote anything. The
   * row's strip; the detail view has its own field around the same bars (detailCurve).
   */
  function outputFor(session) {
    const series = Array.isArray(session.series) ? session.series : [];
    const output = Array.isArray(session.outputSeries) ? session.outputSeries.slice(-series.length) : [];
    const thinking = Array.isArray(session.thinkingSeries) ? session.thinkingSeries.slice(-series.length) : [];
    const top = Math.max(0, ...output);
    if (series.length < 2 || !top) return null;
    const svg = svgEl("svg", { class: "kx-out", viewBox: `0 0 ${CURVE_W} ${OUT_H}`, preserveAspectRatio: "none", role: "img", "data-testid": "output", "data-bars": output.length, "aria-label": `Output tokens per turn, largest ${tokensText(top)}` });
    const title = svgEl("title", {});
    title.textContent = `Output tokens per turn (faint) and the thinking part of them (strong), scaled to the largest turn: ${tokensText(top)}`;
    svg.appendChild(title);
    drawOutput(svg, { output, thinking, top, offset: series.length - output.length, slot: CURVE_W / series.length, base: OUT_H, height: OUT_H });
    return svg;
  }

  /** "48K out" with the last turn and the thinking share in the tooltip; null before the first turn. */
  function outputMeta(session) {
    if (!session.turns || !Number.isFinite(session.outputTotal)) return null;
    const span = metaItem("pen", `${tokensText(session.outputTotal)} out`);
    span.dataset.testid = "output-total";
    const last = Number.isFinite(session.lastOutput) ? `last turn ${tokensText(session.lastOutput)} out, ${tokensText(session.lastThinking)} thinking · ` : "";
    const shareText = Number.isFinite(session.thinkingShare) ? `, ${Math.round(session.thinkingShare * 100)} % thinking` : "";
    span.title = `Output: ${last}session ${tokensText(session.outputTotal)} out${shareText} · what the model writes is read back as input on the next turn`;
    return span;
  }

  /** "browser_click" for "mcp__smoketest__browser_click": an MCP tool by its own name, without the server. */
  const sourceName = (source) => (/^mcp__/.test(source) ? source.split("__").pop() : source);
  const GROWTH_TOP = 3;
  const GROWTH_HOW = "per turn, what the model wrote (output) first, the rest split by length over the tool results (by tool), your messages (you) and attachments and reminders (other); a fall is not counted";
  const growthRows = (session) => (Array.isArray(session.growth) ? session.growth : []);
  const growthSince = (session) => (session.baselineCause === "compaction" ? "since the compaction" : "since the first turn");

  /**
   * "≈ Bash 39K · Read 27K · output 10K": the largest sources of the segment's growth (core.cjs growth, largest
   * first), every source in the tooltip with its share. Nothing before the second turn of a segment.
   */
  function growthFor(session) {
    const list = growthRows(session);
    if (!list.length) return null;
    const line = el("div", "kx-growth", `≈ ${list.slice(0, GROWTH_TOP).map((g) => `${sourceName(g.source)} ${tokensText(g.tokens)}`).join(" · ")}`);
    line.dataset.testid = "growth";
    line.title = `Where the context grew ${growthSince(session)}, estimated: ${list.map((g) => `${sourceName(g.source)} ${tokensText(g.tokens)} (${Math.round(g.share * 100)} %)`).join(", ")} · ${GROWTH_HOW}`;
    return line;
  }

  /** "start 62K · conversation 41K", or "start after compaction 35K · …"; empty without a baseline. */
  function baselineText(session) {
    if (!Number.isFinite(session.baseline) || !Number.isFinite(session.tokens)) return "";
    const start = session.baselineCause === "compaction" ? "start after compaction" : "start";
    return `${start} ${tokensText(session.baseline)} · conversation ${tokensText(Math.max(0, session.tokens - session.baseline))}`;
  }

  /**
   * The context bar: the fill is the count's share of SCALE, its first part the segment's start (the baseline)
   * in a muted shade, a gap at every limit, a hatched end above SCALE; the tooltip carries the split and the zone's advice.
   */
  function barFor(session) {
    const bar = el("div", "kx-bar");
    bar.setAttribute("role", "img");
    bar.dataset.testid = "bar";
    const known = Number.isFinite(session.tokens);
    const advice = session.advice ? ` · ${session.advice}` : ""; // the zone's advice, from the core (core.cjs contextFacts)
    const split = baselineText(session);
    bar.title = known ? `${tokensText(session.tokens)} tokens in the context${split ? `: ${split}` : ""} · scale ${SCALE_TEXT}${MARKS_TEXT ? `, marks at ${MARKS_TEXT}` : ""}${advice}` : "no count yet";
    bar.setAttribute("aria-label", !known ? "no count" : session.tokens > SCALE ? `over the ${tokensText(SCALE)} scale` : `${Math.round(share(session.tokens) * 100)} % of the ${tokensText(SCALE)} scale`);
    const fill = el("span", "kx-fill" + (session.busy ? " kx-busy" : ""));
    fill.style.setProperty("--p", pct(share(session.tokens)));
    if (split) {
      const base = el("span", "kx-base");
      base.dataset.testid = "baseline";
      base.dataset.cause = session.baselineCause || "unknown";
      base.style.setProperty("--b", pct(Math.min(1, session.baseline / session.tokens)));
      fill.appendChild(base);
    }
    bar.appendChild(fill);
    for (const g of LIMITS) {
      const tick = el("span", "kx-tick");
      tick.style.setProperty("--t", pct(g / SCALE));
      bar.appendChild(tick);
    }
    if (known && session.tokens > SCALE) bar.appendChild(el("span", "kx-over"));
    return bar;
  }

  const WAITING_TEXT = "Waiting for you: a permission prompt, a question or a dialog in this session";
  /** A badge: its icon and text, with an extra class ("kx-wait") and a tooltip when given; one markup for all. */
  function badgeEl(name, text, { className = "", title = "" } = {}) {
    const span = el("span", "kx-badge" + (className ? ` ${className}` : ""));
    if (title) span.title = title;
    span.appendChild(icon(name));
    span.appendChild(document.createTextNode(text));
    return span;
  }

  /**
   * The zone dot (pulsing while busy) and the badge for the row's title line and the detail's head: "busy" while the
   * session works, "waiting" while it waits for the user (a permission prompt, a question, a dialog), else none.
   */
  function dotAndBadge(session) {
    const dot = el("span", "kx-dot" + (session.busy ? " kx-pulse" : ""));
    dot.title = `Zone: ${ZONE_NAME[session.zone] || "unknown"}`;
    if (session.busy) return { dot, badge: badgeEl("zap", "busy") };
    if (session.waiting) return { dot, badge: badgeEl("bell", "waiting", { className: "kx-wait", title: WAITING_TEXT }) };
    return { dot, badge: null };
  }

  /** An item of a meta line, the row's or the detail's: an icon and its text. */
  function metaItem(name, text, className) {
    const span = el("span", className);
    span.appendChild(icon(name));
    span.appendChild(document.createTextNode(text));
    return span;
  }

  /** "Opus 5.5 · xhigh": the model and the effort of the last turn. */
  const modelEffort = (session) => (session.modelShort || "unknown") + (session.effort ? ` · ${session.effort}` : "");

  function rowFor(session) {
    const row = zoned(el("article", "kx-session" + (session.dimmed ? " kx-dimmed" : "")), session.zone);
    row.dataset.session = session.sessionId || "";
    if (session.sessionId) {
      // the whole row is the click target; clicks and keys are handled once on the list (openFromList)
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Open details: ${session.titleText || ""}, ${countLabel(session)}`);
    }
    const titleRow = el("div", "kx-row-title");
    const { dot, badge } = dotAndBadge(session);
    titleRow.appendChild(dot);
    const title = titled(el("div", "kx-title"), session);
    title.title = title.textContent;
    titleRow.appendChild(title);
    if (badge) titleRow.appendChild(badge);
    row.appendChild(titleRow);
    const count = el("div", "kx-count");
    const tokens = zoned(el("div", "kx-num", countText(session)), session.zone);
    tokens.dataset.testid = "tokens";
    tokens.setAttribute("aria-label", countLabel(session));
    count.appendChild(tokens);
    if (ZONE_NAME[session.zone]) count.appendChild(el("span", "kx-zone-txt", ZONE_NAME[session.zone]));
    row.appendChild(count);
    const barCol = el("div", "kx-bar-col");
    barCol.appendChild(barFor(session));
    const growth = growthFor(session);
    if (growth) barCol.appendChild(growth);
    row.appendChild(barCol);
    const curveWrap = el("div", "kx-curve-wrap");
    curveWrap.appendChild(curveFor(session) || el("span", "kx-nocurve", session.turns ? "one turn, no curve yet" : "no turns yet"));
    const outputBars = outputFor(session);
    if (outputBars) curveWrap.appendChild(outputBars);
    row.appendChild(curveWrap);
    const meta = el("div", "kx-meta");
    const add = (name, text) => meta.appendChild(metaItem(name, text));
    if (!session.turns) add("play", startText(session)); // no model, turns or last turn to show yet; the curve says "no turns yet"
    else {
      add("cpu", modelEffort(session));
      if (session.effort) meta.lastChild.title = `Model and the effort level of the last turn`;
      add("repeat", plural(session.turns, "turn", "turns"));
      const output = outputMeta(session);
      if (output) meta.appendChild(output);
      add("clock", sinceText(session.sinceMs));
    }
    const agents = subagentsMeta(session);
    if (agents) meta.appendChild(agents);
    const cache = cacheFor(session);
    if (cache) meta.appendChild(cache);
    row.dataset.cache = cache ? cache.dataset.cache : "unknown";
    row.appendChild(meta);
    return row;
  }

  // why a subagent's count is not the session's (core.cjs parseTranscript: the report enters as the Agent call's result)
  const AGENTS_WHY = "A subagent has a context window of its own; what returns to this session is its report, counted under \"Agent\".";
  /** 'Explore "Find the CSS"': a subagent by its type and the description of its call, as far as they are known. */
  const agentName = (a) => [a.type, a.description ? `"${a.description}"` : null].filter(Boolean).join(" ") || "a subagent";

  /**
   * "2 subagents · 1 running" (core.cjs subagentSummary), in the zone's colour when the largest of them is orange or
   * red; the tooltip names the largest. Nothing for a session without subagents, so its row is no taller.
   */
  function subagentsMeta(session) {
    const a = session.subagents;
    if (!a || !(a.count > 0)) return null;
    const span = metaItem("bot", plural(a.count, "subagent", "subagents") + (a.running ? ` · ${a.running} running` : ""), "kx-agents");
    span.dataset.testid = "subagents";
    span.dataset.zone = ZONES.includes(a.zone) ? a.zone : "unknown";
    const largest = a.largest ? `largest: ${agentName(a.largest)} at ${tokensText(a.largest.tokens)}, ${ZONE_NAME[a.zone] || "unknown"} zone` : "no count yet";
    span.title = `Subagents: ${a.count}, ${a.running} running · ${largest} · ${AGENTS_WHY}`;
    return span;
  }

  /**
   * What a row shows, as one string: the zones and the session, with the two fields that change on every list
   * (sinceMs, coldInMs) as the texts they give. A row whose key is the live row's is not built again (render's
   * rowOf); building and diffing every row took about 27 ms per list of 30 sessions in Chrome, keeping the unchanged
   * ones about 2 ms (2026-10-25, #67). A new text in a row that depends on the time goes in here.
   */
  function rowKey(session) {
    const cold = Number.isFinite(session.coldInMs) ? leftText(session.coldInMs) : null;
    return `${zonesKey}|${JSON.stringify({ ...session, sinceMs: sinceText(session.sinceMs), coldInMs: cold })}`;
  }

  /**
   * The prompt cache of a session: "warm · 47 min" or "cold" with the TTL as a pill; the tooltip has the
   * deadline, the hit share of the last turn (read from cache / context) and the tokens written. Nothing
   * without a TTL (a transcript from before Claude Code wrote usage.cache_creation).
   */
  function cacheFor(session) {
    if (session.cacheState !== "warm" && session.cacheState !== "cold") return null; // no TTL
    const state = session.cacheState === "cold" ? "cold" : session.cacheSoon ? "soon" : "warm";
    const span = metaItem("timer", state === "cold" ? "cold" : `warm · ${leftText(session.coldInMs)}`, "kx-cache");
    span.dataset.testid = "cache";
    span.dataset.cache = state;
    const pill = ttlPill(session);
    if (pill) span.appendChild(pill);
    const ttl = TTL_TEXT[session.cacheTtlMs];
    const hit = Number.isFinite(session.hitShare) ? `${Math.round(session.hitShare * 100)} %` : "unknown";
    const read = Number.isFinite(session.cacheRead) ? tokensText(session.cacheRead) : "unknown";
    const written = Number.isFinite(session.cacheCreated) ? tokensText(session.cacheCreated) : "unknown";
    const ttlText = TTL_WORDS[ttl] || "unknown";
    const when = state === "cold" ? `cold since ${clockText(session.coldAt)}` : `cold at ${clockText(session.coldAt)} unless a turn is sent (in ${leftText(session.coldInMs)})`;
    span.title = `Prompt cache: ${ttlText} TTL, ${when} · last turn: ${read} read from cache (${hit} of the context), ${written} written · a cold cache rewrites the whole context on the next turn`;
    return span;
  }

  /**
   * A group heading whose whole text is a fold button: aria-expanded says whether the rows under it are
   * drawn, the count stays visible when folded. `key` is the group's name in `folded` (or `unfolded`); the rows under it
   * come from rowsFor(), which links them through aria-controls. A click is handled once on the list (the fold
   * listener below), so a heading kept from the last list needs no listener of its own.
   */
  function groupHeading(text, n, iconName, className, key) {
    const h = el("h2", "kx-group" + (className ? ` ${className}` : ""));
    const open = !isFolded(key);
    const btn = el("button", "kx-fold");
    btn.type = "button";
    btn.dataset.testid = "fold";
    btn.dataset.group = key;
    btn.setAttribute("aria-expanded", String(open));
    btn.title = `${open ? "Collapse" : "Expand"} ${text}`;
    const chev = icon("chevron");
    chev.classList.add("kx-chev");
    btn.appendChild(chev);
    btn.appendChild(icon(iconName));
    btn.appendChild(document.createTextNode(text));
    btn.appendChild(el("span", "kx-gn", `· ${n}`));
    h.appendChild(btn);
    return h;
  }

  /** The rows container of a group, linked from its heading's button; null when the group is folded (nothing is drawn). */
  function rowsFor(heading, idKey) {
    if (heading.firstChild.getAttribute("aria-expanded") !== "true") return null;
    const rows = el("div", "kx-rows");
    rows.dataset.key = `rows:${idKey}`;
    // every other character as its code, so no two keys share an id (a project named "busy" against the busy group of "project")
    rows.id = `kx-rows-${idKey.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    heading.firstChild.setAttribute("aria-controls", rows.id);
    return rows;
  }

  /** The axis line above a group in the wide layout: the column names and the bar's marks at their positions. */
  function axisLine() {
    const axis = el("div", "kx-axis");
    axis.setAttribute("aria-hidden", "true");
    axis.appendChild(el("span", "", "session"));
    const scale = el("div", "kx-scale");
    for (const v of [0, ...LIMITS, SCALE]) {
      const s = el("span", "", tokensText(v));
      s.style.setProperty("--t", pct(v / SCALE));
      scale.appendChild(s);
    }
    axis.appendChild(scale);
    axis.appendChild(el("span", "", "tokens per turn"));
    axis.appendChild(el("span", "kx-r", "context"));
    return axis;
  }

  /**
   * The sessions as four groups, busy, waiting for the user, idle and idle over an hour (the core's `abandoned`, folded at first),
   * each with its heading and axis; the order within a group is the list's. A folded group keeps its heading and
   * count and draws no rows. `project` only makes the rows' ids unique; `rowOf` gives a session's row.
   */
  function groupsFor(sessions, project, rowOf) {
    const frag = document.createDocumentFragment();
    const parts = [["Working now", "zap", "busy", sessions.filter((s) => s.busy)],
      ["Waiting for you", "bell", "waiting", sessions.filter((s) => s.waiting)],
      ["Idle", "moon", "idle", sessions.filter((s) => !s.busy && !s.waiting && !s.abandoned)],
      ["Idle over an hour", "clock", "abandoned", sessions.filter((s) => s.abandoned)]];
    for (const [text, iconName, key, all] of parts) {
      if (!all.length) continue;
      const list = sorted(all.filter(passes));
      // the heading counts what is shown; "4 of 9" while the filters hide some, so the hidden ones are not forgotten
      const heading = groupHeading(text, list.length === all.length ? list.length : `${list.length} of ${all.length}`, iconName, "", key);
      const idKey = project ? `${project}/${key}` : key; // "busy" is in every project
      heading.dataset.key = `group:${idKey}`;
      frag.appendChild(heading);
      const rows = rowsFor(heading, idKey);
      if (!rows) continue;
      if (!list.length) {
        rows.appendChild(el("p", "kx-hidden-all", `all ${all.length} hidden by the filters`));
      } else {
        rows.appendChild(axisLine());
        for (const s of list) rows.appendChild(rowOf(s));
      }
      frag.appendChild(rows);
    }
    return frag;
  }

  /** Every session of the payload, grouped or not. */
  const allSessions = (data) => (data.groups ? data.groups.flatMap((g) => g.sessions) : data.sessions) || [];

  /**
   * The controls follow the view and the list: the select shows the sort, the hot chip its state, one chip
   * per model in the list (pressed = shown; kept in place between renders so focus survives a click), "reset"
   * only when something is off default. A model no longer in the list is dropped from hiddenModels.
   */
  function renderControls(sessions) {
    sortEl.value = view.sort;
    hotEl.setAttribute("aria-pressed", String(view.hotOnly));
    const present = [...new Set(sessions.map(modelName))].sort((a, b) => a.localeCompare(b));
    const pruned = view.hiddenModels.filter((m) => present.includes(m));
    if (pruned.length !== view.hiddenModels.length) { view.hiddenModels = pruned; store.set("view", view); }
    const chips = new Map([...modelsEl.querySelectorAll(".kx-chip")].map((c) => [c.dataset.model, c]));
    for (const [name, chip] of chips) if (!present.includes(name)) { chip.remove(); chips.delete(name); }
    let before = modelsEl.firstChild;
    for (const name of present) {
      let chip = chips.get(name);
      if (!chip) {
        chip = el("button", "kx-chip", name);
        chip.type = "button";
        chip.dataset.testid = "filter-model";
        chip.dataset.model = name;
        chip.addEventListener("click", () => {
          view.hiddenModels = view.hiddenModels.includes(name) ? view.hiddenModels.filter((m) => m !== name) : [...view.hiddenModels, name];
          saveView();
        });
      }
      chip.setAttribute("aria-pressed", String(!view.hiddenModels.includes(name)));
      setTitle(chip, `${view.hiddenModels.includes(name) ? "Show" : "Hide"} the ${name} sessions`);
      // keep the chips in the sorted order without rebuilding them: `before` walks the existing chips
      if (chip === before) before = before.nextSibling; else modelsEl.insertBefore(chip, before);
    }
    modelsEl.hidden = present.length < 2;
    resetEl.hidden = viewIsDefault();
  }

  // ── Detail view of one session: replaces the header, the controls and the list in the same webview. The
  // open session is kept in the webview state. Every list draws it again, patched in place like the list, so the
  // curve grows with the session; the turn in the tooltip, the focus, a copy receipt and an open tooltip survive that
  // draw. The list has the last 200 turns of a session; on open and after every list the panel asks the host for all
  // of them (core.cjs SessionReader.detail), and the answer draws it. ──
  const D_W = 100, D_H = 100; // the large curve's viewBox, stretched to its field like the sparkline's
  const D_FIELD_H = { narrow: 150, wide: 220 }; // the field's height in the style (.kx-d-field), below and above 620 px
  const D_OUT_H = 100, D_OUT_TOP = 94; // the output field's viewBox height, and the tallest bar's, so it does not touch the edge
  const AXIS_GAP_PX = 11; // an axis label is about 10 px tall; neighbours closer than this would overlap
  const COPIED_MS = 2000;
  let openId = null; // the sessionId shown, null while the list is shown
  let turnShown = null; // the turn number in the curve's tooltip, null when none is shown
  let focusBack = false; // the back button takes the focus on the next draw (a session was just opened)
  let curve = null; // the numbers of the drawn curve, for the pointer and the range (showTurn); null without one
  let listScroll = 0; // the list's scroll position, restored on the way back
  const copied = {}; // copy button key → { until, text } while its receipt shows
  let detailAnswer = null; // the host's last answer for the open session, { sessionId, detail }: every turn of it

  function requestDetail() { if (openId) vscode.postMessage({ type: "detail", sessionId: openId }); }

  /** The host's answer: drawn when it is for the session still open; without a detail the list's 200 turns stay. */
  function onDetail(answer) {
    if (!answer || answer.sessionId !== openId) return;
    detailAnswer = answer.detail && typeof answer.detail === "object" ? answer : null;
    drawDetail();
  }

  /**
   * The large curve: zone bands, dashed limits, area and line in the zone colour, compactions as solid lines
   * with their label, dips dotted, the segment's start labelled at the bottom, the axis at the right edge.
   * Hovering shows a hairline and "turn 2 · 60K · +9K from turn 1", with "output 1K · thinking 83" under it; the
   * output per turn has its own field under the curve, and hovering it shows the same turn. The range under both
   * does the same from the keyboard. Until the host's detail has come the series is the list's last SERIES_MAX turns (core.cjs), so
   * its first point is turn `first` (the core's firstTurn); with the detail it is every turn and `first` is 1.
   */
  function detailCurve(session) {
    const wrap = el("div", "kx-d-sec");
    const series = Array.isArray(session.series) ? session.series : [];
    const turns = Math.max(session.turns || 0, series.length);
    const first = firstTurnOf(session), last = turns;
    const { dips, compactions } = curveMarks(session, series);
    const lbl = el("div", "kx-d-lbl");
    const span = first > 1 ? `last ${series.length} of ${plural(turns, "turn", "turns")}` : plural(series.length, "turn", "turns");
    const summary = el("span", "", !turns ? "Tokens per turn" // the field below says "no turns yet"
      : `Tokens per turn · ${span} · ${plural(compactions.length, "compaction", "compactions")}${dips.length ? ` · ${plural(dips.length, "other drop", "other drops")}` : ""}`);
    summary.dataset.testid = "detail-curve-label";
    lbl.appendChild(summary);
    const legend = (text, dashed) => { const s = el("span", "kx-d-leg"); s.appendChild(el("i", dashed ? "kx-d-dash" : "")); s.appendChild(document.createTextNode(text)); lbl.appendChild(s); };
    legend("compaction", false);
    legend(LIMITS.map(tokensText).join(" · "), true);
    wrap.appendChild(lbl);
    const field = el("div", "kx-d-field");
    field.dataset.testid = "detail-curve";
    wrap.appendChild(field);
    curve = null;
    if (series.length < 2) { field.appendChild(el("p", "kx-message", session.turns ? "one turn, no curve yet" : "no turns yet")); return wrap; }
    const top = Math.max(SCALE, ...series);
    const x = (i) => (i / (series.length - 1)) * D_W;
    const y = (v) => D_H - 1 - (v / top) * (D_H - 2);
    const svg = svgEl("svg", { class: "kx-d-curve", viewBox: `0 0 ${D_W} ${D_H}`, preserveAspectRatio: "none", role: "img", "data-points": series.length, "aria-label": `Tokens per turn, ${span}; now ${tokensText(session.tokens)}` });
    for (const { zone: z, from: a, to } of ZONE_LIST) {
      const b = Number.isFinite(to) ? to : top;
      const r = svgEl("rect", { class: "kx-d-band", x: 0, width: D_W, y: num(y(b)), height: num(y(a) - y(b)) });
      r.style.setProperty("--kx-band", `var(--kx-${z}-fill)`);
      svg.appendChild(r);
    }
    drawCurve(svg, { series, dips, compactions, x, y, w: D_W, h: D_H, turn: (i) => first + i });
    field.appendChild(svg);
    // the axis labels: the limits and the top of the scale; when the scale runs far above 300K the limits sit
    // close together, so only the highest (red's) is labelled, and they never overlap. The top is at least 300K,
    // a third of the field above the highest limit. How many fit is decided for both field heights, as the number
    // of limits labelled; the style shows data-axis below 620 px and data-axis-wide above
    const gaps = LIMITS.slice(1).map((g, i) => (y(LIMITS[i]) - y(g)) / D_H);
    const room = gaps.length ? Math.min(...gaps) : 1;
    const fits = (h) => (room * h >= AXIS_GAP_PX ? LIMITS.length : 1);
    field.dataset.axis = fits(D_FIELD_H.narrow);
    field.dataset.axisWide = fits(D_FIELD_H.wide);
    for (const g of [...LIMITS, top]) {
      const low = g !== top && g !== LIMITS[LIMITS.length - 1];
      const a = el("span", `kx-d-axis${low ? " kx-d-axis-low" : ""}`, tokensText(g));
      a.setAttribute("aria-hidden", "true");
      a.style.top = `${pct(y(g) / D_H)}%`;
      field.appendChild(a);
    }
    // a label near the right edge is anchored to its right, near the left edge to its left, so it stays in the field
    for (const c of compactions) {
      const m = el("span", "kx-d-mark", compactionText(c));
      m.dataset.testid = "detail-compaction";
      const left = x(c.at) / D_W;
      if (left > 0.6) { m.style.left = `calc(${pct(left)}% - 2px)`; m.style.transform = "translateX(-100%)"; m.style.maxWidth = "60%"; }
      else if (left < 0.25) { m.style.left = `calc(${pct(left)}% + 2px)`; m.style.transform = "none"; }
      else m.style.left = `${pct(left)}%`;
      m.title = `turn ${first + c.at}: ${compactionText(c)}`;
      field.appendChild(m);
    }
    if (Number.isFinite(session.baselineAt) && session.baselineAt >= 0 && session.baselineAt < series.length && Number.isFinite(session.baseline)) {
      const m = el("span", "kx-d-mark kx-d-start", `${session.baselineCause === "compaction" ? "start after compaction" : "start"} ${tokensText(session.baseline)}`);
      m.dataset.testid = "detail-start";
      m.style.left = `${pct(Math.min(0.9, Math.max(0.1, x(session.baselineAt) / D_W)))}%`;
      field.appendChild(m);
    }
    const hair = el("div", "kx-d-hair"), tip = el("div", "kx-d-tip");
    tip.dataset.testid = "detail-tip";
    field.appendChild(hair);
    field.appendChild(tip);
    // output per turn in its own field under the curve, one slot per turn of the series so a bar sits under its point;
    // the output series is aligned to the series' right end, as in the row's strip (outputFor)
    const output = Array.isArray(session.outputSeries) ? session.outputSeries.slice(-series.length) : [];
    const thinking = Array.isArray(session.thinkingSeries) ? session.thinkingSeries.slice(-series.length) : [];
    const largest = Math.max(0, ...output), offset = series.length - output.length, slot = D_W / series.length;
    const thinkingAt = (o) => Math.min(thinking[o] || 0, output[o] || 0);
    curve = { series, first, last, x, compactions, output, offset, slot, thinkingAt };
    let ofield = null;
    if (largest) {
      ofield = el("div", "kx-d-ofield");
      ofield.dataset.testid = "detail-output";
      const bars = svgEl("svg", { class: "kx-d-obars", viewBox: `0 0 ${D_W} ${D_OUT_H}`, preserveAspectRatio: "none", role: "img", "data-bars": output.length,
        "aria-label": `Output tokens per turn, of it thinking; largest ${tokensText(largest)}` });
      drawOutput(bars, { output, thinking, top: largest, offset, slot, base: D_OUT_H, height: D_OUT_TOP });
      ofield.appendChild(bars);
      const axis = el("span", "kx-d-axis", tokensText(largest));
      axis.setAttribute("aria-hidden", "true");
      ofield.appendChild(axis);
      ofield.appendChild(el("div", "kx-d-ocol"));
    }
    const row = el("div", "kx-d-turn-row");
    const lab = el("label", "", "Turn");
    lab.htmlFor = "kx-d-turn";
    const range = el("input", "kx-d-turn");
    range.type = "range";
    range.id = lab.htmlFor;
    range.dataset.testid = "detail-turn";
    range.min = String(first);
    range.max = String(last);
    range.value = String(last);
    const val = el("span", "kx-d-turn-val", `${last} / ${last}`);
    val.dataset.testid = "detail-turn-value";
    row.appendChild(lab);
    row.appendChild(range);
    row.appendChild(val);
    if (ofield) {
      wrap.appendChild(ofield);
      const legend = el("div", "kx-d-lbl");
      legend.title = `Output tokens per turn and the thinking part of them, scaled to the largest turn (${tokensText(largest)}), not to the curve: what the model writes is read back as input on the next turn`;
      const swatch = (cls, text) => { const s = el("span", "kx-d-leg"); const i = el("span", `kx-d-sw ${cls}`); i.setAttribute("aria-hidden", "true"); s.appendChild(i); s.appendChild(document.createTextNode(text)); legend.appendChild(s); };
      swatch("kx-d-sw-out", "Output");
      swatch("kx-d-sw-think", "Thinking");
      legend.appendChild(el("span", "", "per turn · own scale"));
      wrap.appendChild(legend);
    }
    wrap.appendChild(row);
    if (turnShown !== null && turnShown >= first && turnShown <= last) showTurn(wrap, turnShown - first); else turnShown = null;
    return wrap;
  }

  /**
   * One turn (index `i` of the drawn curve) in both fields under `root`, the detail view or one being built: the
   * hairline and the tooltip in the curve, the column in the output field; the range's aria-valuetext says the same
   * as the tooltip. The elements are looked up, not kept, since a draw patches its tree into the live one.
   */
  function showTurn(root, i) {
    const { series, first, last, x, compactions, output, offset, slot, thinkingAt } = curve;
    const q = (id) => root.querySelector(`[data-testid="${id}"]`);
    const field = q("detail-curve"), tip = q("detail-tip"), ofield = q("detail-output"), range = q("detail-turn"), val = q("detail-turn-value");
    const v = series[i], prev = i > 0 ? series[i - 1] : null;
    const delta = prev === null ? "" : ` · ${v >= prev ? "+" : "−"}${tokensText(Math.abs(v - prev))} from turn ${first + i - 1}`;
    const comp = compactions.find((c) => c.at === i);
    const spoken = [`turn ${first + i}`, tokensText(v) + delta];
    tip.textContent = "";
    tip.appendChild(document.createTextNode(`turn ${first + i} · `));
    tip.appendChild(el("b", "", tokensText(v)));
    tip.appendChild(document.createTextNode(delta));
    const o = i - offset;
    if (ofield && o >= 0) {
      const line = el("span", "kx-d-tip-o");
      line.appendChild(document.createTextNode("output "));
      line.appendChild(el("b", "", tokensText(output[o] || 0)));
      line.appendChild(document.createTextNode(" · thinking "));
      line.appendChild(el("b", "", tokensText(thinkingAt(o))));
      tip.appendChild(el("br"));
      tip.appendChild(line);
      spoken.push(`output ${tokensText(output[o] || 0)}, thinking ${tokensText(thinkingAt(o))}`);
    }
    if (comp) { tip.appendChild(el("br")); tip.appendChild(document.createTextNode(compactionText(comp))); spoken.push(compactionText(comp)); }
    const left = x(i) / D_W;
    field.querySelector(".kx-d-hair").style.left = `${pct(left)}%`;
    tip.style.left = left < 0.6 ? `calc(${pct(left)}% + 8px)` : "auto";
    tip.style.right = left < 0.6 ? "auto" : `calc(${pct(1 - left)}% + 8px)`;
    field.classList.add("kx-d-hover");
    if (ofield) {
      const ocol = ofield.querySelector(".kx-d-ocol");
      ocol.style.left = `${pct((i * slot) / D_W)}%`;
      ocol.style.width = `${pct(slot / D_W)}%`;
      ofield.classList.add("kx-d-hover");
    }
    turnShown = first + i;
    range.value = String(turnShown);
    range.setAttribute("aria-valuetext", spoken.join(" · "));
    val.textContent = `${turnShown} / ${last}`;
  }
  function hideTurn() {
    for (const f of detailEl.querySelectorAll(FIELDS)) f.classList.remove("kx-d-hover");
    turnShown = null;
  }
  const FIELDS = '[data-testid="detail-curve"], [data-testid="detail-output"]', RANGE = '[data-testid="detail-turn"]';
  const turnAt = (turn) => Math.max(0, Math.min(curve.series.length - 1, turn - curve.first));
  // the pointer, the range and the buttons are handled once on the view, as the list's clicks are: a patched tree
  // keeps its old nodes, so listeners of their own would be closures over an earlier draw
  detailEl.addEventListener("mousemove", (e) => {
    const field = curve && e.target.closest(FIELDS);
    if (!field) return;
    const r = field.getBoundingClientRect(), share = (e.clientX - r.left) / r.width, n = curve.series.length;
    // the curve's points sit at the ends of its field; a bar fills its slot
    showTurn(detailEl, turnAt(curve.first + (field.dataset.testid === "detail-output" ? Math.floor(share * n) : Math.round(share * (n - 1)))));
  });
  // mouseleave, focus and blur do not bubble, nor does an input event sent without `bubbles`: caught on the way down
  detailEl.addEventListener("mouseleave", (e) => { if (e.target.matches(FIELDS)) hideTurn(); }, true);
  detailEl.addEventListener("input", (e) => { if (curve && e.target.matches(RANGE)) showTurn(detailEl, turnAt(Number(e.target.value))); }, true);
  detailEl.addEventListener("focus", (e) => { if (curve && e.target.matches(RANGE)) showTurn(detailEl, turnAt(Number(e.target.value))); }, true);
  detailEl.addEventListener("blur", (e) => { if (e.target.matches(RANGE)) hideTurn(); }, true);
  detailEl.addEventListener("click", (e) => {
    if (e.target.closest('[data-testid="detail-back"]')) { setOpen(null); return; }
    const copy = e.target.closest(".kx-d-copy");
    if (copy) copyFrom(copy);
  });

  /** Copies `text`: the clipboard API, else a hidden textarea and execCommand. True when either worked. */
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* no clipboard API in this frame: the older way */ }
    const area = el("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }

  /** The button's text, "copy" or a receipt; the accessible name carries the receipt too, since it replaces the text for a screen reader. */
  function copyLabel(button, state) {
    const text = button.dataset.value;
    button.textContent = state;
    button.setAttribute("aria-label", state === "copy" ? `Copy ${text}` : `${state}: ${text}`);
  }

  /** A value in code with a "copy" button that says "copied" for two seconds; `key` names it across draws. A click is handled on the view (copyFrom). */
  function copyable(key, text) {
    const span = el("span");
    span.appendChild(el("code", "", text));
    const b = el("button", "kx-d-copy");
    b.type = "button";
    b.dataset.testid = `copy-${key}`;
    b.dataset.copy = key;
    b.dataset.value = text;
    const receipt = copied[key] && copied[key].until > Date.now() ? copied[key] : null;
    copyLabel(b, receipt ? receipt.text : "copy");
    if (receipt && receipt.text === "copied") b.dataset.done = "";
    span.appendChild(b);
    return span;
  }

  async function copyFrom(button) {
    const key = button.dataset.copy;
    const ok = await copyText(button.dataset.value);
    copied[key] = { until: Date.now() + COPIED_MS, text: ok ? "copied" : "copy failed" };
    const shown = () => detailEl.querySelector(`[data-testid="copy-${key}"]`); // a draw may have replaced the button
    const now = shown() || button;
    copyLabel(now, copied[key].text);
    if (ok) now.dataset.done = ""; else delete now.dataset.done;
    if (document.activeElement === document.body) now.focus({ preventScroll: true }); // the textarea way took the focus
    setTimeout(() => {
      if (copied[key] && copied[key].until > Date.now()) return; // a later click owns the receipt
      delete copied[key];
      const current = shown();
      if (current) { copyLabel(current, "copy"); delete current.dataset.done; }
    }, COPIED_MS);
  }

  /**
   * The facts: "Prompt cache and output" and "Session", side by side from 620 px, key over value below that. The
   * typical fresh start (the list's median, core.cjs contextFacts) follows the turns; it is left out without one.
   */
  function detailFacts(session) {
    const wrap = el("div", "kx-d-sec kx-d-facts");
    wrap.dataset.testid = "detail-facts";
    const table = (caption, rows) => {
      const t = el("table");
      t.appendChild(el("caption", "", caption));
      const body = el("tbody");
      for (const [k, v] of rows) {
        const tr = el("tr");
        const th = el("th", "", k);
        th.scope = "row";
        const td = el("td");
        if (typeof v === "string") td.textContent = v; else td.appendChild(v);
        tr.appendChild(th);
        tr.appendChild(td);
        body.appendChild(tr);
      }
      t.appendChild(body);
      return t;
    };
    const pill = ttlPill(session);
    const ttlEl = el("span");
    if (pill) {
      ttlEl.appendChild(pill);
      ttlEl.appendChild(document.createTextNode(` ${TTL_WORDS[pill.dataset.ttl]}`));
    } else ttlEl.textContent = "unknown";
    const now = session.cacheState === "cold" ? `cold since ${clockText(session.coldAt)}`
      : session.cacheState === "warm" ? `warm · ${leftText(session.coldInMs)} left (cold at ${clockText(session.coldAt)})` : "unknown";
    const thinking = Number.isFinite(session.thinkingShare) ? `${tokensText(session.thinkingTotal)} (${Math.round(session.thinkingShare * 100)} %)` : "unknown";
    wrap.appendChild(table("Prompt cache and output", [
      ["Cache TTL", ttlEl],
      ["Cache now", now],
      ["Last turn read from cache", Number.isFinite(session.cacheRead) ? `${tokensText(session.cacheRead)} (${Number.isFinite(session.hitShare) ? `${Math.round(session.hitShare * 100)} %` : "unknown share"} of the context)` : "unknown"],
      ["Last turn written to cache", Number.isFinite(session.cacheCreated) ? tokensText(session.cacheCreated) : "unknown"],
      ["Output, whole session", Number.isFinite(session.outputTotal) ? tokensText(session.outputTotal) : "unknown"],
      ["Of it thinking", thinking],
      ["Output, last turn", Number.isFinite(session.lastOutput) ? `${tokensText(session.lastOutput)} (${tokensText(session.lastThinking)} thinking)` : "unknown"],
    ]));
    wrap.appendChild(table("Session", [
      ["Turns", String(session.turns || 0)],
      ...(session.typicalStart ? [["A fresh session here typically starts at", session.typicalStart]] : []),
      ["Started", session.startedAt ? dayText(session.startedAt) : "unknown"],
      ["Last turn", session.lastTurn ? `${dayText(session.lastTurn)} (${sinceText(session.sinceMs)})` : "no turn"],
      ["Model · effort", modelEffort(session)],
      ["Working folder", session.cwd || "unknown"],
      ["Process id", Number.isFinite(session.pid) ? copyable("pid", String(session.pid)) : "unknown"],
      ["Session id", session.sessionId ? copyable("session", session.sessionId) : "unknown"],
    ]));
    return wrap;
  }

  /** Where the context went since the segment's start: one bar per source, largest first (core.cjs growth), the estimate's caveat once under them, in full in its tooltip. */
  function detailGrowth(session) {
    const wrap = el("div", "kx-d-sec");
    wrap.dataset.testid = "detail-growth";
    const h = el("h2", "kx-group");
    h.appendChild(icon("play"));
    h.appendChild(document.createTextNode(`Where the context went ${growthSince(session)}`));
    wrap.appendChild(h);
    const rows = growthRows(session);
    if (!rows.length) { wrap.appendChild(el("p", "kx-d-note", session.turns ? "nothing yet since the segment's first turn" : "no turns yet")); return wrap; }
    const bars = el("div", "kx-d-bars");
    for (const g of rows) {
      const name = el("span", "kx-d-bar-n", sourceName(g.source));
      name.title = g.source;
      const bar = el("span", "kx-d-bar");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("i");
      fill.style.setProperty("--p", pct(g.tokens / rows[0].tokens));
      bar.appendChild(fill);
      bars.appendChild(name);
      bars.appendChild(bar);
      bars.appendChild(el("span", "kx-d-bar-v", tokensText(g.tokens)));
      bars.appendChild(el("span", "kx-d-bar-s", `${Math.round(g.share * 100)} %`));
    }
    wrap.appendChild(bars);
    const note = el("p", "kx-d-note", "Estimate per turn: output first, the rest split by length.");
    note.title = `Estimate: ${GROWTH_HOW}.`;
    wrap.appendChild(note);
    return wrap;
  }

  const AGENT_STATUS = {
    running: "running: no end recorded, and written since this session's process started",
    finished: "finished: Claude Code recorded its end",
    unknown: "unknown: no end recorded, and not written since this session's process started",
  };

  /** A subagent's context bar: the row's bar, without the start shade, on the same scale and with the same gaps. */
  function agentBar(tokens) {
    const bar = el("span", "kx-bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("span", "kx-fill");
    fill.style.setProperty("--p", pct(share(tokens)));
    bar.appendChild(fill);
    for (const g of LIMITS) {
      const tick = el("span", "kx-tick");
      tick.style.setProperty("--t", pct(g / SCALE));
      bar.appendChild(tick);
    }
    if (Number.isFinite(tokens) && tokens > SCALE) bar.appendChild(el("span", "kx-over"));
    return bar;
  }

  /**
   * The session's subagents, one line each as the core orders them (core.cjs subagentRows: running first, then by
   * last turn): status, type and description, its own context on the rows' scale and zones, turns, output, model and
   * last turn, with one sentence on why its count is not the session's. Nothing for a session without subagents.
   */
  function detailAgents(session) {
    const list = Array.isArray(session.subagentList) ? session.subagentList : [];
    if (!list.length) return null;
    const wrap = el("div", "kx-d-sec kx-d-agents");
    wrap.dataset.testid = "detail-subagents";
    const h = el("h2", "kx-group");
    h.appendChild(icon("bot"));
    h.appendChild(document.createTextNode("Subagents"));
    h.appendChild(el("span", "kx-gn", `· ${list.length}`));
    wrap.appendChild(h);
    wrap.appendChild(el("p", "kx-d-why", AGENTS_WHY));
    const table = el("table");
    const head = el("tr");
    for (const [text, cls] of [["Status"], ["Subagent"], ["Context"], ["Turns", "kx-d-r"], ["Output", "kx-d-r"], ["Model"], ["Last turn"]]) {
      const th = el("th", cls || "", text);
      th.scope = "col";
      head.appendChild(th);
    }
    table.appendChild(el("thead")).appendChild(head);
    const body = el("tbody");
    for (const a of list) {
      const tr = zoned(el("tr"), a.zone);
      tr.dataset.testid = "subagent";
      tr.dataset.status = a.status;
      const status = el("td", "kx-d-a-st");
      status.dataset.status = a.status;
      if (a.status === "running") status.appendChild(badgeEl("zap", "running"));
      else status.textContent = a.status;
      status.title = AGENT_STATUS[a.status] || a.status;
      tr.appendChild(status);
      const who = el("td", "kx-d-a-who");
      if (a.depth > 1) who.appendChild(document.createTextNode("↳ "));
      who.appendChild(el("b", "", a.type || "subagent"));
      if (a.description) who.appendChild(el("span", "", ` ${a.description}`));
      who.title = `${agentName(a)}${a.depth > 1 ? ` · depth ${a.depth}, a subagent's subagent` : ""}`;
      tr.appendChild(who);
      const ctx = el("td", "kx-d-a-ctx");
      const inner = el("div");
      inner.appendChild(agentBar(a.tokens));
      const n = el("span", "kx-num", Number.isFinite(a.tokens) ? tokensText(a.tokens) : "—");
      n.dataset.testid = "subagent-tokens";
      inner.appendChild(n);
      ctx.appendChild(inner);
      ctx.title = Number.isFinite(a.tokens) ? `${tokensText(a.tokens)} tokens in its own context, zone ${ZONE_NAME[a.zone] || "unknown"} · scale ${SCALE_TEXT}` : "no count yet";
      tr.appendChild(ctx);
      const fact = (text, unit, cls) => { const td = el("td", `kx-d-a-fact${cls ? ` ${cls}` : ""}`, text); if (unit) td.appendChild(el("span", "kx-d-u", unit)); tr.appendChild(td); };
      fact(String(a.turns || 0), a.turns === 1 ? " turn" : " turns", "kx-d-r");
      fact(Number.isFinite(a.outputTotal) ? tokensText(a.outputTotal) : "unknown", " out", "kx-d-r");
      fact(a.modelShort || "unknown");
      fact(a.lastTurn ? sinceText(a.sinceMs) : "no turn");
      if (a.lastTurn) tr.lastChild.title = dayText(a.lastTurn);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  function backButton() {
    const b = el("button", "kx-d-back");
    b.type = "button";
    b.dataset.testid = "detail-back";
    b.appendChild(icon("back"));
    b.appendChild(document.createTextNode("Sessions")); // a click is handled on the view
    return b;
  }

  /**
   * The context box: "Context 169K · orange zone", what the zones measure (for a known zone) and the zone's advice
   * (orange and red), then the named facts under it; the core gives the advice and the facts (contextFacts).
   */
  function contextBlock(session) {
    const frag = document.createDocumentFragment();
    const box = el("section", "kx-d-ctx");
    box.dataset.testid = "detail-context";
    box.setAttribute("aria-label", "Context");
    const h = el("h2");
    h.appendChild(document.createTextNode("Context"));
    if (Number.isFinite(session.tokens)) { // without a count the words say why: "Context · no turns yet"
      const n = zoned(el("span", "kx-num", countText(session)), session.zone);
      n.dataset.testid = "detail-tokens";
      n.setAttribute("aria-label", countLabel(session));
      h.appendChild(n);
    }
    const known = Boolean(ZONE_NAME[session.zone]);
    h.appendChild(el("span", "kx-d-zn", known ? `· ${ZONE_NAME[session.zone]} zone` : session.turns ? "· no count yet" : "· no turns yet"));
    box.appendChild(h);
    // the zones are quality warnings, not the window limit (core.cjs, the comment at ORANGE_FROM)
    if (known && MARKS_TEXT) box.appendChild(el("p", "kx-d-why", `Zones warn about quality at ${MARKS_TEXT}, not about the window limit.`));
    if (session.advice) {
      const advice = el("p", "kx-d-advice", session.advice);
      advice.dataset.testid = "detail-advice";
      box.appendChild(advice);
    }
    frag.appendChild(box);
    const facts = Array.isArray(session.facts) ? session.facts.filter((f) => Array.isArray(f) && f.length === 2) : [];
    if (facts.length) {
      const dl = el("dl", "kx-d-named");
      dl.dataset.testid = "detail-named";
      for (const [k, v] of facts) {
        const d = el("div");
        d.appendChild(el("dt", "", k));
        d.appendChild(el("dd", "", String(v)));
        dl.appendChild(d);
      }
      frag.appendChild(dl);
    }
    return frag;
  }

  /** The view of one session, top to bottom: top bar, title, meta line, the context box and named facts, the subagents, curve and where the context went (side by side from 620 px), facts. */
  function detailFor(session) {
    const root = zoned(el("article"), session.zone);
    root.dataset.session = session.sessionId;
    const top = el("div", "kx-d-top");
    top.appendChild(backButton());
    const { dot, badge } = dotAndBadge(session);
    if (badge) {
      badge.dataset.testid = session.busy ? "detail-busy" : "detail-waiting";
      top.appendChild(badge);
    }
    const esc = el("span", "kx-d-esc", "Esc");
    esc.title = "Escape returns to the list";
    esc.setAttribute("aria-hidden", "true");
    top.appendChild(esc);
    root.appendChild(top);
    const head = el("div", "kx-d-head");
    head.appendChild(dot);
    const h = titled(el("h1"), session);
    h.dataset.testid = "detail-title";
    head.appendChild(h);
    root.appendChild(head);
    const meta = el("div", "kx-d-meta");
    meta.dataset.testid = "detail-meta";
    const add = (name, text) => meta.appendChild(metaItem(name, text));
    add("folder", session.project || "unknown").title = session.cwd || "";
    if (session.turns) { // before the first turn the context box and the curve say "no turns yet"
      add("cpu", modelEffort(session));
      add("repeat", plural(session.turns, "turn", "turns"));
    }
    add("play", startText(session));
    if (session.turns) add("clock", sinceText(session.sinceMs));
    root.appendChild(meta);
    root.appendChild(contextBlock(session));
    // the subagents' own windows belong with the session's: under the context box, not below the fold (owner, 2026-10-25)
    const agents = detailAgents(session);
    if (agents) root.appendChild(agents);
    const pair = el("div", "kx-d-pair");
    pair.appendChild(detailCurve(session));
    pair.appendChild(detailGrowth(session));
    root.appendChild(pair);
    root.appendChild(detailFacts(session));
    return root;
  }

  /**
   * The open session drawn from the last list, with every turn from the host's detail when it has come, or
   * "gone" when the registry no longer has it. Built afresh and patched into the live view, as the list is, so the
   * element under the pointer keeps its tooltip and the focus stays where it is.
   */
  function drawDetail() {
    if (!openId || !lastData) return; // without a list yet, the first one draws it
    const listed = allSessions(lastData).find((s) => s.sessionId === openId);
    const session = listed && detailAnswer && detailAnswer.sessionId === openId ? { ...listed, ...detailAnswer.detail } : listed;
    const active = detailEl.contains(document.activeElement) ? document.activeElement : null;
    let next;
    if (session) next = detailFor(session);
    else {
      turnShown = null;
      curve = null;
      next = el("div");
      next.dataset.key = "gone";
      next.appendChild(backButton());
      const p = el("p", "kx-message", "That session is gone from the registry.");
      p.dataset.testid = "detail-gone";
      next.appendChild(p);
    }
    patchChildren(detailEl, [next], keyedIn(detailEl), []);
    // a node that could not be kept (one that changed its kind) took the focus with it: its successor gets it
    const lost = active && !active.isConnected && active.dataset.testid ? detailEl.querySelector(`[data-testid="${active.dataset.testid}"]`) : null;
    const target = focusBack ? detailEl.querySelector('[data-testid="detail-back"]') : lost;
    focusBack = false;
    if (target) target.focus({ preventScroll: true });
  }

  const scroller = () => document.scrollingElement || document.documentElement;
  /** The list or the detail on screen; the list is not drawn behind the detail, and is drawn on the way back (setOpen). */
  function showMode() {
    for (const e of [headerEl, controlsEl, listEl]) e.hidden = !!openId;
    detailEl.hidden = !openId;
    if (!openId) detailEl.textContent = "";
  }

  /** Opens a session (`id`) or returns to the list (null), and remembers it in the webview state. */
  function setOpen(id) {
    const next = id || null;
    if (next === openId) return;
    const closing = openId;
    if (next && !closing) listScroll = scroller().scrollTop;
    openId = next;
    turnShown = null;
    detailAnswer = null; // the answer for another session, or none
    store.set("open", openId);
    showMode();
    if (openId) {
      focusBack = true;
      scroller().scrollTop = 0;
      drawDetail();
      requestDetail();
      return;
    }
    if (lastData) render(lastData, true); // the list rested while the detail was open
    scroller().scrollTop = listScroll;
    const row = closing && [...listEl.querySelectorAll(".kx-session[tabindex]")].find((r) => r.dataset.session === closing);
    if (row) row.focus({ preventScroll: true });
  }

  listEl.addEventListener("click", (e) => {
    const fold = e.target.closest('[data-testid="fold"]');
    // the list patches the button in place, so it keeps its place for the keyboard; a click does not focus it everywhere
    if (fold) { toggleFold(fold.dataset.group); if (lastData) render(lastData); fold.focus(); return; }
    const row = e.target.closest(".kx-session[tabindex]");
    if (row && row.dataset.session) setOpen(row.dataset.session);
  });
  listEl.addEventListener("keydown", (e) => {
    if ((e.key !== "Enter" && e.key !== " ") || !e.target.matches(".kx-session[tabindex]")) return;
    e.preventDefault();
    setOpen(e.target.dataset.session);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openId) { e.preventDefault(); setOpen(null); }
  });

  sortEl.addEventListener("change", () => { view.sort = SORTS.includes(sortEl.value) ? sortEl.value : "last"; saveView(); });
  hotEl.addEventListener("click", () => { view.hotOnly = !view.hotOnly; saveView(); });
  resetEl.addEventListener("click", () => { view = { ...VIEW_DEFAULT, hiddenModels: [] }; saveView(); sortEl.focus(); }); // reset hides itself

  /**
   * The scope line: which button is pressed; while scoped, the workspace folders' names ("no folder" without
   * any: then every session is listed) and how many live sessions the scope leaves out ("4 more in other projects",
   * which switches to all projects). A payload without the core's workspaceNames names no folder.
   */
  function renderScope(data) {
    const all = !!data.all;
    const names = Array.isArray(data.workspaceNames) ? data.workspaceNames.filter((n) => typeof n === "string" && n) : null;
    const hidden = Number.isFinite(data.hiddenCount) ? data.hiddenCount : 0;
    scopeWorkspaceEl.setAttribute("aria-pressed", String(!all));
    scopeAllEl.setAttribute("aria-pressed", String(all));
    scopeNameEl.hidden = all || !names;
    if (names) {
      setText(scopeNameEl, names.length ? names.join(", ") : "no folder");
      setTitle(scopeNameEl, names.length ? `The sessions started inside ${names.length === 1 ? "the workspace folder" : "the workspace folders"} ${names.join(", ")}`
        : "No workspace folder, so every live session on the machine is listed");
    }
    scopeMoreEl.hidden = all || !hidden;
    setText(scopeMoreEl, `${hidden} more in other projects`);
  }

  /** Where the listed sessions are, for the counters' tooltips: "the 6 sessions in this workspace". */
  function sessionsWhere(n, data) {
    const where = data.all ? "in all projects" : Array.isArray(data.workspaceNames) && !data.workspaceNames.length ? "on this machine" : "in this workspace";
    return `${n === 1 ? "the 1 session" : `the ${n} sessions`} ${where}`;
  }

  /**
   * The core's zones, from a list: they set LIMITS and build the header's strip, each zone a band at its true width
   * on 0–SCALE with its range inside and its advice in the tooltip. Only when they change, so the band under the
   * pointer keeps its tooltip while lists come in; a list without zones keeps the last ones.
   */
  let zonesKey = null;
  function applyZones(zones) {
    // zones in order from 0, each inside the scale, or the bands and the curves would go negative
    const ordered = Array.isArray(zones) && zones.length && zones.every((z, i) => z && Number.isFinite(z.from) && z.from < SCALE
      && (i === 0 ? z.from === 0 : z.from > zones[i - 1].from) && (i < zones.length - 1 ? z.to === zones[i + 1].from : z.to === null));
    if (!ordered) return;
    const key = JSON.stringify(zones);
    if (key === zonesKey) return;
    zonesKey = key;
    ZONE_LIST = zones;
    LIMITS = zones.slice(1).map((z) => z.from);
    MARKS_TEXT = listText(LIMITS.map(tokensText));
    zoneScaleEl.textContent = "";
    zoneScaleEl.setAttribute("aria-label", `Zones on a ${SCALE_TEXT} scale: ${listText(zones.map((z) => `${ZONE_NAME[z.zone] || z.zone} ${z.range}`))}`);
    for (const z of zones) {
      const band = zoned(el("span", "kx-zband"), z.zone);
      band.dataset.testid = `band-${z.zone}`;
      band.style.setProperty("--w", pct(((Number.isFinite(z.to) ? z.to : SCALE) - z.from) / SCALE));
      band.title = `${ZONE_NAME[z.zone] || z.zone} zone: ${z.range}${z.advice ? ` · ${z.advice}` : ""}`;
      band.appendChild(el("span", "kx-zlong", z.range));
      band.appendChild(el("span", "kx-zshort", z.short));
      zoneScaleEl.appendChild(band);
    }
    fitBands();
  }

  /**
   * Per band, the longest range text that fits, measured as drawn, so the editor's font size counts: long, short, or
   * none. Run when the bands are built and when the strip or the header resizes; the header's height follows the font
   * size, so a new editor font refits too. Not on every list: each try forces a layout.
   */
  function fitBands() {
    for (const band of zoneScaleEl.children) {
      for (const fit of ["long", "short", "none"]) {
        band.dataset.fit = fit;
        if (fit === "none" || band.scrollWidth <= band.clientWidth) break;
      }
    }
  }
  if (typeof ResizeObserver === "function") {
    const resized = new ResizeObserver(fitBands);
    resized.observe(zoneScaleEl);
    resized.observe(headerEl);
  }

  /** The count per zone beside the session count, for the listed sessions (the scope, before the view's filters). */
  function renderZoneCounts(zoneCounts, data) {
    const counts = ZONES.map((z) => [z, Number.isFinite(zoneCounts[z]) ? zoneCounts[z] : 0]);
    const items = [];
    for (const [z, n] of counts) {
      const item = zoned(el("span"), z);
      const b = el("b", "", String(n));
      b.dataset.testid = `zone-${z}`;
      item.appendChild(b);
      item.appendChild(document.createTextNode(` ${ZONE_NAME[z]}`));
      item.title = `${n} of ${sessionsWhere(data.count || 0, data)} ${n === 1 ? "is" : "are"} in the ${ZONE_NAME[z]} zone`;
      items.push(item);
    }
    patchChildren(zoneCountsEl, items, new Map(), []);
  }

  // ── Updating in place. A list comes after every change in Claude Code's folders and on a 30-second tick, and a
  // native tooltip closes when the element under the pointer is replaced, so a busy session's tooltips would close
  // within a second or two (#59). Every list is still built afresh by the functions above, and patch() then makes
  // the live tree match it: a node that stays is kept, and only what changed in it is set. Rows are keyed by their
  // session, headings and row containers by data-key, across the whole list, so a row that changes group is moved,
  // not rebuilt; other nodes are matched in place by their tag. A row that would come out the same is not built at
  // all (rowKey), and the detail view is patched the same way. ──
  let rowKeys = new Map(); // sessionId → rowKey of its live row
  const keyOf = (n) => {
    if (n.nodeType !== 1) return null;
    const session = n.getAttribute("data-session"), key = n.getAttribute("data-key");
    return session ? `session:${session}` : key ? `key:${key}` : null;
  };
  const sameKind = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.namespaceURI === b.namespaceURI && a.tagName === b.tagName));
  /** The keyed elements under `root`, for patchChildren to take from wherever they are. */
  function keyedIn(root) {
    const keyed = new Map();
    for (const e of root.querySelectorAll("[data-session], [data-key]")) { const k = keyOf(e); if (k && !keyed.has(k)) keyed.set(k, e); }
    return keyed;
  }
  /**
   * `live` takes `next`'s attributes, inline style (through the CSSOM: the CSP blocks style attributes), an input's
   * value (a property, not an attribute) and children. A `next` marked data-kept is an unchanged row: `live` stays.
   */
  function patch(live, next, keyed, moved) {
    if (live.nodeType !== 1) { if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue; return; }
    if (next.hasAttribute("data-kept")) return;
    for (const { name, value } of [...next.attributes]) if (name !== "style" && live.getAttribute(name) !== value) live.setAttribute(name, value);
    for (const { name } of [...live.attributes]) if (name !== "style" && !next.hasAttribute(name)) live.removeAttribute(name);
    if (next.tagName === "INPUT" && live.value !== next.value) live.value = next.value;
    const props = new Set(Array.from({ length: next.style.length }, (_, i) => next.style[i]));
    for (const prop of props) if (live.style.getPropertyValue(prop) !== next.style.getPropertyValue(prop)) live.style.setProperty(prop, next.style.getPropertyValue(prop));
    for (const prop of Array.from({ length: live.style.length }, (_, i) => live.style[i])) if (!props.has(prop)) live.style.removeProperty(prop);
    patchChildren(live, [...next.childNodes], keyed, moved);
  }
  /**
   * `parent`'s children become `nodes`, in order: each takes the old node with its key (`keyed`, from anywhere) or
   * the old one in its place with the same tag, else is put in itself, with its children patched in the same way.
   * The old nodes left over are removed. A kept node that had to be moved is pushed on `moved`. An old keyed node
   * that has no place among `nodes` is taken out before the next is placed, or every node after it would be moved
   * past it, out of the document for a moment, and lose its tooltip and focus.
   */
  function patchChildren(parent, nodes, keyed, moved) {
    const here = new Set(nodes.map(keyOf).filter(Boolean));
    let at = parent.firstChild;
    for (const n of nodes) {
      while (at && keyOf(at) && !here.has(keyOf(at))) { const gone = at; at = at.nextSibling; parent.removeChild(gone); } // still in `keyed`, for a place elsewhere
      const k = keyOf(n);
      let old = k ? keyed.get(k) : at && !keyOf(at) && sameKind(at, n) ? at : null;
      if (old && !sameKind(old, n)) old = null;
      if (k && old) keyed.delete(k);
      if (old === at && old) { at = at.nextSibling; patch(old, n, keyed, moved); continue; }
      if (old) { parent.insertBefore(old, at); moved.push(old); patch(old, n, keyed, moved); continue; }
      const kids = [...n.childNodes];
      for (const c of kids) n.removeChild(c);
      parent.insertBefore(n, at);
      patchChildren(n, kids, keyed, moved);
    }
    while (at) { const after = at.nextSibling; parent.removeChild(at); at = after; }
  }
  /** The text, set only when it changed: setting it replaces the text node even when it is the same. */
  function setText(e, text) { if (e.textContent !== text) e.textContent = text; }
  function setTitle(e, title) { if (e.title !== title) e.title = title; }

  // ── Refresh: the button asks the host for a full read; the icon spins until the next list arrives,
  // then "updated 12:04:31" shows for a few seconds (the only feedback under prefers-reduced-motion) ──
  const REFRESHED_MS = 4000;
  const REFRESH_GIVE_UP_MS = 15000; // a host that never answers (it threw, or the read hangs) must not leave the icon spinning
  let refreshPending = false, refreshedTimer = null, refreshGiveUp = null;
  function refreshDone(data) {
    // only the list of the full read counts: a watcher's list already on its way when the button was
    // pressed must not take the receipt (the host echoes `full` in the payload)
    if (!refreshPending || !(data && data.full === true)) return;
    refreshPending = false;
    clearTimeout(refreshGiveUp);
    refreshEl.removeAttribute("aria-busy");
    const at = new Date(data && data.generatedAt ? data.generatedAt : Date.now());
    refreshedEl.textContent = `updated ${Number.isFinite(at.getTime()) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "now"}`;
    refreshedEl.hidden = false;
    clearTimeout(refreshedTimer);
    refreshedTimer = setTimeout(() => { refreshedEl.hidden = true; }, REFRESHED_MS);
  }

  function render(data, still = false) {
    lastData = data;
    applyZones(data.zones); // first: the rows, the curves and the detail view draw the limits
    refreshDone(data);
    // with an answer for the open session, the next answer draws it, with the new list (onDetail): drawing now too
    // would show the new count with the old curve for a moment. A session gone from the list is said at once. Both
    // hosts answer every request (extension.js, server.cjs); an answer lost on the way (a dropped event stream) leaves
    // the view one list behind until the next list's answer
    if (!detailAnswer || !allSessions(data).some((s) => s.sessionId === openId)) drawDetail();
    requestDetail(); // the new list's turns, all of them, for the open session
    setText(countEl, String(data.count || 0));
    renderZoneCounts(data.zoneCounts || {}, data);
    renderScope(data);
    setTitle(cacheCountsEl, `Prompt cache: how many of ${sessionsWhere(data.count || 0, data)} have a warm cache now, and how many went cold`);
    const cacheCounts = data.cacheCounts || {};
    setText(cacheWarmEl, String(Number.isFinite(cacheCounts.warm) ? cacheCounts.warm : 0));
    setText(cacheColdEl, String(Number.isFinite(cacheCounts.cold) ? cacheCounts.cold : 0));
    startMedianEl.hidden = !Number.isFinite(data.baselineMedian);
    if (!startMedianEl.hidden) {
      setText(startMedianEl.firstChild, tokensText(data.baselineMedian));
      const n = data.baselineSessions;
      setTitle(startMedianEl, `Start cost: the median first turn of ${sessionsWhere(n, data)} that began fresh (not after a compaction). It is the fixed load (CLAUDE.md, memory, skill and tool listings) plus the first message, so a long first prompt raises it`);
    }
    const abandoned = Number.isFinite(data.abandonedCount) ? data.abandonedCount : 0;
    abandonedEl.hidden = !abandoned;
    setText(abandonedEl.firstChild, String(abandoned));
    setTitle(abandonedEl, `${abandoned} of ${sessionsWhere(data.count || 0, data)} had no turn for more than an hour. ${ABANDONED_WHY}`);
    errorsEl.hidden = !(data.errors && data.errors.length);
    patchChildren(errorsEl, errorsEl.hidden ? [] : data.errors.map((f) => el("div", "kx-error", f)), new Map(), []);
    const everyone = allSessions(data);
    renderControls(everyone);
    const shown = everyone.filter(passes).length;
    showingEl.hidden = shown === everyone.length;
    setText(showingEl, `showing ${shown} of ${everyone.length}`);
    // the list is hidden behind the detail view: closing it draws the last list (setOpen)
    if (openId) return;
    // a row that would show what the live one shows is a placeholder, which patch() leaves as it is (rowKey)
    const live = new Set([...listEl.querySelectorAll(".kx-session")].map((row) => row.dataset.session));
    const keys = new Map();
    const rowOf = (s) => {
      if (!s.sessionId) return rowFor(s);
      const key = rowKey(s);
      // only the first row of an id: two processes can resume one session, and there is one live row to keep per key
      const same = !keys.has(s.sessionId) && live.has(s.sessionId) && rowKeys.get(s.sessionId) === key;
      keys.set(s.sessionId, key);
      if (!same) return rowFor(s);
      const kept = el("article");
      kept.dataset.session = s.sessionId;
      kept.dataset.kept = "";
      return kept;
    };
    const next = document.createDocumentFragment();
    if (!data.count) next.appendChild(el("p", "kx-message", "No live Claude sessions"));
    else if (data.groups) {
      for (const g of data.groups) {
        const project = g.project || "unknown";
        const heading = groupHeading(project, g.sessions.length, "folder", "kx-project", `project:${project}`);
        heading.dataset.key = `project:${project}`;
        next.appendChild(heading);
        const rows = rowsFor(heading, `project:${project}`);
        if (!rows) continue;
        rows.appendChild(groupsFor(g.sessions, project, rowOf));
        next.appendChild(rows);
      }
    } else {
      next.appendChild(groupsFor(data.sessions, undefined, rowOf));
    }
    rowKeys = keys;
    // a bar kept in place moves from its previous width by the style's transition; a moved row was taken out of
    // the document for a moment and lost its previous style, so its fill starts at the old width and moves after
    // a forced layout
    const previous = new Map([...listEl.querySelectorAll(".kx-session")].map((row) => [row, (row.querySelector(".kx-fill") || row).style.getPropertyValue("--p")]));
    const moved = [], focused = listEl.contains(document.activeElement) ? document.activeElement : null;
    patchChildren(listEl, [...next.childNodes], keyedIn(listEl), moved);
    // a moved node was out of the document for a moment, which takes the focus away: the row gets it back
    if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    // on the way back from the detail view (`still`) the list was hidden until now, so a bar kept in place has no
    // width to move from: none moves, or the moved rows alone would slide from where they were minutes ago
    const moving = [];
    if (!still) for (const row of moved.flatMap((m) => [...(m.matches(".kx-session") ? [m] : []), ...m.querySelectorAll(".kx-session")])) {
      const fill = row.querySelector(".kx-fill"), from = previous.get(row);
      if (!fill || !from || from === fill.style.getPropertyValue("--p")) continue;
      moving.push([fill, fill.style.getPropertyValue("--p")]);
      fill.style.setProperty("--p", from);
    }
    if (moving.length) {
      void listEl.offsetWidth; // lay out once at the previous widths, so the change below transitions
      for (const [fill, to] of moving) fill.style.setProperty("--p", to);
    }
  }

  // ── The host: the list and the detail come as messages; the panel sends ready, refresh, scope and detail ──
  /** The list as render() iterates it: arrays where it loops, whatever the host sent. */
  function listPayload(data) {
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
      ...data, sessions: arr(data.sessions), errors: arr(data.errors).filter((f) => typeof f === "string"),
      groups: Array.isArray(data.groups) ? data.groups.filter((g) => g && typeof g === "object").map((g) => ({ ...g, sessions: arr(g.sessions) })) : null,
    };
  }
  refreshEl.appendChild(icon("refresh"));
  compactEl.appendChild(icon("rows"));
  // compact rows: the list's attribute switches the CSS, so no render is needed; remembered, but not part of the view "reset" clears
  function showCompact(on) {
    listEl.toggleAttribute("data-compact", on);
    compactEl.setAttribute("aria-pressed", String(on));
    compactEl.title = on ? "Full rows: bar, curve, model, turns and cache" : "Compact rows: title, count and bar only";
  }
  showCompact(store.get("compact") === true);
  compactEl.addEventListener("click", () => {
    const on = compactEl.getAttribute("aria-pressed") !== "true";
    store.set("compact", on);
    showCompact(on);
  });
  // the session open when the panel was last shown
  const remembered = store.get("open");
  if (typeof remembered === "string" && remembered) { openId = remembered; focusBack = true; showMode(); }
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "sessions") render(listPayload(e.data));
    if (e.data && e.data.type === "detail") onDetail(e.data);
  });
  // the pressed button follows the click at once; the host stores the choice and sends the list of the new scope
  function setScope(all, focus) {
    if (focus) focus.focus();
    if (scopeAllEl.getAttribute("aria-pressed") === String(all)) return;
    scopeWorkspaceEl.setAttribute("aria-pressed", String(!all));
    scopeAllEl.setAttribute("aria-pressed", String(all));
    vscode.postMessage({ type: "scope", all });
  }
  scopeWorkspaceEl.addEventListener("click", () => setScope(false));
  scopeAllEl.addEventListener("click", () => setScope(true));
  scopeMoreEl.addEventListener("click", () => setScope(true, scopeAllEl)); // it disappears with the next list; focus stays on the switch
  refreshEl.addEventListener("click", () => {
    if (refreshPending) return;
    refreshPending = true;
    refreshEl.setAttribute("aria-busy", "true");
    refreshGiveUp = setTimeout(() => { refreshPending = false; refreshEl.removeAttribute("aria-busy"); }, REFRESH_GIVE_UP_MS);
    vscode.postMessage({ type: "refresh" });
  });
  vscode.postMessage({ type: "ready" });
})();
