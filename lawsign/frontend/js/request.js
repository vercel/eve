/**
 * 로싸인(LawSign) — 서명 요청 플로우 (SPA Seamless Stepper)
 * 1단계 서명자 지정(스마트 연락처 자동완성) → 2단계 필드 배치(자석 스냅 편집기)
 * → 3단계 설정 체크리스트 → 발송(백그라운드 큐)
 * 페이지 이동 없이 한 화면에서 단계를 오가며, 단계별 데이터는 draft 상태로 유지.
 */
(function (LS) {
  'use strict';
  const { esc, $, $$, debounce, toast, openModal, closeModal } = LS.ui;
  const icons = LS.icons;

  const TOOLS = [
    { type: 'SIGNATURE', label: '사인·도장', ic: icons.stamp, w: 21, h: 6 },
    { type: 'TEXT', label: '텍스트', ic: icons.text, w: 24, h: 5 },
    { type: 'CHECKBOX', label: '체크박스', ic: icons.checkbox, w: 8, h: 4.5 },
    { type: 'DATE', label: '서명한 날짜', ic: icons.calendar, w: 20, h: 5 },
    { type: 'IMAGE', label: '이미지', ic: icons.image, w: 22, h: 8 },
  ];
  // 문서 본문 텍스트 베이스라인(%) — 실서비스는 PDF.js 텍스트 레이어 좌표에서 추출
  const SNAP_LINES = [16, 22, 28, 34, 40, 46, 52, 58, 64, 70, 76, 84];
  const SNAP_THRESHOLD = 1.6; // %
  const PAGE_COUNT = 3;

  function newDraft() {
    return {
      step: 1,
      title: '',
      label: '',
      expirationDays: 14,
      lockOnComplete: true,
      sequential: false,
      scheduledAt: '',
      signers: [{ name: '', contact: '' }],
      fields: [], // { id, type, signerIdx, page, x, y, w, h }
      page: 1,
    };
  }
  let draft = newDraft();
  let fieldSeq = 0;

  LS.route('request', async (main, params) => {
    draft = newDraft();
    if (params.tpl) {
      const tpl = (await LS.api.listTemplates()).find((t) => t.id === params.tpl);
      if (tpl) {
        draft.title = tpl.title + '_' + new Date().toISOString().slice(2, 10).replace(/-/g, '');
        draft.label = tpl.title.split(' ')[0].replace(/\(.*/, '');
        // 템플릿에는 필드 좌표가 사전 세팅되어 있음 (대량전송 시 2단계 생략 근거)
        draft.fields = [
          { id: 'f' + ++fieldSeq, type: 'SIGNATURE', signerIdx: 0, page: 1, x: 62, y: 84, w: 21, h: 6 },
          { id: 'f' + ++fieldSeq, type: 'DATE', signerIdx: 0, page: 1, x: 14, y: 84, w: 20, h: 5 },
        ];
      }
    }
    renderFlow(main);
  });

  function renderFlow(main) {
    main.innerHTML =
      '<div class="page">' +
      '<div class="toolbar-row" style="justify-content:space-between;margin-bottom:14px"><h1 style="font-size:20px">' + icons.pen + ' 새 서명 요청</h1>' +
      '<span class="badge gray">임시저장됨 · ' + LS.ui.fmtDateTime(Date.now()) + '</span></div>' +
      '<div class="stepper" id="req-stepper"></div>' +
      '<div id="req-body"></div>' +
      '<div class="toolbar-row" style="justify-content:space-between;margin-top:18px">' +
      '<button class="btn" id="req-prev">← 이전 단계로</button>' +
      '<button class="btn primary" id="req-next">다음 단계로 →</button></div></div>';

    $('#req-prev').addEventListener('click', () => go(draft.step - 1));
    $('#req-next').addEventListener('click', () => {
      if (draft.step === 3) return submit();
      go(draft.step + 1);
    });
    drawStep(main);
  }

  function go(step) {
    if (step < 1 || step > 3) return;
    if (step > 1 && !draft.signers.some((s) => s.name && s.contact)) {
      toast('⚠️ 서명자 이름과 연락처를 1명 이상 입력하세요.');
      return;
    }
    draft.step = step;
    drawStep(document.getElementById('app-main'));
  }

  function drawStep(main) {
    const steps = ['서명자', '입력 (필드 배치)', '기타 설정'];
    $('#req-stepper').innerHTML = steps
      .map((s, i) => {
        const n = i + 1;
        const cls = n === draft.step ? 'active' : n < draft.step ? 'done' : '';
        return '<button class="step-pill ' + cls + '" data-step="' + n + '"><span class="n">' + (n < draft.step ? '✓' : n) + '</span>' + s + '</button>' +
          (n < 3 ? '<span class="step-arrow">›</span>' : '');
      })
      .join('');
    $$('#req-stepper .step-pill').forEach((b) => b.addEventListener('click', () => go(+b.dataset.step)));
    $('#req-prev').style.visibility = draft.step === 1 ? 'hidden' : 'visible';
    $('#req-next').innerHTML = draft.step === 3 ? icons.send + ' 설정 완료 · 서명 요청 발송' : '다음 단계로 →';

    const body = $('#req-body');
    if (draft.step === 1) drawSigners(body);
    else if (draft.step === 2) drawEditor(body);
    else drawSettings(body);
  }

  // ── 1단계: 서명자 (스마트 연락처 자동완성 + 디바운스 검증) ────────
  function drawSigners(body) {
    body.innerHTML =
      '<div class="request-layout">' +
      '<section class="card card-pad"><div class="section-title">' + icons.user + ' 서명 참여자</div>' +
      '<p class="dim" style="font-size:12.5px;margin:4px 0 10px">이메일·전화번호 일부만 입력해도 이전 연락처가 자동완성됩니다 (300ms 디바운스 서버 질의).</p>' +
      '<div id="signer-rows"></div>' +
      '<button class="btn" id="add-signer" style="margin-top:12px">' + icons.plus + ' 서명자 추가하기</button>' +
      '<label style="display:flex;align-items:center;gap:8px;margin-top:16px;font-size:13px;font-weight:600">' +
      '<input type="checkbox" id="seq-sign" ' + (draft.sequential ? 'checked' : '') + ' style="accent-color:var(--brand-600)"> 순서대로 한 명씩 서명 (서명 순서 지정)</label>' +
      '</section>' +
      '<aside class="card card-pad"><div class="section-title">서명 순서 미리보기</div><div id="order-preview" style="margin-top:10px"></div>' +
      '<p class="dim" style="font-size:12px;margin-top:12px">여러 이해관계자(법무법인·피의자·합의권자 등)가 얽힌 서명 순서를 플로우로 확인합니다.</p></aside></div>';

    $('#add-signer').addEventListener('click', () => { draft.signers.push({ name: '', contact: '' }); drawRows(); });
    $('#seq-sign').addEventListener('change', (e) => { draft.sequential = e.target.checked; drawOrder(); });

    function drawRows() {
      $('#signer-rows').innerHTML = draft.signers
        .map((s, i) =>
          '<div class="signer-row" data-i="' + i + '">' +
          '<span class="signer-order">' + (i + 1) + '</span>' +
          '<input class="input s-name" placeholder="이름 (예: 김영신)" value="' + esc(s.name) + '">' +
          '<input class="input s-contact" placeholder="이메일 또는 휴대폰 번호" value="' + esc(s.contact) + '" autocomplete="off">' +
          '<button class="btn ghost sm s-del" ' + (draft.signers.length === 1 ? 'disabled' : '') + '>' + icons.x + '</button>' +
          '<div class="ac-slot"></div></div>')
        .join('');

      $$('.signer-row').forEach((row) => {
        const i = +row.dataset.i;
        $('.s-name', row).addEventListener('input', (e) => { draft.signers[i].name = e.target.value; drawOrder(); });
        $('.s-del', row).addEventListener('click', () => { draft.signers.splice(i, 1); drawRows(); });
        const contactInput = $('.s-contact', row);
        const slot = $('.ac-slot', row);
        const query = debounce(async (q) => {
          if (!q || q.length < 2) { slot.innerHTML = ''; return; }
          const hits = await LS.api.searchContacts(q);
          slot.innerHTML = hits.length
            ? '<div class="autocomplete">' + hits.map((c, j) =>
                '<button data-j="' + j + '"><span><b>' + esc(c.name) + '</b> · ' + esc(c.email) + '</span><span class="dim">' + esc(c.phone) + '</span></button>').join('') + '</div>'
            : '';
          $$('.autocomplete button', slot).forEach((b) =>
            b.addEventListener('click', () => {
              const c = hits[+b.dataset.j];
              draft.signers[i] = { name: c.name, contact: c.email };
              drawRows();
              drawOrder();
            }));
        }, 300);
        contactInput.addEventListener('input', (e) => {
          draft.signers[i].contact = e.target.value;
          query(e.target.value.trim());
          // 프론트 유효성 검사: 이메일 or 010 휴대폰 형식
          const v = e.target.value.trim();
          const ok = !v || /@.+\./.test(v) || /^01[016789]-?\d{3,4}-?\d{4}$/.test(v);
          contactInput.style.borderColor = ok ? '' : 'var(--red-600)';
        });
        contactInput.addEventListener('blur', () => setTimeout(() => { slot.innerHTML = ''; }, 180));
      });
      drawOrder();
    }
    function drawOrder() {
      const names = draft.signers.map((s, i) => '<span class="badge ' + (i === 0 ? 'brand' : 'gray') + '">' + (i + 1) + '. ' + esc(s.name || '미입력') + '</span>');
      $('#order-preview').innerHTML = draft.sequential
        ? names.join(' <span class="dim">→</span> ')
        : names.join(' ') + '<div class="dim" style="font-size:12px;margin-top:8px">동시 발송 (순서 없음)</div>';
    }
    drawRows();
  }

  // ── 2단계: 문서 편집기 (Touch & Floating + 자석 스냅) ─────────────
  function drawEditor(body) {
    const validSigners = draft.signers.filter((s) => s.name);
    let activeSigner = 0;
    let selected = null;

    body.innerHTML =
      '<div class="editor-hint">' + icons.grid + ' 도구를 <b>클릭하면 화면 중앙에 필드가 생성</b>됩니다. 드래그 시 문서의 텍스트 베이스라인에 <b>자석 스냅</b>으로 정렬됩니다.</div>' +
      '<div class="editor-layout">' +
      '<div class="tool-palette">' +
      '<select class="input signer-select" id="ed-signer">' + validSigners.map((s, i) => '<option value="' + i + '">' + (i + 1) + ' · ' + esc(s.name) + '</option>').join('') + '</select>' +
      TOOLS.map((t) => '<button class="tool-btn" data-tool="' + t.type + '"><span class="ic">' + t.ic + '</span>' + t.label + '</button>').join('') +
      '<button class="tool-btn" id="copy-all-pages" title="선택한 필드를 모든 페이지 동일 위치에 복사"><span class="ic">' + icons.doc + '</span>모든 페이지에 복사</button>' +
      '</div>' +
      '<div class="doc-canvas-wrap"><div class="doc-page" id="doc-page">' + paperHtml() + '<div class="snap-guide" id="snap-guide" hidden></div><div id="field-layer"></div></div></div>' +
      '<div class="thumb-rail" id="thumb-rail">' +
      Array.from({ length: PAGE_COUNT }, (_, i) => '<div class="thumb ' + (draft.page === i + 1 ? 'active' : '') + '" data-p="' + (i + 1) + '">' + (i + 1) + ' 페이지<br><small class="fcount"></small></div>').join('') +
      '</div></div>';

    const page = $('#doc-page');
    const layer = $('#field-layer');
    const guide = $('#snap-guide');

    $('#ed-signer').addEventListener('change', (e) => { activeSigner = +e.target.value; });
    $$('.tool-btn[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = TOOLS.find((x) => x.type === b.dataset.tool);
        // Touch & Floating: 화면 중앙에 즉시 생성(Spawn) — 모바일 드래그 유실 방지
        const f = { id: 'f' + ++fieldSeq, type: t.type, signerIdx: activeSigner, page: draft.page, x: 50 - t.w / 2, y: 47, w: t.w, h: t.h };
        draft.fields.push(f);
        selected = f.id;
        drawFields();
      })
    );
    $('#copy-all-pages').addEventListener('click', () => {
      const src = draft.fields.find((f) => f.id === selected);
      if (!src) { toast('복사할 필드를 먼저 선택하세요.'); return; }
      for (let p = 1; p <= PAGE_COUNT; p++) {
        if (p === src.page) continue;
        draft.fields.push(Object.assign({}, src, { id: 'f' + ++fieldSeq, page: p }));
      }
      toast('📄 ' + (PAGE_COUNT - 1) + '개 페이지의 동일 위치에 복사했습니다.');
      drawFields();
    });
    $$('.thumb').forEach((th) =>
      th.addEventListener('click', () => {
        draft.page = +th.dataset.p;
        $$('.thumb').forEach((x) => x.classList.toggle('active', x === th));
        drawFields();
      })
    );

    function toolMeta(type) { return TOOLS.find((t) => t.type === type); }

    function drawFields() {
      layer.innerHTML = draft.fields
        .filter((f) => f.page === draft.page)
        .map((f) => {
          const m = toolMeta(f.type);
          const s = validSigners[f.signerIdx] || { name: '?' };
          return (
            '<div class="field-block field-c' + (f.signerIdx % 3) + (selected === f.id ? ' selected' : '') + '" data-fid="' + f.id + '"' +
            ' style="left:' + f.x + '%;top:' + f.y + '%;width:' + f.w + '%;height:' + f.h + '%">' +
            m.ic + ' ' + esc(s.name) + ' · ' + m.label +
            '<button class="del" data-del="' + f.id + '" aria-label="삭제">✕</button></div>');
        })
        .join('');
      $$('.thumb', $('#thumb-rail')).forEach((th) => {
        const n = draft.fields.filter((f) => f.page === +th.dataset.p).length;
        $('.fcount', th).textContent = n ? '필드 ' + n : '';
      });
      bindDrag();
    }

    // Pointer Events 기반 DnD — 마우스·터치·펜 공통 처리, %(상대 좌표)로 저장
    function bindDrag() {
      $$('.field-block', layer).forEach((el) => {
        el.addEventListener('pointerdown', (e) => {
          if (e.target.closest('.del')) return;
          e.preventDefault();
          const fid = el.dataset.fid;
          selected = fid;
          $$('.field-block', layer).forEach((x) => x.classList.toggle('selected', x === el));
          const f = draft.fields.find((x) => x.id === fid);
          const rect = page.getBoundingClientRect();
          const startX = e.clientX, startY = e.clientY, ox = f.x, oy = f.y;
          el.setPointerCapture(e.pointerId);

          const move = (ev) => {
            let nx = ox + ((ev.clientX - startX) / rect.width) * 100;
            let ny = oy + ((ev.clientY - startY) / rect.height) * 100;
            nx = Math.max(0, Math.min(100 - f.w, nx));
            ny = Math.max(0, Math.min(100 - f.h, ny));
            // 자석 스냅: 필드 하단을 텍스트 베이스라인에 정렬
            let snapped = null;
            for (const line of SNAP_LINES) {
              if (Math.abs(ny + f.h - line) < SNAP_THRESHOLD) { ny = line - f.h; snapped = line; break; }
            }
            guide.hidden = snapped == null;
            if (snapped != null) guide.style.top = snapped + '%';
            f.x = Math.round(nx * 10) / 10;
            f.y = Math.round(ny * 10) / 10;
            el.style.left = f.x + '%';
            el.style.top = f.y + '%';
          };
          const up = () => {
            guide.hidden = true;
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            // 실서비스: 이 시점에 디바운스된 PUT /documents/{id} 자동 저장 1회 발생
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        });
      });
      $$('[data-del]', layer).forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          draft.fields = draft.fields.filter((f) => f.id !== b.dataset.del);
          if (selected === b.dataset.del) selected = null;
          drawFields();
        })
      );
    }

    drawFields();
  }

  function paperHtml() {
    return (
      '<div class="paper"><h4>합 의 서</h4>' +
      '<div class="clause"><b>제1조 (합의 내용)</b><br>가해자와 피해자는 본 사건에 관하여 상호 원만히 합의하였으며, 피해자는 가해자의 처벌을 원하지 아니한다.</div>' +
      '<div class="clause"><b>제2조 (합의금 지급)</b><br>가해자는 피해자에게 합의금을 지급하며, 지급이 완료된 때에 본 합의의 효력이 발생한다.</div>' +
      '<div class="clause"><b>제3조 (권리 포기)</b><br>피해자는 본 사건과 관련하여 향후 민·형사상 일체의 이의를 제기하지 아니한다.</div>' +
      '<div class="clause"><b>제4조 (관할 법원)</b><br>본 합의와 관련한 분쟁은 서울중앙지방법원을 제1심 관할 법원으로 한다.</div>' +
      '<div class="sig-line"><span>위임인 (갑) : ___________ (인)</span><span>수임인 (을) : ___________ (인)</span></div></div>'
    );
  }

  // ── 3단계: 기타 설정 (우측 고정 체크리스트로 입력 누락 방지) ──────
  function drawSettings(body) {
    body.innerHTML =
      '<div class="request-layout">' +
      '<section class="card card-pad"><div class="section-title">' + icons.doc + ' 문서 정보</div>' +
      '<div style="display:grid;gap:14px;margin-top:14px">' +
      '<div><label class="field-label">문서 제목 *</label><input class="input" id="set-title" placeholder="예: 260707 합의서(김영신)_피해자" value="' + esc(draft.title) + '"></div>' +
      '<div class="toolbar-row"><div style="flex:1"><label class="field-label">라벨</label><select class="input" id="set-label"><option value="">선택 안 함</option>' +
      LS.labels.map((l) => '<option ' + (draft.label === l ? 'selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>' +
      '<div style="flex:1"><label class="field-label">서명 기한</label><select class="input" id="set-exp">' +
      [7, 14, 30].map((d) => '<option value="' + d + '" ' + (draft.expirationDays === d ? 'selected' : '') + '>' + d + '일</option>').join('') + '</select></div></div>' +
      '<div><label class="field-label">예약 발송 (선택)</label><input class="input" id="set-sched" type="datetime-local" value="' + esc(draft.scheduledAt) + '"></div>' +
      '</div></section>' +

      '<aside class="card card-pad"><div class="section-title">' + icons.checkbox + ' 발송 전 체크리스트</div>' +
      '<p class="dim" style="font-size:12px;margin:4px 0 6px">놓치기 쉬운 설정을 시스템이 검사합니다.</p>' +
      '<ul class="checklist">' +
      '<li><input type="checkbox" checked disabled><span>서명자 <b>' + draft.signers.filter((s) => s.name).length + '명</b> 지정 완료</span></li>' +
      '<li><input type="checkbox" ' + (draft.fields.length ? 'checked' : '') + ' disabled><span>서명 필드 <b>' + draft.fields.length + '개</b> 배치 ' + (draft.fields.length ? '완료' : '<span style="color:var(--red-600)">— 2단계에서 배치 필요</span>') + '</span></li>' +
      '<li><input type="checkbox" id="chk-lock" ' + (draft.lockOnComplete ? 'checked' : '') + '><span><b>완료 문서 잠금</b> — 체결 즉시 해시 등록·수정 차단</span></li>' +
      '<li><input type="checkbox" id="chk-cc"><span>외부 참조자(CC)에게 완료본 공유</span></li>' +
      '</ul></aside></div>';

    $('#set-title').addEventListener('input', (e) => { draft.title = e.target.value; });
    $('#set-label').addEventListener('change', (e) => { draft.label = e.target.value; });
    $('#set-exp').addEventListener('change', (e) => { draft.expirationDays = +e.target.value; });
    $('#set-sched').addEventListener('change', (e) => { draft.scheduledAt = e.target.value; });
    $('#chk-lock').addEventListener('change', (e) => { draft.lockOnComplete = e.target.checked; });
  }

  // ── 발송: Optimistic UI + 백그라운드 진행 표시 ────────────────────
  async function submit() {
    if (!draft.title.trim()) { toast('⚠️ 문서 제목을 입력하세요.'); return; }
    if (!draft.fields.length) { toast('⚠️ 2단계에서 서명 필드를 1개 이상 배치하세요.'); go(2); return; }

    const payload = {
      title: draft.title.trim(),
      label: draft.label,
      expirationDays: draft.expirationDays,
      scheduledAt: draft.scheduledAt || null,
      signers: draft.signers.filter((s) => s.name && s.contact),
      fields: draft.fields,
    };
    // 즉시 문서함으로 전환하고 발송은 백그라운드 진행 (멀티태스킹 보장)
    LS.nav('documents', { view: 'kanban' });
    const box = document.createElement('div');
    box.className = 'bg-progress card card-pad';
    box.innerHTML = '<b style="font-size:13px">🚀 서명 요청 발송 중…</b><div class="dim" style="font-size:12px">' + esc(payload.title) + '</div><div class="bar"><i style="width:15%"></i></div>';
    document.body.appendChild(box);
    const bar = box.querySelector('.bar i');
    const timer = setInterval(() => { bar.style.width = Math.min(90, parseFloat(bar.style.width) + 22) + '%'; }, 180);

    try {
      const res = await LS.api.sendDocument(payload);
      clearInterval(timer);
      bar.style.width = '100%';
      setTimeout(() => box.remove(), 900);
      toast('✅ ' + res.queuedNotifications + '명에게 서명 요청을 발송했습니다 (카카오톡·이메일).');
      LS.nav('documents', { view: 'kanban', _r: String(Date.now() % 1e7) }); // 목록 갱신
    } catch (e) {
      clearInterval(timer);
      box.remove();
      toast('⚠️ 발송에 실패했습니다. 임시저장본에서 다시 시도하세요.');
    }
  }
})(window.LS);
