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

  // 벤치마크 도구 세트: 기본(사인·도장/텍스트/체크박스/서명한 날짜/날짜/드롭다운/이미지/첨부파일 요청)
  // + 자동 입력(서명 시점에 시스템이 값을 채우는 필드)
  const TOOLS = [
    { type: 'SIGNATURE', label: '사인·도장', ic: icons.stamp, w: 21, h: 6, tab: 'basic' },
    { type: 'TEXT', label: '텍스트', ic: icons.text, w: 24, h: 5, tab: 'basic' },
    { type: 'CHECKBOX', label: '체크박스', ic: icons.checkbox, w: 8, h: 4.5, tab: 'basic' },
    { type: 'SIGNED_DATE', label: '서명한 날짜', ic: icons.calendar, w: 20, h: 5, tab: 'basic' },
    { type: 'DATE', label: '날짜', ic: icons.calendar, w: 20, h: 5, tab: 'basic' },
    { type: 'DROPDOWN', label: '드롭다운', ic: icons.rows, w: 22, h: 5, tab: 'basic' },
    { type: 'IMAGE', label: '이미지', ic: icons.image, w: 22, h: 8, tab: 'basic' },
    { type: 'FILE_REQ', label: '첨부파일 요청', ic: icons.doc, w: 24, h: 5, tab: 'basic' },
    { type: 'AUTO_NAME', label: '서명자 이름 (자동)', ic: icons.user, w: 22, h: 5, tab: 'auto' },
    { type: 'AUTO_DATE', label: '서명 일시 (자동)', ic: icons.clock, w: 22, h: 5, tab: 'auto' },
    { type: 'AUTO_ORG', label: '요청 조직명 (자동)', ic: icons.home, w: 22, h: 5, tab: 'auto' },
  ];
  const CHANNELS = [
    { key: 'EMAIL', label: '이메일', ic: icons.mail, placeholder: '이메일 주소' },
    { key: 'KAKAO', label: '카카오톡', ic: icons.chat, placeholder: '휴대폰 번호' },
    { key: 'IN_PERSON', label: '대면서명', ic: icons.user, placeholder: '식별용 연락처 (선택)' },
  ];
  // 문서 본문 텍스트 베이스라인(%) — 실서비스는 PDF.js 텍스트 레이어 좌표에서 추출
  const SNAP_LINES = [16, 22, 28, 34, 40, 46, 52, 58, 64, 70, 76, 84];
  const SNAP_THRESHOLD = 1.6; // %
  const PAGE_COUNT = 3;

  function newDraft() {
    return {
      method: null, // SINGLE | BULK | LINK — 벤치마크 '요청 방식' 선택
      uploaded: false,
      requestType: 'SIGN', // SIGN(계약 서명 요청) | VIEW(문서 열람 요청)
      step: 1,
      title: '',
      label: '',
      expirationDays: 14,
      lockOnComplete: true,
      sequential: true,
      scheduledAt: '',
      signers: [{ name: '', contact: '', channel: 'EMAIL' }],
      fields: [], // { id, type, signerIdx, page, x, y, w, h }
      page: 1,
      attachments: [],
      ccList: [],
      reminderRule: '',
      note: '',
      authMethod: '',
    };
  }
  let draft = newDraft();
  let fieldSeq = 0;

  function applyTemplate(tpl) {
    draft.title = tpl.title + '_' + new Date().toISOString().slice(2, 10).replace(/-/g, '');
    draft.label = tpl.title.split(' ')[0].replace(/\(.*/, '');
    // 템플릿에는 필드 좌표가 사전 세팅되어 있음 (대량전송 시 2단계 생략 근거)
    draft.fields = [
      { id: 'f' + ++fieldSeq, type: 'SIGNATURE', signerIdx: 0, page: 1, x: 62, y: 84, w: 21, h: 6 },
      { id: 'f' + ++fieldSeq, type: 'SIGNED_DATE', signerIdx: 0, page: 1, x: 14, y: 84, w: 20, h: 5 },
    ];
    draft.uploaded = true;
  }

  LS.route('request', async (main, params) => {
    draft = newDraft();
    if (params.tpl) {
      const tpl = (await LS.api.listTemplates()).find((t) => t.id === params.tpl);
      if (tpl) {
        draft.method = 'SINGLE';
        applyTemplate(tpl);
      }
    }
    renderFlow(main);
  });

  function renderFlow(main) {
    if (!draft.method) return renderMethod(main);
    if (draft.method === 'BULK') return renderBulk(main);
    if (draft.method === 'LINK') return renderLink(main);
    if (!draft.uploaded) return renderUpload(main);
    renderStepper(main);
  }

  // ── 방식 선택: 기본(단건) / 고급(대량전송·링크서명) ────────────────
  function renderMethod(main) {
    const card = (method, ic, title, desc) =>
      '<button class="method-card" data-m="' + method + '"><span class="ic">' + ic + '</span><span><b>' + title + '</b><small>' + desc + '</small></span></button>';
    main.innerHTML =
      '<div class="page" style="max-width:760px">' +
      '<h1 style="font-size:20px;margin-bottom:4px">' + esc(LS.workspace.name) + ' 님,</h1>' +
      '<p class="muted" style="margin-bottom:18px">어떤 방식으로 서명을 요청할까요?</p>' +
      '<div class="card card-pad" style="margin-bottom:14px"><div class="section-title">기본</div><div class="method-grid">' +
      card('SINGLE', icons.pen, '단건 요청', '한 문서에 서명자를 1명 또는 여러 명으로 지정해서 요청해요.') + '</div></div>' +
      '<div class="card card-pad"><div class="section-title">고급</div><div class="method-grid">' +
      card('BULK', icons.send, '대량전송', '동일 양식의 문서를 지정된 다수에게 일괄 요청해요.') +
      card('LINK', icons.link, '링크서명', '서명자를 미리 지정하지 않고, 링크로 서명을 받아요.') + '</div></div></div>';
    $$('.method-card', main).forEach((b) =>
      b.addEventListener('click', () => { draft.method = b.dataset.m; renderFlow(main); }));
  }

  // ── 문서 업로드 / 준비된 템플릿으로 시작 ──────────────────────────
  async function renderUpload(main) {
    const tpls = await LS.api.listTemplates();
    main.innerHTML =
      '<div class="page" style="max-width:820px">' +
      '<button class="btn sm" id="up-back" style="margin-bottom:14px">‹ 이전</button>' +
      '<div class="card card-pad"><div class="section-title">' + icons.upload + ' 문서 업로드</div>' +
      '<div class="dropzone" id="up-zone" style="margin-top:14px;padding:34px 20px">' +
      '<b>전송할 문서를 드래그 앤 드롭 또는 버튼 눌러 업로드</b>' +
      '<div style="margin-top:10px"><span class="btn sm">＋ 문서 추가</span></div></div>' +
      '<input type="file" id="up-file" hidden accept=".pdf,.hwp,.hwpx,.docx,.xlsx,.pptx,.jpg,.png">' +
      '<p class="dim" style="font-size:12px;margin-top:10px">· PDF: 최대 10MB<br>· HWP, HWPX, DOCX, XLSX, PPTX, JPG, PNG: 최대 5MB</p></div>' +
      '<div class="card card-pad" style="margin-top:14px"><div class="section-title">준비된 템플릿으로 시작</div>' +
      '<p class="dim" style="font-size:12.5px;margin:4px 0 10px">계약서, 통지서 등 다양한 문서 템플릿이 준비되어 있습니다. 필드 좌표가 사전 세팅되어 2단계를 건너뛸 수 있습니다.</p>' +
      '<div class="tpl-grid">' + tpls.map((t) =>
        '<button class="tpl-card" data-tpl="' + t.id + '"><span class="ic">' + icons.doc + '</span><b>' + esc(t.title) + '</b>' +
        '<span class="dim" style="font-size:11.5px">필드 ' + t.fields + '개 · ' + t.usedCount + '회 사용</span></button>').join('') + '</div></div></div>';
    $('#up-back').addEventListener('click', () => { draft.method = null; renderFlow(main); });
    const zone = $('#up-zone');
    const file = $('#up-file');
    const accept = (name) => {
      draft.uploaded = true;
      draft.title = draft.title || String(name || '').replace(/\.[^.]+$/, '');
      LS.ui.toast('📄 문서 업로드 완료 — 서명자 지정으로 이동합니다.');
      renderFlow(main);
    };
    zone.addEventListener('click', () => file.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); accept(e.dataTransfer.files[0] && e.dataTransfer.files[0].name); });
    file.addEventListener('change', () => accept(file.files[0] && file.files[0].name));
    $$('[data-tpl]', main).forEach(async (b) =>
      b.addEventListener('click', async () => {
        const tpl = (await LS.api.listTemplates()).find((t) => t.id === b.dataset.tpl);
        applyTemplate(tpl);
        renderFlow(main);
      }));
  }

  // ── 대량전송: 템플릿 + 수신자 명단 일괄 발송 ──────────────────────
  async function renderBulk(main) {
    const tpls = await LS.api.listTemplates();
    main.innerHTML =
      '<div class="page" style="max-width:760px">' +
      '<button class="btn sm" id="bk-back" style="margin-bottom:14px">‹ 요청 방식으로</button>' +
      '<div class="card card-pad"><div class="section-title">' + icons.send + ' 대량전송</div>' +
      '<p class="dim" style="font-size:12.5px;margin:4px 0 14px">동일 양식(템플릿)의 문서를 다수에게 일괄 요청합니다. 필드가 사전 세팅된 템플릿을 사용하므로 편집 단계가 생략됩니다.</p>' +
      '<div style="display:grid;gap:14px">' +
      '<div><label class="field-label">양식 템플릿 *</label><select class="input" id="bk-tpl">' +
      tpls.map((t) => '<option value="' + t.id + '">' + esc(t.title) + ' (필드 ' + t.fields + '개)</option>').join('') + '</select></div>' +
      '<div><label class="field-label">수신자 명단 * — 한 줄에 「이름, 이메일 또는 휴대폰」</label>' +
      '<textarea class="input" id="bk-list" rows="6" placeholder="김동우, dongwoo.kim@example.com&#10;박예빈, 010-9876-5432"></textarea>' +
      '<p class="dim" style="font-size:12px;margin-top:6px">실서비스: 기기 주소록(Contact Picker API)·CSV 불러오기 지원, 발송은 메시지 큐에서 병렬 처리</p></div>' +
      '<div class="toolbar-row" style="justify-content:flex-end"><span class="dim" id="bk-count" style="font-size:12px"></span>' +
      '<button class="btn primary" id="bk-send">' + icons.send + ' 일괄 발송</button></div></div></div></div>';
    $('#bk-back').addEventListener('click', () => { draft.method = null; renderFlow(main); });
    const parse = () => $('#bk-list').value.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((p) => p[0] && p[1]).map((p) => ({ name: p[0], contact: p[1] }));
    $('#bk-list').addEventListener('input', () => { $('#bk-count').textContent = '수신자 ' + parse().length + '명'; });
    $('#bk-send').addEventListener('click', async () => {
      const list = parse();
      if (!list.length) { LS.ui.toast('⚠️ 수신자를 1명 이상 입력하세요.'); return; }
      const tpl = tpls.find((t) => t.id === $('#bk-tpl').value);
      $('#bk-send').disabled = true;
      for (const r of list.slice(0, 20)) {
        await LS.api.sendDocument({ title: tpl.title + '(' + r.name + ')_일괄', label: draft.label || tpl.title.split(' ')[0], expirationDays: 14, signers: [r], fields: [] });
      }
      LS.ui.toast('🚀 ' + list.length + '건의 대량 서명 요청을 백그라운드 큐에 적재했습니다.');
      LS.nav('documents', { view: 'kanban' });
    });
  }

  // ── 링크서명: 서명자 미지정, 링크로 수집 ──────────────────────────
  async function renderLink(main) {
    const tpls = await LS.api.listTemplates();
    main.innerHTML =
      '<div class="page" style="max-width:640px">' +
      '<button class="btn sm" id="lk-back" style="margin-bottom:14px">‹ 요청 방식으로</button>' +
      '<div class="card card-pad"><div class="section-title">' + icons.link + ' 링크서명</div>' +
      '<p class="dim" style="font-size:12.5px;margin:4px 0 14px">서명자를 미리 지정하지 않고, 링크에 접속한 누구나 본인 인증 후 서명하도록 합니다.</p>' +
      '<div style="display:grid;gap:14px">' +
      '<div><label class="field-label">양식 템플릿 *</label><select class="input" id="lk-tpl">' +
      tpls.map((t) => '<option value="' + t.id + '">' + esc(t.title) + '</option>').join('') + '</select></div>' +
      '<div class="toolbar-row" style="justify-content:flex-end"><button class="btn primary" id="lk-make">' + icons.link + ' 서명 링크 생성</button></div>' +
      '</div></div></div>';
    $('#lk-back').addEventListener('click', () => { draft.method = null; renderFlow(main); });
    $('#lk-make').addEventListener('click', async () => {
      const tpl = tpls.find((t) => t.id === $('#lk-tpl').value);
      const res = await LS.api.sendDocument({ title: tpl.title + '_링크서명', label: tpl.title.split(' ')[0], expirationDays: 14, signers: [{ name: '링크 서명자(미지정)', contact: 'link' }], fields: [] });
      const url = 'https://sign.lawsign.example/l/' + res.document.id;
      const m = LS.ui.openModal(
        '<div class="modal-head"><h3>' + icons.link + ' 서명 링크가 생성되었습니다</h3><button class="modal-close">×</button></div>' +
        '<div class="modal-body"><code class="hash-chip">' + url + '</code>' +
        '<div class="toolbar-row" style="margin-top:14px;justify-content:flex-end"><button class="btn primary" id="lk-copy">📋 링크 복사</button></div></div>');
      LS.ui.$('#lk-copy', m).addEventListener('click', () => {
        try { navigator.clipboard.writeText(url); } catch (e) { /* 클립보드 차단 환경 */ }
        LS.ui.toast('📋 링크를 복사했습니다.');
        LS.ui.closeModal();
        LS.nav('documents', { view: 'kanban' });
      });
    });
  }

  function renderStepper(main) {
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
    if (step > 1 && !draft.signers.some((s) => s.name && (s.contact || s.channel === 'IN_PERSON'))) {
      toast('⚠️ 서명자 이름과 연락처를 1명 이상 입력하세요. (대면서명은 연락처 생략 가능)');
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

  // ── 1단계: 서명자 (서명/열람 탭 · 순서 · 채널 · 자동완성) ─────────
  function drawSigners(body) {
    body.innerHTML =
      '<div class="request-layout">' +
      '<section class="card card-pad">' +
      '<div class="view-toggle" style="margin-bottom:14px">' +
      '<button data-rt="SIGN" class="' + (draft.requestType === 'SIGN' ? 'active' : '') + '">계약 서명 요청</button>' +
      '<button data-rt="VIEW" class="' + (draft.requestType === 'VIEW' ? 'active' : '') + '">문서 열람 요청</button></div>' +
      '<div class="toolbar-row" style="margin-bottom:10px;gap:16px">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600"><input type="radio" name="seq" value="1" ' + (draft.sequential ? 'checked' : '') + ' style="accent-color:var(--brand-600)"> 순서대로 한 명씩 서명</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600"><input type="radio" name="seq" value="" ' + (!draft.sequential ? 'checked' : '') + ' style="accent-color:var(--brand-600)"> 순서없이 서명</label></div>' +
      '<p class="dim" style="font-size:12.5px;margin:0 0 10px">이메일·전화번호 일부만 입력해도 이전 연락처가 자동완성됩니다 (300ms 디바운스 서버 질의).</p>' +
      '<div id="signer-rows"></div>' +
      '<button class="btn" id="add-signer" style="margin-top:12px;width:100%;justify-content:center;padding:14px">' + icons.plus + ' 서명자 추가하기 (<span id="signer-cnt"></span>/30)</button>' +
      '<div style="text-align:center;margin-top:10px"><button class="btn ghost sm" id="del-empty">빈 서명자 카드 모두 삭제</button></div>' +
      '</section>' +
      '<aside class="card card-pad"><div class="section-title">서명 순서 미리보기</div><div id="order-preview" style="margin-top:10px"></div>' +
      '<p class="dim" style="font-size:12px;margin-top:12px">여러 이해관계자(법무법인·피의자·합의권자 등)가 얽힌 서명 순서를 플로우로 확인합니다. ▲▼로 순서를 조정하세요. 알림 언어: 🌐 ko</p></aside></div>';

    $$('[data-rt]', body).forEach((b) => b.addEventListener('click', () => { draft.requestType = b.dataset.rt; drawSigners(body); }));
    $$('input[name="seq"]', body).forEach((r) => r.addEventListener('change', (e) => { draft.sequential = !!e.target.value; drawOrder(); }));
    $('#add-signer').addEventListener('click', () => {
      if (draft.signers.length >= 30) { toast('⚠️ 서명자는 최대 30명까지 지정할 수 있습니다.'); return; }
      draft.signers.push({ name: '', contact: '', channel: 'EMAIL' });
      drawRows();
    });
    $('#del-empty').addEventListener('click', () => {
      draft.signers = draft.signers.filter((s) => s.name || s.contact);
      if (!draft.signers.length) draft.signers.push({ name: '', contact: '', channel: 'EMAIL' });
      drawRows();
    });

    function drawRows() {
      $('#signer-cnt').textContent = draft.signers.length;
      $('#signer-rows').innerHTML = draft.signers
        .map((s, i) =>
          '<div class="signer-row" data-i="' + i + '">' +
          '<span class="signer-order">' + (i + 1) + '</span>' +
          '<input class="input s-name" placeholder="이름 (예: 김영신)" value="' + esc(s.name) + '">' +
          '<div class="toolbar-row" style="flex-wrap:nowrap;gap:6px">' +
          '<select class="input s-chan" style="width:auto;flex:none">' +
          CHANNELS.map((c) => '<option value="' + c.key + '" ' + (s.channel === c.key ? 'selected' : '') + '>' + c.label + '</option>').join('') + '</select>' +
          '<input class="input s-contact" placeholder="' + (CHANNELS.find((c) => c.key === s.channel) || CHANNELS[0]).placeholder + '" value="' + esc(s.contact) + '" autocomplete="off"></div>' +
          '<span style="display:flex;gap:2px">' +
          '<button class="btn ghost sm s-up" ' + (i === 0 ? 'disabled' : '') + ' title="위로">▲</button>' +
          '<button class="btn ghost sm s-down" ' + (i === draft.signers.length - 1 ? 'disabled' : '') + ' title="아래로">▼</button>' +
          '<button class="btn ghost sm s-del" ' + (draft.signers.length === 1 ? 'disabled' : '') + '>' + icons.x + '</button></span>' +
          '<div class="ac-slot"></div></div>')
        .join('');

      $$('.signer-row').forEach((row) => {
        const i = +row.dataset.i;
        $('.s-name', row).addEventListener('input', (e) => { draft.signers[i].name = e.target.value; drawOrder(); });
        $('.s-chan', row).addEventListener('change', (e) => { draft.signers[i].channel = e.target.value; drawRows(); });
        $('.s-up', row).addEventListener('click', () => { const t = draft.signers[i - 1]; draft.signers[i - 1] = draft.signers[i]; draft.signers[i] = t; drawRows(); drawOrder(); });
        $('.s-down', row).addEventListener('click', () => { const t = draft.signers[i + 1]; draft.signers[i + 1] = draft.signers[i]; draft.signers[i] = t; drawRows(); drawOrder(); });
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
      '<div class="view-toggle" style="width:100%;margin-bottom:2px"><button data-ttab="basic" class="active" style="flex:1">기본</button><button data-ttab="auto" style="flex:1">자동 입력</button></div>' +
      '<div id="tool-list" style="display:flex;flex-direction:column;gap:6px"></div>' +
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

    let toolTab = 'basic';
    function drawTools() {
      $('#tool-list').innerHTML = TOOLS.filter((t) => t.tab === toolTab)
        .map((t) => '<button class="tool-btn" data-tool="' + t.type + '"><span class="ic">' + t.ic + '</span>' + t.label + '</button>').join('');
      $$('#tool-list .tool-btn').forEach((b) =>
        b.addEventListener('click', () => {
          const t = TOOLS.find((x) => x.type === b.dataset.tool);
          // Touch & Floating: 화면 중앙에 즉시 생성(Spawn) — 모바일 드래그 유실 방지
          const f = { id: 'f' + ++fieldSeq, type: t.type, signerIdx: activeSigner, page: draft.page, x: 50 - t.w / 2, y: 47, w: t.w, h: t.h };
          draft.fields.push(f);
          selected = f.id;
          drawFields();
        }));
    }
    $$('[data-ttab]').forEach((b) =>
      b.addEventListener('click', () => {
        toolTab = b.dataset.ttab;
        $$('[data-ttab]').forEach((x) => x.classList.toggle('active', x === b));
        drawTools();
      }));
    drawTools();
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

  // ── 3단계: 기타 설정 (벤치마크 카드 스택 + 우측 체크리스트) ───────
  function drawSettings(body) {
    body.innerHTML =
      '<div class="request-layout">' +
      '<section style="display:grid;gap:12px;min-width:0">' +
      '<div class="card card-pad"><div class="section-title">' + icons.doc + ' 문서 정보</div>' +
      '<div style="display:grid;gap:14px;margin-top:14px">' +
      '<div><label class="field-label">문서 제목 *</label><input class="input" id="set-title" placeholder="예: 260707 합의서(김영신)_피해자" value="' + esc(draft.title) + '"></div>' +
      '<div class="toolbar-row"><div style="flex:1"><label class="field-label">라벨</label><select class="input" id="set-label"><option value="">선택 안 함</option>' +
      LS.labels.map((l) => '<option ' + (draft.label === l ? 'selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>' +
      '<div style="flex:1"><label class="field-label">서명 기한</label><select class="input" id="set-exp">' +
      [7, 14, 30].map((d) => '<option value="' + d + '" ' + (draft.expirationDays === d ? 'selected' : '') + '>' + d + '일</option>').join('') + '</select></div></div>' +
      '<div><label class="field-label">전송 예약 (선택)</label><input class="input" id="set-sched" type="datetime-local" value="' + esc(draft.scheduledAt) + '"></div>' +
      '</div></div>' +

      '<div class="card card-pad"><div class="toolbar-row" style="justify-content:space-between"><div class="section-title">📎 첨부파일</div>' +
      '<button class="btn sm" id="set-attach">' + icons.upload + ' 업로드</button></div>' +
      '<div id="attach-list" class="toolbar-row" style="margin-top:8px">' + (draft.attachments.map((a) => '<span class="badge gray">📎 ' + esc(a) + '</span>').join('') || '<span class="dim" style="font-size:12px">서명 요청과 함께 전달할 참고 자료를 첨부합니다.</span>') + '</div></div>' +

      '<div class="card card-pad"><div class="toolbar-row" style="justify-content:space-between"><div class="section-title">👥 외부 참조자</div>' +
      '<button class="btn sm" id="set-cc">＋ 설정</button></div>' +
      '<div id="cc-list" class="toolbar-row" style="margin-top:8px">' + (draft.ccList.map((c) => '<span class="badge blue">' + esc(c) + '</span>').join('') || '<span class="dim" style="font-size:12px">완료본을 이메일로 공유받을 참조자를 지정합니다 (서명 권한 없음).</span>') + '</div></div>' +

      '<div class="card card-pad"><div class="toolbar-row" style="justify-content:space-between"><div class="section-title">⏰ 계약 리마인더</div>' +
      '<select class="input" id="set-remind" style="width:auto">' +
      [['', '설정 안 함'], ['D3', '기한 3일 전'], ['D1', '기한 1일 전'], ['EVERY', '서명 전까지 매일']].map(([v, t]) =>
        '<option value="' + v + '" ' + (draft.reminderRule === v ? 'selected' : '') + '>' + t + '</option>').join('') + '</select></div>' +
      '<p class="dim" style="font-size:12px;margin-top:8px">미서명자에게 카카오톡·이메일 리마인드를 자동 발송하고, 메일함 「리마인더」 폴더와 캘린더에 표시합니다.</p></div>' +

      '<div class="card card-pad"><div class="section-title">✍️ 첫 번째 서명자 옵션</div>' +
      '<div style="display:grid;gap:12px;margin-top:12px">' +
      '<div><label class="field-label">💬 남길 말 입력</label><textarea class="input" id="set-note" rows="2" placeholder="서명자에게 전달할 메시지 (알림 메시지에 포함)">' + esc(draft.note) + '</textarea></div>' +
      '<div><label class="field-label">🔒 인증 수단 추가</label><select class="input" id="set-auth">' +
      [['', '기본 (고유 링크)'], ['KAKAO_CERT', '카카오 본인인증'], ['PHONE', '휴대폰 본인확인'], ['CERT', '공동인증서']].map(([v, t]) =>
        '<option value="' + v + '" ' + (draft.authMethod === v ? 'selected' : '') + '>' + t + '</option>').join('') + '</select></div></div></div>' +
      '</section>' +

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
    $('#set-remind').addEventListener('change', (e) => { draft.reminderRule = e.target.value; });
    $('#set-note').addEventListener('input', (e) => { draft.note = e.target.value; });
    $('#set-auth').addEventListener('change', (e) => { draft.authMethod = e.target.value; });
    $('#set-attach').addEventListener('click', () => {
      draft.attachments.push('참고자료_' + (draft.attachments.length + 1) + '.pdf');
      drawSettings(body);
    });
    $('#set-cc').addEventListener('click', () => {
      const v = prompt('참조자 이메일을 입력하세요');
      if (v && /@.+\./.test(v)) { draft.ccList.push(v); drawSettings(body); }
      else if (v) toast('⚠️ 올바른 이메일 형식이 아닙니다.');
    });
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
      signers: draft.signers.filter((s) => s.name && (s.contact || s.channel === 'IN_PERSON')).map((s) => ({ name: s.name, contact: s.contact || '대면서명', channel: s.channel })),
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
