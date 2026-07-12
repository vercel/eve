/**
 * 로싸인(LawSign) 프론트엔드 SPA 코어
 * - 해시 기반 라우팅(#/documents?view=kanban&status=...) → 필터 상태를 URL에 보존
 * - 공통 UI(토스트/모달/뱃지/차트/QR), 대시보드, 문서함(리스트·칸반), 검증 포털
 * - 서명 요청 3단계 플로우는 js/request.js 참조
 */
(function (LS) {
  'use strict';

  // ── 유틸 ──────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      const args = arguments;
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '시간 전';
    const d = Math.floor(h / 24);
    if (d < 8) return d + '일 전';
    return fmtDate(ts);
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDateTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return fmtDate(ts) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  const staleDays = (d) => Math.floor((Date.now() - d.lastActivityAt) / 86400000);

  // ── 아이콘 (24px stroke 아이콘 셋, 자체 제작) ────────────────────
  const I = (path, size) =>
    '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  const icons = {
    home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
    pen: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    folder: I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    shield: I('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z"/><path d="m9 12 2 2 4-4"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
    bell: I('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>'),
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/>'),
    doc: I('<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v4h4"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    check: I('<path d="m4 12.5 5 5L20 6.5"/>'),
    x: I('<path d="m6 6 12 12M18 6 6 18"/>'),
    dots: I('<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>'),
    grid: I('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
    rows: I('<rect x="4" y="5" width="16" height="4" rx="1.5"/><rect x="4" y="15" width="16" height="4" rx="1.5"/>'),
    text: I('<path d="M5 6h14M12 6v13"/>'),
    checkbox: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5L16 9"/>'),
    calendar: I('<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
    image: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3 3 3-3 3 3"/>'),
    stamp: I('<path d="M9 11V6a3 3 0 0 1 6 0v5"/><path d="M5 15a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2H5Z"/><path d="M5 20h14"/>'),
    download: I('<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>'),
    sun: I('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/>'),
    send: I('<path d="m3.5 11.5 17-7.5-7.5 17-2-7.5Z"/>'),
    warn: I('<path d="M12 3 2.5 20h19Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r="0.8" fill="currentColor" stroke="none"/>'),
    diamond: I('<path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M2 9h20M9.5 3 8 9l4 12M14.5 3 16 9l-4 12"/>'),
    mail: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    chat: I('<path d="M21 12a8 8 0 0 1-8 8H4l2.5-3A8 8 0 1 1 21 12Z"/>'),
    link: I('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'),
    upload: I('<path d="M12 16V5"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>'),
  };
  LS.icons = icons;

  // ── 상태 메타 ─────────────────────────────────────────────────────
  const STATUS = {
    DRAFT: { label: '요청 전', color: 'gray' },
    SCHEDULED: { label: '예약됨', color: 'violet' },
    NEED_MY_SIGN: { label: '내 서명 필요', color: 'red' },
    PENDING_OTHERS: { label: '상대 서명 대기', color: 'blue' },
    COMPLETED: { label: '서명 완료', color: 'green' },
    REJECTED: { label: '거절·취소', color: 'gray' },
  };
  const statusBadge = (s) => '<span class="badge ' + STATUS[s].color + '">' + STATUS[s].label + '</span>';

  // ── 토스트 & 모달 ─────────────────────────────────────────────────
  function toast(msg, opts) {
    opts = opts || {};
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = msg;
    if (opts.action) {
      const b = document.createElement('button');
      b.className = 'undo';
      b.textContent = opts.action.label;
      b.addEventListener('click', () => { el.remove(); opts.action.onClick(); });
      el.appendChild(b);
    }
    root.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, opts.ms || (opts.action ? 5000 : 2600));
    return el;
  }

  function openModal(html, opts) {
    closeModal();
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = '<div class="modal ' + ((opts && opts.wide) ? 'wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
    document.body.appendChild(back);
    $$('.modal-close', back).forEach((b) => b.addEventListener('click', closeModal));
    return back;
  }
  function closeModal() {
    const b = $('.modal-backdrop');
    if (b) b.remove();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function emptyState(title, desc, ctaHtml) {
    return (
      '<div class="empty-state"><div class="art">' + icons.doc.replace('width="16" height="16"', 'width="30" height="30"') + '</div>' +
      '<b>' + title + '</b><p>' + desc + '</p>' + (ctaHtml || '') + '</div>');
  }
  LS.ui = { esc, $, $$, debounce, relTime, fmtDate, fmtDateTime, toast, openModal, closeModal, statusBadge, STATUS, staleDays };

  // ── SVG 꺾은선 차트 (외부 라이브러리 없이 렌더) ──────────────────
  function lineChart(points, opts) {
    const W = 640, Hh = 200, padX = 34, padY = 22;
    const max = Math.max.apply(null, points.map((p) => p.completed)) * 1.15;
    const stepX = (W - padX * 2) / (points.length - 1);
    const xy = points.map((p, i) => [padX + i * stepX, Hh - padY - (p.completed / max) * (Hh - padY * 2)]);
    const path = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = path + ' L' + xy[xy.length - 1][0].toFixed(1) + ' ' + (Hh - padY) + ' L' + padX + ' ' + (Hh - padY) + ' Z';
    const gridY = [0.25, 0.5, 0.75].map((r) => {
      const y = Hh - padY - r * (Hh - padY * 2);
      return '<line x1="' + padX + '" x2="' + (W - padX) + '" y1="' + y + '" y2="' + y + '" stroke="var(--border)" stroke-dasharray="3 4"/>';
    }).join('');
    const labels = points.filter((_, i) => i % 7 === 0).map((p, i) => '<text x="' + (padX + i * 7 * stepX) + '" y="' + (Hh - 4) + '" font-size="10" fill="var(--text-3)" text-anchor="middle">' + esc(p.date) + '</text>').join('');
    const last = xy[xy.length - 1];
    const svg =
      '<svg viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" role="img" aria-label="최근 30일 서명 완료 추이">' +
      '<defs><linearGradient id="lg-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--brand-500)" stop-opacity="0.22"/><stop offset="1" stop-color="var(--brand-500)" stop-opacity="0"/></linearGradient></defs>' +
      gridY +
      '<path d="' + area + '" fill="url(#lg-fill)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--brand-600)" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<circle class="chart-cursor" r="4" fill="var(--brand-600)" stroke="#fff" stroke-width="1.5" opacity="0"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="var(--brand-600)"/>' +
      labels +
      '</svg>';
    return { svg, xy, W, H: Hh };
  }

  /** 차트 호버/터치 툴팁 — 뷰포트 좌표 → 최근접 데이터 포인트 매핑 */
  function bindChartTooltip(wrap, chart, points) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    wrap.appendChild(tip);
    const svg = $('svg', wrap);
    const cursor = $('.chart-cursor', wrap);
    const hide = () => { tip.style.display = 'none'; cursor.setAttribute('opacity', '0'); };
    wrap.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width; // 0..1
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((fx * chart.W) - chart.xy[0][0]) / ((chart.xy[1][0] - chart.xy[0][0]) || 1))));
      const [vx, vy] = chart.xy[i];
      cursor.setAttribute('cx', vx);
      cursor.setAttribute('cy', vy);
      cursor.setAttribute('opacity', '1');
      tip.style.display = 'block';
      tip.style.left = (vx / chart.W) * r.width + (r.left - wrap.getBoundingClientRect().left) + 'px';
      tip.style.top = (vy / chart.H) * r.height + (r.top - wrap.getBoundingClientRect().top) + 'px';
      tip.innerHTML = '완료 ' + points[i].completed + '건<small>' + esc(points[i].date) + '</small>';
    });
    wrap.addEventListener('pointerleave', hide);
  }

  // ── 의사 QR (검증 URL 시각화 · 프로토타입 표기) ──────────────────
  function qrSvg(seed) {
    const N = 21;
    let acc = 0;
    for (let i = 0; i < seed.length; i++) acc = ((acc << 5) - acc + seed.charCodeAt(i)) >>> 0;
    const rnd = () => { acc = (acc * 1664525 + 1013904223) >>> 0; return acc / 4294967296; };
    let cells = '';
    const finder = (x, y) =>
      '<rect x="' + x + '" y="' + y + '" width="7" height="7" fill="#111"/><rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="5" height="5" fill="#fff"/><rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="3" height="3" fill="#111"/>';
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const inFinder = (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
        if (!inFinder && rnd() > 0.52) cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="#111"/>';
      }
    return '<svg viewBox="0 0 ' + N + ' ' + N + '" shape-rendering="crispEdges">' + cells + finder(0, 0) + finder(N - 7, 0) + finder(0, N - 7) + '</svg>';
  }
  LS.qrSvg = qrSvg;

  // ── 라우터 ───────────────────────────────────────────────────────
  const routes = {};
  LS.route = (name, render) => { routes[name] = render; };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [path, qs] = h.split('?');
    const params = {};
    if (qs) qs.split('&').forEach((kv) => { const [k, v] = kv.split('='); params[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return { path: path || 'dashboard', params };
  }
  function nav(path, params) {
    const qs = params ? Object.keys(params).filter((k) => params[k] !== '' && params[k] != null).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&') : '';
    location.hash = '#/' + path + (qs ? '?' + qs : '');
  }
  LS.nav = nav;

  async function render() {
    const { path, params } = parseHash();
    const view = routes[path] || routes.dashboard;
    $$('.lnb-item, .bottom-nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === path));
    const main = $('#app-main');
    // 스켈레톤 로딩 — 텍스트 대신 실제 레이아웃 형태를 미리 그려 CLS 제거
    main.innerHTML =
      '<div class="page" aria-busy="true">' +
      '<div class="skeleton" style="height:34px;width:280px;margin-bottom:18px"></div>' +
      '<div class="skel-grid">' + '<div class="skeleton" style="height:86px"></div>'.repeat(4) + '</div>' +
      '<div class="skel-row"><div class="skeleton" style="height:280px"></div><div class="skeleton" style="height:280px"></div></div></div>';
    try {
      await view(main, params);
    } catch (e) {
      main.innerHTML = '<div class="page"><div class="card card-pad">화면을 불러오지 못했습니다: ' + esc(e.message) + '</div></div>';
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);

  // ══════════════════════════════════════════════════════════════════
  // 화면 1: 홈 대시보드
  // ══════════════════════════════════════════════════════════════════
  LS.route('dashboard', async (main) => {
    const sum = await LS.api.getDashboardSummary();
    const c = sum.counts;
    const stats = [
      { k: '내 서명 필요', v: c.NEED_MY_SIGN, color: 'var(--red-600)', status: 'NEED_MY_SIGN' },
      { k: '상대 서명 대기', v: c.PENDING_OTHERS, color: 'var(--blue-600)', status: 'PENDING_OTHERS' },
      { k: '서명 완료', v: c.COMPLETED, color: 'var(--green-600)', status: 'COMPLETED' },
      { k: '예약 발송', v: c.SCHEDULED, color: 'var(--violet-600)', status: 'SCHEDULED' },
    ];
    const tpls = await LS.api.listTemplates();
    const docs = (await LS.api.listDocuments({ size: 500 })).items;

    const today = new Date();
    const todayLabel = today.getFullYear() + '년 ' + (today.getMonth() + 1) + '월 ' + today.getDate() + '일 (' + '일월화수목금토'[today.getDay()] + ')';
    const chart = lineChart(sum.trend);

    // 이번 달 미니 캘린더: 일자별 ①발송약정 ②서명됨 ③서명대기 집계 (메일함 캘린더 뷰와 동일 규칙)
    const calY = today.getFullYear();
    const calM = today.getMonth();
    const calByDay = {};
    const calSlot = (day) => (calByDay[day] = calByDay[day] || { sent: 0, signed: 0, waiting: 0 });
    docs.forEach((d) => {
      const c = new Date(d.createdAt);
      if (c.getFullYear() === calY && c.getMonth() === calM) {
        const s = calSlot(c.getDate());
        s.sent++;
        if (d.status === 'PENDING_OTHERS' || d.status === 'NEED_MY_SIGN' || d.status === 'SCHEDULED') s.waiting++;
      }
      if (d.completedAt) {
        const e = new Date(d.completedAt);
        if (e.getFullYear() === calY && e.getMonth() === calM) calSlot(e.getDate()).signed++;
      }
    });
    const calFirst = new Date(calY, calM, 1).getDay();
    const calDays = new Date(calY, calM + 1, 0).getDate();
    let calCells = '';
    for (let i = 0; i < calFirst; i++) calCells += '<div class="cal-cell off"></div>';
    for (let day = 1; day <= calDays; day++) {
      const s = calByDay[day];
      calCells +=
        '<div class="cal-cell' + (day === today.getDate() ? ' today' : '') + (s ? ' has' : '') + '" data-day="' + day + '">' +
        '<span class="d">' + day + '</span>' +
        (s
          ? '<span class="cal-chips">' +
            (s.sent ? '<span class="cal-chip send" title="발송약정">📤 ' + s.sent + '</span>' : '') +
            (s.signed ? '<span class="cal-chip done" title="서명됨">✅ ' + s.signed + '</span>' : '') +
            (s.waiting ? '<span class="cal-chip wait" title="서명대기">⏳ ' + s.waiting + '</span>' : '') +
            '</span>'
          : '') +
        '</div>';
    }
    const calHtml =
      '<section class="card card-pad" id="dash-cal">' +
      '<div class="toolbar-row" style="justify-content:space-between;margin-bottom:10px">' +
      '<div class="section-title" style="margin:0">' + icons.calendar + ' ' + (calM + 1) + '월 발송·체결 캘린더 <span class="badge gold">' + icons.check + ' Google Calendar 연동됨</span></div>' +
      '<button class="btn sm" id="dash-cal-full">전체 캘린더 보기 ›</button></div>' +
      '<div class="toolbar-row" style="gap:12px;margin-bottom:8px;font-size:12px">' +
      '<span class="cal-chip send">📤 발송약정</span><span class="cal-chip done">✅ 서명됨</span><span class="cal-chip wait">⏳ 서명대기</span></div>' +
      '<div class="cal-week">' + ['일', '월', '화', '수', '목', '금', '토'].map((w) => '<span>' + w + '</span>').join('') + '</div>' +
      '<div class="cal-grid mini">' + calCells + '</div></section>';

    main.innerHTML =
      '<div class="page">' +
      '<div class="dash-head"><div><div class="dim" style="font-size:12px;font-weight:700;letter-spacing:0.02em">' + todayLabel + '</div>' +
      '<h1>' + esc(LS.workspace.name) + ' 님, 환영합니다</h1>' +
      '<div class="sub">' + icons.warn + ' 오늘 처리해야 할 요주의 문서가 ' + (c.NEED_MY_SIGN + sum.urgent.length) + '건 있습니다.</div></div>' +
      '<button class="btn primary" id="dash-new">' + icons.pen + ' 새 서명 요청 시작하기</button></div>' +

      '<div class="stat-grid">' + stats.map((s) =>
        '<div class="stat" style="--accent:' + s.color + '" data-status="' + s.status + '" role="button" tabindex="0">' +
        '<div class="k"><span class="dot" style="background:' + s.color + '"></span>' + s.k + '</div>' +
        '<div class="v">' + s.v.toLocaleString() + '<span class="dim" style="font-size:13px;font-weight:600"> 건</span></div></div>').join('') +
      '</div>' +

      '<div class="dash-grid">' +
      calHtml +

      '<section class="card card-pad"><div class="section-title" style="color:var(--red-600)">' + icons.warn + ' 마감 임박 · 요주의 문서</div>' +
      (sum.urgent.length ? sum.urgent.map((d) =>
        '<div class="urgent-item"><div class="t">' + esc(d.title) + '</div>' +
        '<div class="meta"><span class="badge red">' + staleDays(d) + '일 경과</span><span>' + icons.clock + ' ' + relTime(d.lastActivityAt) + '</span></div>' +
        '<button class="btn sm" data-remind="' + d.id + '">' + icons.bell + ' 독촉 알림 발송 (카카오톡·이메일)</button></div>').join('')
        : '<p class="dim" style="margin-top:12px">지연 중인 문서가 없습니다. 👍</p>') +
      '</section></div>' +

      '<section class="card card-pad" style="margin-top:16px"><div class="section-title">⚡ 퀵 템플릿 — 자주 쓰는 양식으로 바로 시작</div>' +
      '<div class="tpl-grid">' + tpls.map((t) =>
        '<button class="tpl-card" data-tpl="' + t.id + '"><span class="ic">' + icons.doc + '</span><b>' + esc(t.title) + '</b>' +
        '<span class="dim" style="font-size:11.5px">입력 필드 ' + t.fields + '개 · ' + t.usedCount + '회 사용</span></button>').join('') +
      '<button class="tpl-card add">' + icons.plus + ' 내 템플릿 추가</button></div></section>' +

      '<section class="card card-pad" style="margin-top:16px"><div class="section-title">' + icons.grid + ' 서명 파이프라인 현황 <span class="badge gray">최근 30일</span></div>' +
      '<div class="chart-wrap" id="dash-chart">' + chart.svg + '</div></section>' +
      '</div>';

    $('#dash-new').addEventListener('click', () => nav('request'));
    $('#dash-cal-full').addEventListener('click', () => nav('documents', { view: 'calendar' }));
    $$('#dash-cal .cal-cell.has', main).forEach((cell) => cell.addEventListener('click', () => nav('documents', { view: 'calendar' })));
    bindChartTooltip($('#dash-chart'), chart, sum.trend);
    $$('.stat', main).forEach((el) => el.addEventListener('click', () => nav('documents', { status: el.dataset.status, view: 'kanban' })));
    $$('[data-tpl]', main).forEach((el) => el.addEventListener('click', () => nav('request', { tpl: el.dataset.tpl })));
    $$('[data-remind]', main).forEach((el) =>
      el.addEventListener('click', async () => {
        el.disabled = true;
        const r = await LS.api.remindSigners(el.dataset.remind);
        toast('🔔 서명자 ' + r.sent + '명에게 독촉 알림을 발송했습니다.');
        el.innerHTML = icons.check + ' 발송 완료';
      })
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // 화면 2: 문서함 (리스트 뷰 ⇄ 칸반 뷰, 필터 상태는 URL에 유지)
  // ══════════════════════════════════════════════════════════════════
  const KANBAN_COLS = [
    { key: 'PRE', title: '📝 요청 전 (작성·예약)', statuses: ['DRAFT', 'SCHEDULED'], drop: 'DRAFT' },
    { key: 'NEED_MY_SIGN', title: '✍️ 내 서명 필요', statuses: ['NEED_MY_SIGN'], drop: 'NEED_MY_SIGN' },
    { key: 'PENDING_OTHERS', title: '⏳ 상대 서명 대기', statuses: ['PENDING_OTHERS'], drop: 'PENDING_OTHERS' },
    { key: 'COMPLETED', title: '✅ 서명 완료됨', statuses: ['COMPLETED'], drop: 'COMPLETED' },
  ];

  // 벤치마크 LNB(모든 상태/진행 중/종결됨/요청 전/문서 관리)를 메일함 폴더 레일로 재구성
  const MAIL_GROUPS = [
    { title: '', items: [{ key: '', label: '전체 문서함' }] },
    { title: '진행 중', items: [{ key: 'NEED_MY_SIGN', label: '내 서명 필요' }, { key: 'PENDING_OTHERS', label: '상대 서명 대기' }] },
    { title: '종결됨', items: [{ key: 'COMPLETED', label: '서명 완료됨' }, { key: 'REJECTED', label: '거절·취소됨' }] },
    { title: '요청 전', items: [{ key: 'DRAFT', label: '작성 중' }, { key: 'SCHEDULED', label: '예약됨' }] },
    { title: '문서 관리', items: [{ key: 'REMIND', label: '리마인더' }, { key: '_EXPORT', label: '데이터 추출' }] },
  ];
  const folderLabel = (key) => {
    for (const g of MAIL_GROUPS) for (const it of g.items) if (it.key === key) return it.label;
    return '전체 문서함';
  };

  LS.route('documents', async (main, params) => {
    const view = params.view === 'kanban' ? 'kanban' : params.view === 'calendar' ? 'calendar' : 'mail';
    const state = { q: params.q || '', status: params.status || '', label: params.label || '', range: params.range || '' };
    const urlOf = (over) => Object.assign({ view, q: state.q, status: state.status, label: state.label, range: state.range }, over || {});
    const syncUrl = () => nav('documents', urlOf());

    const filtersHtml =
      '<div class="toolbar-row" style="margin-bottom:12px">' +
      '<div class="search-box">' + icons.search + '<input class="input" id="doc-q" placeholder="문서 제목·서명자로 찾기" value="' + esc(state.q) + '"></div>' +
      '<select class="input" id="doc-label" style="width:auto"><option value="">🏷️ 라벨 전체</option>' +
      LS.labels.map((l) => '<option ' + (state.label === l ? 'selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
      '<select class="input" id="doc-range" style="width:auto">' +
      [['', '📅 기간 전체'], ['1', '오늘'], ['7', '최근 7일'], ['30', '최근 30일']].map(([v, t]) =>
        '<option value="' + v + '" ' + (state.range === v ? 'selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      (view === 'kanban' ? '<span class="dim" style="font-size:12px">카드를 드래그하여 상태를 변경할 수 있습니다</span>' : '') +
      '</div>';

    main.innerHTML =
      '<div class="page">' +
      '<div class="docbox-head"><h1 style="font-size:20px">' + icons.mail + ' 메일함 ' +
      '<span class="badge gold">' + icons.check + ' Gmail 연동됨</span> <span class="badge amber">💬 카카오 알림톡</span></h1>' +
      '<div class="toolbar-row">' +
      '<div class="view-toggle">' +
      [['mail', icons.mail + ' 메일함'], ['kanban', icons.grid + ' 칸반'], ['calendar', icons.calendar + ' 캘린더']].map(([v, t]) =>
        '<button data-v="' + v + '" class="' + (view === v ? 'active' : '') + '">' + t + '</button>').join('') + '</div>' +
      '<button class="btn primary" id="doc-new">' + icons.pen + ' 새 서명 요청</button></div></div>' +
      (view === 'mail'
        ? '<div class="mailbox-layout"><aside class="mail-rail" id="mail-rail" aria-label="메일함 폴더"></aside>' +
          '<section class="mail-pane">' + filtersHtml + '<div id="doc-body"></div></section></div>'
        : view === 'kanban'
        ? filtersHtml + '<div id="doc-body"></div>'
        : '<div id="doc-body"></div>') +
      '</div>';

    $('#doc-new').addEventListener('click', () => nav('request'));
    $$('.view-toggle button', main).forEach((b) => b.addEventListener('click', () => nav('documents', urlOf({ view: b.dataset.v }))));
    const labelSel = $('#doc-label');
    if (labelSel) labelSel.addEventListener('change', (e) => { state.label = e.target.value; syncUrl(); });
    const rangeSel = $('#doc-range');
    if (rangeSel) rangeSel.addEventListener('change', (e) => { state.range = e.target.value; syncUrl(); });
    // 실시간 검색: 500ms 디바운스로 서버 질의 횟수를 통제 (본문만 갱신, URL은 replaceState)
    const qInput = $('#doc-q');
    if (qInput) qInput.addEventListener('input', debounce((e) => {
      state.q = e.target.value.trim();
      const p = urlOf();
      history.replaceState(null, '', '#/documents?' + Object.keys(p).filter((k) => p[k]).map((k) => k + '=' + encodeURIComponent(p[k])).join('&'));
      drawBody();
    }, 500));

    // ── 폴더 레일 (전체/진행 중/종결됨/요청 전/문서 관리 + 건수) ──
    async function drawRail() {
      const rail = $('#mail-rail');
      if (!rail) return;
      const all = await LS.api.listDocuments({ size: 500 });
      const counts = { '': all.items.length, REMIND: 0 };
      all.items.forEach((d) => {
        counts[d.status] = (counts[d.status] || 0) + 1;
        if (d.status === 'PENDING_OTHERS' && staleDays(d) >= 3) counts.REMIND++;
      });
      rail.innerHTML = MAIL_GROUPS.map((g) =>
        (g.title ? '<div class="rail-group">' + g.title + '</div>' : '') +
        g.items.map((it) => {
          if (it.key === '_EXPORT') return '<button class="rail-item" data-export="1">' + icons.download + ' <span>데이터 추출</span></button>';
          const n = counts[it.key] || 0;
          return '<button class="rail-item' + (state.status === it.key ? ' active' : '') + (it.key === 'REMIND' && n ? ' hot' : '') + '" data-key="' + it.key + '">' +
            '<span>' + it.label + '</span><span class="cnt">' + n.toLocaleString() + '</span></button>';
        }).join('')
      ).join('');
      $$('.rail-item[data-key]', rail).forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.key; syncUrl(); }));
      const exp = $('[data-export]', rail);
      if (exp) exp.addEventListener('click', exportCsv);
    }

    /** 데이터 추출 — 현재 필터 결과를 CSV(UTF-8 BOM, 엑셀 호환)로 내려받기 */
    async function exportCsv() {
      const res = await LS.api.listDocuments({ q: state.q, status: state.status, label: state.label, rangeDays: state.range, size: 500 });
      const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const rows = [['문서 제목', '상태', '서명자', '라벨', '마지막 활동', '해시 등록'].map(cell).join(',')]
        .concat(res.items.map((d) => [d.title, STATUS[d.status].label, d.signers.map((s) => s.name).join(' / '), d.label || '', LS.ui.fmtDateTime(d.lastActivityAt), d.hash ? 'Y' : 'N'].map(cell).join(',')));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }));
      a.download = 'lawsign_documents_' + LS.ui.fmtDate(Date.now()) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('📊 문서 ' + res.items.length + '건을 CSV로 추출했습니다.');
    }

    // ── 캘린더 뷰: 일자별 ①발송약정 ②서명됨 ③서명대기 집계 ──────────
    async function drawCalendar(body) {
      const res = await LS.api.listDocuments({ size: 500 });
      const y = cal.y;
      const m = cal.m;
      const byDay = {}; // day -> { sent, signed, waiting, docs: [] }
      const slot = (day) => (byDay[day] = byDay[day] || { sent: 0, signed: 0, waiting: 0, docs: [] });
      res.items.forEach((d) => {
        const c = new Date(d.createdAt);
        if (c.getFullYear() === y && c.getMonth() === m) {
          const s = slot(c.getDate());
          s.sent++; // 발송약정: 해당 일자에 발송(예약 포함)된 요청
          if (d.status === 'PENDING_OTHERS' || d.status === 'NEED_MY_SIGN' || d.status === 'SCHEDULED') s.waiting++;
          s.docs.push(d);
        }
        if (d.completedAt) {
          const e = new Date(d.completedAt);
          if (e.getFullYear() === y && e.getMonth() === m) {
            const s = slot(e.getDate());
            s.signed++;
            if (!s.docs.includes(d)) s.docs.push(d);
          }
        }
      });
      const first = new Date(y, m, 1).getDay();
      const days = new Date(y, m + 1, 0).getDate();
      const today = new Date();
      let cells = '';
      for (let i = 0; i < first; i++) cells += '<div class="cal-cell off"></div>';
      for (let day = 1; day <= days; day++) {
        const s = byDay[day];
        const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === day;
        cells +=
          '<div class="cal-cell' + (isToday ? ' today' : '') + (s ? ' has' : '') + '" data-day="' + day + '">' +
          '<span class="d">' + day + '</span>' +
          (s
            ? '<span class="cal-chips">' +
              (s.sent ? '<span class="cal-chip send" title="발송약정">📤 ' + s.sent + '</span>' : '') +
              (s.signed ? '<span class="cal-chip done" title="서명됨">✅ ' + s.signed + '</span>' : '') +
              (s.waiting ? '<span class="cal-chip wait" title="서명대기">⏳ ' + s.waiting + '</span>' : '') +
              '</span>'
            : '') +
          '</div>';
      }
      body.innerHTML =
        '<div class="card card-pad">' +
        '<div class="toolbar-row" style="justify-content:space-between;margin-bottom:12px">' +
        '<div class="section-title">' + icons.calendar + ' ' + y + '년 ' + (m + 1) + '월 발송·체결 캘린더 <span class="badge gold">' + icons.check + ' Google Calendar 연동됨</span></div>' +
        '<span class="toolbar-row"><button class="btn sm" id="cal-prev">‹ 이전 달</button><button class="btn sm" id="cal-next">다음 달 ›</button></span></div>' +
        '<div class="toolbar-row" style="gap:14px;margin-bottom:10px;font-size:12px">' +
        '<span class="cal-chip send">📤 발송약정</span><span class="cal-chip done">✅ 서명됨</span><span class="cal-chip wait">⏳ 서명대기</span>' +
        '<span class="dim">날짜를 클릭하면 해당 일자의 문서를 확인합니다. 서명 기한·예약 발송은 Google Calendar에 자동 등록됩니다.</span></div>' +
        '<div class="cal-week">' + ['일', '월', '화', '수', '목', '금', '토'].map((w) => '<span>' + w + '</span>').join('') + '</div>' +
        '<div class="cal-grid">' + cells + '</div></div>';
      $('#cal-prev').addEventListener('click', () => { cal.m--; if (cal.m < 0) { cal.m = 11; cal.y--; } drawBody(); });
      $('#cal-next').addEventListener('click', () => { cal.m++; if (cal.m > 11) { cal.m = 0; cal.y++; } drawBody(); });
      $$('.cal-cell.has', body).forEach((cell) =>
        cell.addEventListener('click', () => {
          const s = byDay[+cell.dataset.day];
          openModal(
            '<div class="modal-head"><h3>' + (m + 1) + '월 ' + cell.dataset.day + '일 — 발송약정 ' + s.sent + ' · 서명됨 ' + s.signed + ' · 서명대기 ' + s.waiting + '</h3><button class="modal-close">×</button></div>' +
            '<div class="modal-body"><div class="card mail-list">' + s.docs.map(mailRow).join('') + '</div></div>',
            { wide: true });
          bindMailActions($('.modal-backdrop'));
          bindRowMenus($('.modal-backdrop'));
        }));
    }

    // 벤치마크 규칙: 10개씩 보기 + 페이지네이션 (상태별 목록의 기본 탐색 단위)
    let pageSize = 10;
    let pageNo = 1;
    const nowD = new Date();
    const cal = { y: nowD.getFullYear(), m: nowD.getMonth() };

    function mailRow(d) {
      const unread = d.status === 'NEED_MY_SIGN' || (d.status === 'PENDING_OTHERS' && Date.now() - d.lastActivityAt < 86400000);
      const first = d.signers[0];
      const meta = [
        '요청 ' + LS.ui.fmtDate(d.createdAt).slice(5),
        d.completedAt ? '체결 ' + LS.ui.fmtDate(d.completedAt).slice(5) : null,
        d.label || null,
        d.hash ? '🔒 해시 등록' : '기한 ' + d.expirationDays + '일',
      ].filter(Boolean).join(' · ');
      return (
        '<div class="mail-row' + (unread ? ' unread' : '') + '" data-id="' + d.id + '" role="button" tabindex="0">' +
        '<span class="mail-avatar">' + esc(((first && first.name) || '문').slice(0, 1)) + '</span>' +
        '<div class="mail-main"><div class="mail-top"><span class="mail-title">' + esc(d.title) + '</span>' + statusBadge(d.status) +
        (d.status === 'PENDING_OTHERS' && staleDays(d) >= 3 ? ' <span class="badge red">⏳ 리마인드</span>' : '') + '</div>' +
        '<div class="mail-snippet">' + esc(d.signers.map((s) => s.name).join(', ') || '서명자 미지정') + ' · ' + meta + '</div></div>' +
        '<div class="mail-side"><span class="mail-time">' + relTime(d.lastActivityAt) + '</span>' +
        '<span class="mail-actions">' +
        '<button class="icon-a" title="Gmail 이메일 발신" data-mail="' + d.id + '" aria-label="이메일 발신">' + icons.mail + '</button>' +
        '<button class="icon-a" title="카카오톡 알림 발신" data-kakao="' + d.id + '" aria-label="카카오톡 알림">' + icons.chat + '</button>' +
        '<button class="icon-a" title="이력·검증" data-menu="' + d.id + '" aria-label="문서 메뉴">' + icons.dots + '</button>' +
        '</span></div></div>');
    }

    function bindMailActions(root) {
      $$('[data-mail]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); LS.openComposeModal(b.dataset.mail, 'EMAIL'); }));
      $$('[data-kakao]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); LS.openComposeModal(b.dataset.kakao, 'KAKAO'); }));
      $$('.mail-row', root).forEach((r) => r.addEventListener('click', () => openHistoryModal(r.dataset.id)));
    }

    async function drawBody() {
      drawRail();
      const body = $('#doc-body');
      if (view === 'calendar') {
        await drawCalendar(body);
        return;
      }
      if (view === 'mail') {
        const res = await LS.api.listDocuments({ q: state.q, status: state.status, label: state.label, rangeDays: state.range, size: 500 });
        const total = res.items.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        pageNo = Math.min(pageNo, pages);
        const slice = res.items.slice((pageNo - 1) * pageSize, pageNo * pageSize);
        const remindHead = state.status === 'REMIND'
          ? '<div class="editor-hint" style="margin-bottom:12px">📅 <b>오늘의 리마인드가 ' + total + '건</b> 있습니다 — 3일 이상 응답이 없는 요청입니다. 행의 발신 버튼으로 즉시 독촉하세요.</div>'
          : '';
        body.innerHTML = total
          ? remindHead + '<div class="card mail-list">' + slice.map(mailRow).join('') + '</div>' +
            '<div class="toolbar-row" style="margin-top:12px;justify-content:space-between">' +
            '<span class="dim" style="font-size:12px">총 ' + total.toLocaleString() + '건 · ' + pageNo + '/' + pages + ' 페이지</span>' +
            '<span class="toolbar-row"><select class="input" id="page-size" style="width:auto;padding:5px 8px;font-size:12px">' +
            [10, 25, 50].map((n) => '<option value="' + n + '" ' + (pageSize === n ? 'selected' : '') + '>' + n + '개씩 보기</option>').join('') + '</select>' +
            '<button class="btn sm" id="pg-prev" ' + (pageNo <= 1 ? 'disabled' : '') + '>‹ 이전</button>' +
            '<button class="btn sm" id="pg-next" ' + (pageNo >= pages ? 'disabled' : '') + '>다음 ›</button></span></div>'
          : remindHead + '<div class="card">' + emptyState(
              "'" + folderLabel(state.status) + "' 상태의 문서가 없습니다",
              state.q ? '「' + esc(state.q) + '」 검색어를 바꾸거나 필터를 해제해 보세요.' : '다른 폴더를 확인하거나 새 서명 요청을 시작해 보세요.',
              '<button class="btn sm" id="back-all">↩ 모든 문서로 돌아가기</button> <button class="btn primary sm" onclick="LS.nav(\'request\')">' + icons.pen + ' 새 서명 요청</button>') + '</div>';
        const backAll = $('#back-all', body);
        if (backAll) backAll.addEventListener('click', () => { state.status = ''; syncUrl(); });
        const ps = $('#page-size', body);
        if (ps) ps.addEventListener('change', (e) => { pageSize = +e.target.value; pageNo = 1; drawBody(); });
        const pv = $('#pg-prev', body);
        if (pv) pv.addEventListener('click', () => { pageNo--; drawBody(); });
        const px = $('#pg-next', body);
        if (px) px.addEventListener('click', () => { pageNo++; drawBody(); });
        bindMailActions(body);
        bindRowMenus(body);
      } else {
        const res = await LS.api.listDocuments({ q: state.q, label: state.label });
        body.innerHTML = '<div class="kanban">' + KANBAN_COLS.map((col) => {
          const items = res.items.filter((d) => col.statuses.includes(d.status));
          const total = col.key === 'COMPLETED' ? Math.max(items.length, 325) : items.length;
          return (
            '<div class="kanban-col" data-drop="' + col.drop + '"><div class="kanban-col-head">' + col.title +
            ' <span class="cnt">' + total.toLocaleString() + '건</span></div><div class="kanban-col-body">' +
            (items.slice(0, 12).map(kanbanCard).join('') || '<p class="dim" style="font-size:12px;padding:6px 4px">문서 없음</p>') +
            (items.length > 12 ? '<button class="btn ghost sm">더 보기 (' + (total - 12).toLocaleString() + '건) — 가상 스크롤 구간</button>' : '') +
            '</div></div>');
        }).join('') + '</div>';
        bindKanban(body);
        bindRowMenus(body);
      }
    }

    function kanbanCard(d) {
      const stale = d.status === 'PENDING_OTHERS' && staleDays(d) >= 3;
      return (
        '<div class="kcard' + (stale ? ' stale' : '') + '" draggable="true" data-id="' + d.id + '">' +
        '<div class="top">' + (d.urgent ? '<span class="badge red">⚠️ 긴급</span>' : d.label ? '<span class="badge brand">' + esc(d.label) + '</span>' : '<span class="badge gray">라벨 없음</span>') +
        '<button class="menu-btn" data-menu="' + d.id + '" aria-label="문서 메뉴">' + icons.dots + '</button></div>' +
        '<div class="t">' + esc(d.title) + '</div>' +
        '<div class="who">' + icons.user + ' ' + esc(d.signers.map((s) => s.name).join(', ') || '서명자 미지정') + '</div>' +
        '<div class="foot"><span>' + icons.clock + ' ' + relTime(d.lastActivityAt) + '</span>' +
        (stale ? '<span class="badge red">⏳ 리마인드 필요</span>' : d.status === 'COMPLETED' ? '<span class="badge gold">' + icons.diamond + ' 해시 증명</span>' : '') +
        '</div></div>');
    }

    // 칸반 DnD: Optimistic UI — 화면 먼저 이동, 서버 PATCH는 후행. 실패 시 롤백.
    function bindKanban(root) {
      let dragged = null;
      $$('.kcard', root).forEach((card) => {
        card.addEventListener('dragstart', () => { dragged = card; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); });
      });
      $$('.kanban-col', root).forEach((col) => {
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
        col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
        col.addEventListener('drop', async (e) => {
          e.preventDefault();
          col.classList.remove('drag-over');
          if (!dragged) return;
          const id = dragged.dataset.id;
          const target = col.dataset.drop;
          const from = dragged.parentElement;
          col.querySelector('.kanban-col-body').prepend(dragged); // Optimistic move
          if (target === 'PENDING_OTHERS') {
            openSendConfirm(id, () => { from.prepend(dragged); });
          } else {
            const prevStatus = (await LS.api.getDocument(id)).status;
            try {
              await LS.api.updateDocumentStatus(id, target);
              toast('상태를 「' + STATUS[target].label + '」(으)로 변경했습니다.', {
                action: {
                  label: '실행취소',
                  onClick: async () => {
                    await LS.api.updateDocumentStatus(id, prevStatus);
                    from.prepend(dragged);
                    toast('↩️ 이동을 취소했습니다.');
                  },
                },
              });
            } catch (err) {
              from.prepend(dragged); // 롤백
              toast('⚠️ 상태 변경 실패 — 원위치로 복구했습니다.');
            }
          }
        });
      });
    }

    function openSendConfirm(id, rollback) {
      const m = openModal(
        '<div class="modal-head"><h3>' + icons.send + ' 서명 요청을 발송할까요?</h3><button class="modal-close">×</button></div>' +
        '<div class="modal-body"><p class="muted">카드를 「상대 서명 대기」로 이동하면 지정된 서명자에게 카카오톡·이메일로 서명 요청이 즉시 발송됩니다.</p>' +
        '<div class="toolbar-row" style="margin-top:16px;justify-content:flex-end"><button class="btn" id="send-cancel">취소</button>' +
        '<button class="btn primary" id="send-ok">' + icons.send + ' 발송하기</button></div></div>');
      $('#send-cancel', m).addEventListener('click', () => { rollback(); closeModal(); });
      $('#send-ok', m).addEventListener('click', async () => {
        await LS.api.updateDocumentStatus(id, 'PENDING_OTHERS');
        closeModal();
        toast('🚀 서명 요청을 발송했습니다.');
      });
    }

    function bindRowMenus(root) {
      $$('[data-menu]', root).forEach((b) =>
        b.addEventListener('click', (e) => { e.stopPropagation(); openHistoryModal(b.dataset.menu); }));
      $$('tr[data-id]', root).forEach((tr) => tr.addEventListener('click', () => openHistoryModal(tr.dataset.id)));
    }

    await drawBody();
  });

  // ── 문서 이력 & 무결성 검증 모달 ─────────────────────────────────
  const AUDIT_DOT = { ISSUED: '🟢', VIEWED: '🟡', SIGNED: '🔵', LOCKED: '🟣', REMIND: '🔔', STATUS: '⚙️', NOTIFY: '✉️' };
  async function openHistoryModal(id) {
    const d = await LS.api.getDocument(id);
    openModal(
      '<div class="modal-head"><h3>문서 진행 이력 · 무결성 검증</h3><button class="modal-close">×</button></div>' +
      '<div class="modal-body">' +
      '<p style="font-weight:800">' + esc(d.title) + '</p>' +
      '<div style="margin:6px 0 14px">' + statusBadge(d.status) + (d.label ? ' <span class="badge brand">' + esc(d.label) + '</span>' : '') + '</div>' +
      (d.hash
        ? '<label class="field-label">🔒 문서 고유 해시 (SHA-256)</label><code class="hash-chip">' + d.hash + '</code>'
        : '<p class="dim" style="font-size:12.5px">해시는 모든 서명 완료 후 문서 잠금 시점에 생성·등록됩니다.</p>') +
      '<label class="field-label" style="margin-top:16px">진행 타임라인 (Audit Trail)</label>' +
      '<ul class="timeline">' + d.audit.map((a) =>
        '<li><span class="when">' + LS.ui.fmtDateTime(a.at) + '</span><span>' + (AUDIT_DOT[a.type] || '·') + ' <b>' + esc(a.detail) + '</b>' +
        '<span class="dim"> — ' + esc(a.actor) + (a.ip !== '-' ? ' · IP ' + esc(a.ip) + ' · ' + esc(a.ua) : '') + '</span></span></li>').join('') + '</ul>' +
      '<div class="toolbar-row" style="margin-top:16px;justify-content:flex-end">' +
      (d.status === 'PENDING_OTHERS' ? '<button class="btn" id="hist-remind">' + icons.bell + ' 독촉 알림</button>' : '') +
      (d.hash ? '<button class="btn" id="hist-cert">' + icons.doc + ' 감사추적 인증서</button>' : '') +
      '<button class="btn primary">' + icons.download + ' 원본 PDF</button></div></div>',
      { wide: true }
    );
    const rm = $('#hist-remind');
    if (rm) rm.addEventListener('click', async () => { const r = await LS.api.remindSigners(id); toast('🔔 ' + r.sent + '명에게 독촉 알림 발송'); closeModal(); });
    const ct = $('#hist-cert');
    if (ct) ct.addEventListener('click', () => { closeModal(); nav('certificate', { id: d.id }); });
  }
  LS.openHistoryModal = openHistoryModal;

  // ── 메시지 발신 컴포즈 모달 (Gmail API · 카카오 알림톡) ──────────
  LS.openComposeModal = async function (id, channel) {
    const d = await LS.api.getDocument(id);
    let chan = channel || 'EMAIL';
    const targets = d.signers.filter((s) => s.status !== 'SIGNED');
    const recipients = (targets.length ? targets : d.signers).map((s) => s.name + ' <' + s.contact + '>');
    const acc = LS.senderAccounts;
    const defaultBody =
      '안녕하세요, ' + ((targets[0] || d.signers[0] || {}).name || '고객') + '님.\n' +
      '「' + d.title + '」 문서의 전자서명이 대기 중입니다.\n' +
      '아래 링크에서 내용을 확인하신 후 서명을 완료해 주세요. (기한: ' + d.expirationDays + '일)\n' +
      'https://sign.lawsign.example/d/' + d.id;

    const m = openModal(
      '<div class="modal-head"><h3>' + icons.send + ' 메시지 발신</h3><button class="modal-close">×</button></div>' +
      '<div class="modal-body">' +
      '<div class="toolbar-row" style="margin-bottom:14px">' +
      '<button class="btn chan-pill" data-chan="EMAIL">' + icons.mail + ' 이메일 (Gmail)</button>' +
      '<button class="btn chan-pill" data-chan="KAKAO">' + icons.chat + ' 카카오톡 알림톡</button></div>' +
      '<div style="display:grid;gap:12px">' +
      '<div><label class="field-label">받는 사람</label><div class="toolbar-row">' +
      recipients.map((r) => '<span class="badge brand">' + esc(r) + '</span>').join('') + '</div></div>' +
      '<div id="cmp-subject-row"><label class="field-label">제목</label>' +
      '<input class="input" id="cmp-subject" value="' + esc('[로싸인] 「' + d.title + '」 서명 요청 안내') + '"></div>' +
      '<div><label class="field-label">메시지</label><textarea class="input" id="cmp-body" rows="5">' + esc(defaultBody) + '</textarea></div>' +
      '<div class="dim" id="cmp-account" style="font-size:12px"></div></div>' +
      '<div class="toolbar-row" style="margin-top:16px;justify-content:flex-end">' +
      '<button class="btn" id="cmp-cancel">취소</button><button class="btn primary" id="cmp-send">' + icons.send + ' 발신하기</button></div></div>',
      { wide: true });

    function paint() {
      LS.ui.$$('.chan-pill', m).forEach((b) => b.classList.toggle('primary', b.dataset.chan === chan));
      LS.ui.$('#cmp-subject-row', m).style.display = chan === 'EMAIL' ? '' : 'none';
      LS.ui.$('#cmp-account', m).innerHTML = chan === 'EMAIL'
        ? '발신 계정: <b>' + acc.gmail.email + '</b> <span class="badge green">Gmail 연동됨</span> — Gmail API(users.messages.send) 경유'
        : '발신 프로필: <b>' + acc.kakao.profile + '</b> <span class="badge amber">알림톡 승인 템플릿</span> — 카카오 비즈메시지 경유';
    }
    LS.ui.$$('.chan-pill', m).forEach((b) => b.addEventListener('click', () => { chan = b.dataset.chan; paint(); }));
    LS.ui.$('#cmp-cancel', m).addEventListener('click', closeModal);
    LS.ui.$('#cmp-send', m).addEventListener('click', async () => {
      const btn = LS.ui.$('#cmp-send', m);
      btn.disabled = true;
      const res = await LS.api.sendNotification(id, {
        channel: chan,
        to: recipients,
        subject: chan === 'EMAIL' ? LS.ui.$('#cmp-subject', m).value : undefined,
        body: LS.ui.$('#cmp-body', m).value,
      });
      closeModal();
      toast((chan === 'EMAIL' ? '✉️ Gmail로 ' : '💬 카카오톡으로 ') + res.sent + '명에게 발신 완료 (ID: ' + res.messageId + ')');
    });
    paint();
  };

  // ══════════════════════════════════════════════════════════════════
  // 화면 3: 감사추적 인증서 (완료 PDF 마지막 페이지 병합본의 웹 미리보기)
  // ══════════════════════════════════════════════════════════════════
  LS.route('certificate', async (main, params) => {
    const d = await LS.api.getDocument(params.id);
    const tx = '0x' + (d.hash || '').slice(0, 40);
    main.innerHTML =
      '<div class="page" style="max-width:820px">' +
      '<div class="toolbar-row no-print" style="justify-content:space-between;margin-bottom:14px">' +
      '<button class="btn" onclick="history.back()">← 돌아가기</button>' +
      '<button class="btn primary" onclick="window.print()">🖨️ 인쇄 / PDF 저장</button></div>' +
      '<div class="cert">' +
      '<div class="cert-head"><div class="lnb-logo" style="padding:0"><span class="mark">L</span><span><span class="law">Law</span>Sign</span></div>' +
      '<div style="text-align:center"><div class="qr-box">' + qrSvg(d.hash || d.id) + '</div><small class="dim" style="font-size:10px">검증용 QR (스캔 시 원본 대조)</small></div></div>' +
      '<h2>전자서명 감사추적 인증서</h2><div class="sub-en">AUDIT TRAIL CERTIFICATE</div>' +

      '<div class="cert-sec"><h4>1. 문서 기본 정보 (Document Identity)</h4><dl>' +
      '<dt>문서 번호 (ID)</dt><dd class="mono">' + esc(d.id) + '</dd>' +
      '<dt>문서 제목</dt><dd><b>' + esc(d.title) + '</b></dd>' +
      '<dt>발행처 (Issuer)</dt><dd>' + esc(LS.workspace.name) + '</dd>' +
      '<dt>서명 기한</dt><dd>' + d.expirationDays + '일</dd>' +
      '<dt>문서 상태</dt><dd>✅ 모든 서명 완료 · 문서 잠금 적용됨</dd></dl></div>' +

      '<div class="cert-sec"><h4>2. 무결성 검증 정보 (Integrity &amp; Security)</h4><dl>' +
      '<dt>파일 해시<br><small class="dim">SHA-256</small></dt><dd><code class="hash-chip">' + (d.hash || '-') + '</code></dd>' +
      '<dt>블록체인 TXID</dt><dd><code class="hash-chip">' + tx + '</code><small class="dim">Private Ledger Network 기록 · 블록 탐색기에서 독립 확인 가능</small></dd></dl></div>' +

      '<div class="cert-sec"><h4>3. 서명 진행 이력 (Audit Trail Logs)</h4>' +
      '<ul class="timeline">' + d.audit.map((a) =>
        '<li><span class="when">' + LS.ui.fmtDateTime(a.at) + '</span><span>' + (AUDIT_DOT[a.type] || '·') + ' <b>' + esc(a.detail) + '</b>' +
        '<span class="dim"> — ' + esc(a.actor) + (a.ip !== '-' ? ' · IP ' + esc(a.ip) + ' · ' + esc(a.ua) : '') + '</span></span></li>').join('') + '</ul></div>' +

      '<div class="cert-foot"><span>본 인증서는 로싸인(LawSign) 시스템에 의해 전자서명법 및 관련 법령에 의거하여 기록·발급되었습니다.<br>우측 상단 QR 코드를 스캔하면 위변조 여부와 원본을 즉시 확인할 수 있습니다.</span>' +
      '<span>발급일시: ' + LS.ui.fmtDateTime(Date.now()) + '<br>LawSign Trust Service</span></div>' +
      '</div></div>';
  });

  // ══════════════════════════════════════════════════════════════════
  // 화면 4: 원본 검증 포털 (Zero-Knowledge — 파일은 서버로 전송하지 않음)
  // ══════════════════════════════════════════════════════════════════
  LS.route('validator', async (main) => {
    main.innerHTML =
      '<div class="page">' +
      '<div class="validator-hero"><div class="shield">' + icons.shield.replace('width="16" height="16"', 'width="28" height="28"') + '</div>' +
      '<h1>LawSign 원본 검증 포털</h1>' +
      '<p class="muted" style="max-width:560px;margin:8px auto 0">문서 파일을 올리면 <b>브라우저 안에서만</b> SHA-256 해시를 계산해 발행 원장과 대조합니다.<br>' +
      '원본 파일은 <b>절대 서버로 전송되지 않으며</b>, 해시 문자열 하나만 대조됩니다 (Zero-Knowledge 검증).</p></div>' +
      '<div class="dropzone" id="vz" role="button" tabindex="0">' +
      '<div style="font-size:30px;margin-bottom:8px">📄</div><b>검증할 문서를 여기에 끌어다 놓거나 클릭하여 선택</b>' +
      '<p class="dim" style="margin-top:6px;font-size:12.5px">PDF · 이미지 · 모든 파일 형식 지원</p></div>' +
      '<input type="file" id="vz-file" hidden>' +
      '<div class="toolbar-row no-print" style="justify-content:center;margin-top:14px">' +
      '<button class="btn sm" id="demo-ok">✅ 정품 샘플 파일 내려받기</button>' +
      '<button class="btn sm" id="demo-bad">🚨 변조 샘플 파일 내려받기</button></div>' +
      '<div id="vz-result"></div></div>';

    const dz = $('#vz');
    const fileInput = $('#vz-file');
    dz.addEventListener('click', () => fileInput.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) verify(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => fileInput.files[0] && verify(fileInput.files[0]));

    const demo = LS.api.getDemoFile();
    const dl = (name, content) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    $('#demo-ok').addEventListener('click', () => dl(demo.name, demo.content));
    $('#demo-bad').addEventListener('click', () => dl('변조된_' + demo.name, demo.content + ' ')); // 1바이트 변조

    async function verify(file) {
      const out = $('#vz-result');
      out.innerHTML = '<p class="dim" style="text-align:center;margin-top:16px">브라우저에서 해시 계산 중… (Web Crypto API)</p>';
      if (!window.crypto || !crypto.subtle) {
        out.innerHTML = '<div class="verify-result bad"><h3>' + icons.warn + ' 이 브라우저에서는 Web Crypto API를 사용할 수 없습니다</h3></div>';
        return;
      }
      const hex = await LS.api.sha256Hex(await file.arrayBuffer());
      const res = await LS.api.verifyHash(hex);
      if (res.valid) {
        const r = res.record;
        out.innerHTML =
          '<div class="verify-result ok"><h3>' + icons.check + ' 위변조되지 않은 원본 문서입니다</h3><dl>' +
          '<dt>문서 제목</dt><dd><b>' + esc(r.title) + '</b></dd>' +
          '<dt>발행처</dt><dd>' + esc(r.issuer) + ' <span class="badge gold">' + icons.diamond + ' 블록체인 증명됨</span></dd>' +
          '<dt>완료 일시</dt><dd>' + LS.ui.fmtDateTime(r.completedAt || Date.now()) + '</dd>' +
          '<dt>파일 해시</dt><dd class="mono">' + hex + '</dd>' +
          '<dt>원장 TXID</dt><dd class="mono">' + esc(r.txId) + '</dd></dl></div>';
      } else {
        out.innerHTML =
          '<div class="verify-result bad"><h3>' + icons.warn + ' 문서가 변조되었거나 등록되지 않은 파일입니다</h3>' +
          '<p class="muted" style="margin-top:8px;font-size:13px">단 1바이트만 수정되어도 해시가 완전히 달라집니다. 발행처에 원본 재발급을 요청하세요.</p>' +
          '<dl><dt>계산된 해시</dt><dd class="mono">' + hex + '</dd><dt>원장 대조</dt><dd>일치 항목 없음</dd></dl></div>';
      }
    }
  });

  // ── 앱 셸 부트스트랩 ─────────────────────────────────────────────
  function boot() {
    const navItems = [
      { route: 'dashboard', label: '홈', ic: icons.home },
      { route: 'documents', label: '메일함', ic: icons.mail },
      { route: 'request', label: '서명 요청', ic: icons.pen },
      { route: 'validator', label: '검증 포털', ic: icons.shield },
    ];
    document.body.innerHTML =
      '<header class="top-appbar"><div class="lnb-logo"><span class="mark">L</span><span><span class="law">Law</span>Sign</span></div>' +
      '<div class="actions"><button class="icon-btn" id="appbar-theme" aria-label="테마 전환">' + icons.sun + '</button>' +
      '<button class="icon-btn" id="appbar-new" aria-label="새 서명 요청" style="color:var(--brand-600)">' + icons.pen + '</button>' +
      '<span class="avatar" style="width:27px;height:27px;font-size:11px">청</span></div></header>' +
      '<div class="app-shell">' +
      '<nav class="lnb"><div class="lnb-logo"><span class="mark">L</span><span><span class="law">Law</span>Sign</span></div>' +
      '<button class="lnb-cta" id="lnb-new">' + icons.pen + ' 새 서명 요청</button>' +
      '<div class="lnb-quota"><span>잔여 <b>1,836</b>건</span><span class="bar"><i style="width:28%"></i></span></div>' +
      navItems.map((n) => '<a class="lnb-item" data-route="' + n.route + '" href="#/' + n.route + '">' + n.ic + ' ' + n.label +
        (n.route === 'documents' ? '<span class="cnt">1</span>' : '') + '</a>').join('') +
      '<button class="lnb-item" id="theme-toggle">' + icons.sun + ' 테마 전환</button>' +
      '<div class="lnb-footer">LawSign v1.0 · 프론트엔드 프로토타입</div>' +
      '<div class="lnb-user"><span class="avatar">청</span><div><b>' + esc(LS.workspace.name) + '</b><small>Enterprise 플랜</small></div></div></nav>' +
      '<main class="main" id="app-main"></main></div>' +
      '<nav class="bottom-nav">' + navItems.map((n) => '<a data-route="' + n.route + '" href="#/' + n.route + '">' + n.ic + ' <span>' + n.label + '</span></a>').join('') + '</nav>' +
      '<div id="toast-root"></div>';

    $('#lnb-new').addEventListener('click', () => nav('request'));
    // 샌드박스 iframe 등 저장소 접근이 차단된 환경 대비
    const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } } };
    const saved = store.get('ls-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
    const flipTheme = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('ls-theme', next);
    };
    $('#theme-toggle').addEventListener('click', flipTheme);
    $('#appbar-theme').addEventListener('click', flipTheme);
    $('#appbar-new').addEventListener('click', () => nav('request'));
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.LS);
