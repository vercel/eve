/**
 * 로싸인(LawSign) AI 어시스턴트 — RAG(검색 증강 생성) + Qwen Max(OpenRouter)
 *
 * 보안 원칙:
 * - API 키는 절대 코드·저장소에 두지 않는다. 브라우저 localStorage에만 보관하며
 *   화면에서는 마스킹해 표시한다. (실서버 전환 시 서버 측 프록시로 이동 — docs/AI_PLAN.md)
 * - 키 미설정·네트워크 차단 환경에서는 검색된 근거 문서만으로 데모 응답을 생성해
 *   전체 UX를 동일하게 시연할 수 있다.
 */
(function (LS) {
  'use strict';
  const { $, $$, esc, toast } = LS.ui;
  const icons = LS.icons;

  const MODEL = 'qwen/qwen-max';
  const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  const KEY = 'ls-ai-key';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };

  const STATUS_KO = { DRAFT: '작성 중', SCHEDULED: '예약됨', NEED_MY_SIGN: '내 서명 필요', PENDING_OTHERS: '상대 서명 대기', COMPLETED: '서명 완료', REJECTED: '거절·취소' };

  // ── RAG-라이트 검색기 ─────────────────────────────────────────────
  // 질문 토큰과 문서 메타데이터(제목·라벨·서명자·상태)의 겹침을 점수화해
  // 상위 k건을 근거 문서로 선별한다. 실서버에서는 임베딩 인덱스로 교체된다.
  async function retrieve(query, k) {
    const res = await LS.api.listDocuments({ size: 500 });
    const q = String(query).toLowerCase();
    const terms = q.split(/[\s,.·?!()「」'"]+/).filter((t) => t.length > 1);
    const wantStale = /독촉|지연|리마인드|미서명|대기/.test(q);
    const wantDone = /완료|체결|끝난/.test(q);
    const scored = res.items.map((d) => {
      const hay = (d.title + ' ' + (d.label || '') + ' ' + d.signers.map((s) => s.name + ' ' + s.contact).join(' ') + ' ' + STATUS_KO[d.status]).toLowerCase();
      let score = 0;
      terms.forEach((t) => { if (hay.includes(t)) score += 2; });
      if (wantStale && d.status === 'PENDING_OTHERS') score += 1.5;
      if (wantDone && d.status === 'COMPLETED') score += 1.5;
      return { d, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k || 5);
    return scored.map((x) => x.d);
  }

  const docLine = (d) =>
    '「' + d.title + '」 — 상태: ' + STATUS_KO[d.status] +
    (d.label ? ', 라벨: ' + d.label : '') +
    ', 서명자: ' + (d.signers.map((s) => s.name).join('·') || '미지정') +
    ', 요청일: ' + LS.ui.fmtDate(d.createdAt) +
    (d.completedAt ? ', 체결일: ' + LS.ui.fmtDate(d.completedAt) : '');

  // ── 데모 폴백: 근거 문서만으로 결정론적 응답 생성 ─────────────────
  async function mockAnswer(q, docs) {
    if (/요약|현황|리포트|얼마나|몇\s*건/.test(q)) {
      const sum = await LS.api.getDashboardSummary();
      const c = sum.counts;
      return '현재 워크스페이스 현황을 요약드립니다.\n\n' +
        '· 내 서명 필요: ' + c.NEED_MY_SIGN + '건 (오늘 우선 처리 권장)\n' +
        '· 상대 서명 대기: ' + c.PENDING_OTHERS + '건' + (sum.urgent.length ? ' — 이 중 ' + sum.urgent.length + '건이 3일 이상 응답 없음' : '') + '\n' +
        '· 서명 완료 누적: ' + c.COMPLETED + '건 · 예약 발송 ' + c.SCHEDULED + '건 · 작성 중 ' + c.DRAFT + '건\n\n' +
        (sum.urgent.length ? '지연 문서(' + sum.urgent.map((d) => '「' + d.title + '」').join(', ') + ')는 메일함 행의 발신 버튼으로 즉시 독촉하실 수 있습니다.' : '지연 중인 문서는 없습니다.');
    }
    if (/독촉|리마인드|재촉/.test(q) && docs.length) {
      const d = docs[0];
      const to = d.signers.find((s) => s.status !== 'SIGNED') || d.signers[0];
      return '「' + d.title + '」 독촉 메시지 초안입니다. 메일함에서 해당 문서의 ✉️ 버튼을 누르면 바로 발신할 수 있습니다.\n\n' +
        '---\n' + (to ? to.name : '고객') + '님, 안녕하세요. ' + LS.workspace.name + '입니다.\n' +
        '요청드린 「' + d.title + '」 전자서명이 아직 완료되지 않아 다시 안내드립니다.\n' +
        '바쁘시겠지만 기한(' + d.expirationDays + '일) 내 서명 부탁드립니다. 링크: https://sign.lawsign.example/d/' + d.id;
    }
    if (!docs.length) {
      return '질문과 일치하는 문서를 찾지 못했습니다. 문서 제목·서명자 이름·라벨(합의서, 처벌불원서 등)로 다시 질문해 보세요.\n예) "장호철 합의서 진행 상황 알려줘"';
    }
    return '관련 문서 ' + docs.length + '건을 찾았습니다.\n\n' + docs.map((d, i) => (i + 1) + '. ' + docLine(d)).join('\n') +
      '\n\n특정 문서의 이력·검증이 필요하면 아래 근거 문서 칩을 눌러 상세를 확인하세요.';
  }

  // ── Qwen Max 호출 (OpenRouter) — 실패 시 데모 응답으로 폴백 ───────
  async function chat(userText, history) {
    const docs = await retrieve(userText, 5);
    const key = LS.ai.getKey();
    if (!key) return { text: await mockAnswer(userText, docs), docs, mode: 'demo' };
    const system =
      '당신은 법무법인용 전자서명 워크스페이스 "로싸인(LawSign)"의 AI 어시스턴트입니다. ' +
      '한국어로 정중하고 간결하게 답하세요. 아래 [근거 문서]에 있는 사실만 사용하고, 근거가 없으면 모른다고 답하세요.\n\n' +
      '[근거 문서]\n' + (docs.length ? docs.map(docLine).join('\n') : '(검색 결과 없음)');
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: system }].concat(history || [], [{ role: 'user', content: userText }]),
          max_tokens: 700,
        }),
      });
      if (!r.ok) throw new Error('OpenRouter HTTP ' + r.status);
      const j = await r.json();
      return { text: j.choices[0].message.content, docs, mode: 'live' };
    } catch (e) {
      return { text: await mockAnswer(userText, docs), docs, mode: 'demo', error: e.message };
    }
  }

  // ── 컴포즈 모달용 발신문 초안 생성 ────────────────────────────────
  async function draftMessage(doc, channel) {
    const to = doc.signers.find((s) => s.status !== 'SIGNED') || doc.signers[0];
    const fallback =
      (to ? to.name : '고객') + '님, 안녕하세요. ' + LS.workspace.name + '입니다.\n' +
      '「' + doc.title + '」' + (doc.label ? '(' + doc.label + ')' : '') + ' 문서의 전자서명을 요청드립니다.\n' +
      '아래 링크에서 내용을 검토하신 후 서명해 주시면 감사하겠습니다. 서명 기한은 요청일로부터 ' + doc.expirationDays + '일입니다.\n' +
      'https://sign.lawsign.example/d/' + doc.id + '\n' +
      '문의사항은 본 ' + (channel === 'KAKAO' ? '카카오톡' : '메일') + '으로 회신 주세요.';
    const key = LS.ai.getKey();
    if (!key) return fallback;
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{
            role: 'user',
            content: '전자서명 요청 ' + (channel === 'KAKAO' ? '카카오 알림톡(간결, 4문장 이내)' : '이메일 본문') +
              '을 한국어 존댓말로 작성해줘. 인사말 포함, 서명 링크 자리에 ' +
              'https://sign.lawsign.example/d/' + doc.id + ' 사용. 문서: ' + docLine(doc) + ' / 발신처: ' + LS.workspace.name +
              ' / 받는 사람: ' + (to ? to.name : '고객') + '. 본문 텍스트만 출력.',
          }],
          max_tokens: 400,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return j.choices[0].message.content.trim();
    } catch (e) {
      return fallback;
    }
  }

  LS.ai = {
    getKey: () => store.get(KEY) || '',
    setKey: (k) => store.set(KEY, String(k).trim()),
    clearKey: () => store.del(KEY),
    maskedKey() { const k = this.getKey(); return k ? k.slice(0, 8) + '…' + k.slice(-4) : ''; },
    retrieve, chat, draftMessage,
  };

  // ══════════════════════════════════════════════════════════════════
  // 화면: AI 어시스턴트 (RAG 채팅)
  // ══════════════════════════════════════════════════════════════════
  const SUGGESTS = ['이번 달 서명 현황 요약해줘', '3일 넘게 지연된 문서 독촉문 써줘', '장호철 합의서 진행 상황은?', '처벌불원서 관련 문서 찾아줘'];

  LS.route('assistant', async (main) => {
    const hasKey = !!LS.ai.getKey();
    main.innerHTML =
      '<div class="page" style="max-width:860px">' +
      '<div class="docbox-head"><h1 style="font-size:20px"><span class="ai-avatar" style="display:inline-grid;vertical-align:-7px">✦</span> AI 어시스턴트 ' +
      '<span class="badge violet">Qwen Max · RAG</span></h1></div>' +

      '<div class="card card-pad ai-keybar" id="ai-keybar">' +
      (hasKey
        ? '<span>' + icons.check + ' OpenRouter 키 연결됨 <code class="hash-chip">' + esc(LS.ai.maskedKey()) + '</code> — 실제 Qwen Max 모델로 응답합니다.</span>' +
          '<button class="btn sm" id="ai-key-del">연결 해제</button>'
        : '<span>' + icons.warn + ' API 키 미설정 — <b>데모 응답 모드</b>로 동작 중입니다. OpenRouter 키(sk-or-v1-…)를 입력하면 실제 Qwen Max가 응답합니다. 키는 이 브라우저에만 저장되며 서버·저장소로 전송되지 않습니다.</span>' +
          '<span class="toolbar-row" style="flex:none"><input type="password" class="input" id="ai-key-in" placeholder="sk-or-v1-…" style="width:220px">' +
          '<button class="btn primary sm" id="ai-key-save">저장</button></span>') +
      '</div>' +

      '<div class="ai-chat" id="ai-chat">' +
      '<div class="ai-msg"><span class="ai-avatar">✦</span><div class="bubble">안녕하세요, ' + esc(LS.workspace.name) + ' 님. 문서함 전체를 근거로 답하는 로싸인 AI 어시스턴트입니다.\n서명 현황 요약, 지연 문서 독촉문 작성, 문서 검색을 도와드릴 수 있어요.</div></div>' +
      '</div>' +
      '<div class="toolbar-row ai-suggest" id="ai-suggest">' + SUGGESTS.map((s) => '<button class="btn sm">' + esc(s) + '</button>').join('') + '</div>' +
      '<div class="ai-inputbar"><textarea class="input" id="ai-in" rows="1" placeholder="문서에 대해 무엇이든 물어보세요…"></textarea>' +
      '<button class="btn primary" id="ai-send">' + icons.send + ' 보내기</button></div>' +
      '</div>';

    const chatBox = $('#ai-chat');
    const input = $('#ai-in');
    const history = [];

    function bubble(role, html) {
      const el = document.createElement('div');
      el.className = 'ai-msg' + (role === 'user' ? ' user' : '');
      el.innerHTML = (role === 'user' ? '' : '<span class="ai-avatar">✦</span>') + '<div class="bubble">' + html + '</div>';
      chatBox.appendChild(el);
      el.scrollIntoView({ block: 'end' });
      return el;
    }

    async function send(text) {
      text = (text || input.value).trim();
      if (!text) return;
      input.value = '';
      bubble('user', esc(text));
      const wait = bubble('ai', '<span class="ai-typing"><i></i><i></i><i></i></span>');
      const btn = $('#ai-send');
      btn.disabled = true;
      const res = await LS.ai.chat(text, history.slice(-6));
      btn.disabled = false;
      history.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
      wait.querySelector('.bubble').innerHTML =
        esc(res.text) +
        (res.docs.length
          ? '<div class="ai-src">' + res.docs.map((d) => '<button class="badge brand" data-src="' + d.id + '">📄 ' + esc(d.title.slice(0, 22)) + (d.title.length > 22 ? '…' : '') + '</button>').join('') + '</div>'
          : '') +
        (res.mode === 'demo' ? '<div class="dim" style="font-size:11px;margin-top:6px">데모 응답' + (res.error ? ' (연결 실패: ' + esc(res.error) + ')' : '') + ' — 근거 문서 검색은 실제로 수행됨</div>' : '');
      $$('[data-src]', wait).forEach((b) => b.addEventListener('click', () => LS.openHistoryModal(b.dataset.src)));
      wait.scrollIntoView({ block: 'end' });
    }

    $('#ai-send').addEventListener('click', () => send());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    $$('#ai-suggest button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));

    const saveBtn = $('#ai-key-save');
    if (saveBtn) saveBtn.addEventListener('click', () => {
      const v = $('#ai-key-in').value.trim();
      if (!/^sk-or-v1-/.test(v)) { toast('⚠️ OpenRouter 키 형식(sk-or-v1-…)이 아닙니다.'); return; }
      LS.ai.setKey(v);
      toast('🔐 키를 이 브라우저에 저장했습니다. 실제 모델로 응답합니다.');
      LS.nav('assistant', { _r: String(Date.now() % 1e7) });
    });
    const delBtn = $('#ai-key-del');
    if (delBtn) delBtn.addEventListener('click', () => {
      LS.ai.clearKey();
      toast('키 연결을 해제했습니다. 데모 응답 모드로 전환됩니다.');
      LS.nav('assistant', { _r: String(Date.now() % 1e7) });
    });
  });
})(window.LS);
