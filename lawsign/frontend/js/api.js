/**
 * 로싸인(LawSign) 모의 백엔드 계층 (Mock API Layer)
 * ------------------------------------------------------------------
 * 실제 백엔드 연동 시 이 파일의 각 함수 본문만 fetch() 호출로 교체하면
 * 화면(View) 코드는 수정 없이 그대로 동작하도록 REST 계약과 1:1로 설계.
 * 계약 문서: lawsign/docs/API.md
 *
 *   LS.api.getDashboardSummary()        GET  /api/v1/dashboard/summary
 *   LS.api.listDocuments(params)        GET  /api/v1/documents
 *   LS.api.getDocument(id)              GET  /api/v1/documents/{id}
 *   LS.api.updateDocumentStatus(id, s)  PATCH /api/v1/documents/{id}
 *   LS.api.sendDocument(payload)        POST /api/v1/documents/{id}/send
 *   LS.api.remindSigners(id)            POST /api/v1/documents/{id}/remind
 *   LS.api.searchContacts(q)            GET  /api/v1/contacts?q=
 *   LS.api.listTemplates()              GET  /api/v1/templates
 *   LS.api.verifyHash(hexHash)          POST /api/v1/verify
 */
window.LS = window.LS || {};
(function (LS) {
  'use strict';

  const LATENCY_MS = 120; // 네트워크 왕복 시뮬레이션
  const delay = (ms) => new Promise((r) => setTimeout(r, ms || LATENCY_MS));
  const uid = (p) => (p || 'id') + '_' + Math.random().toString(36).slice(2, 10);

  const WORKSPACE = { id: 'ws_cheong', name: '법무법인청' };

  const LABELS = ['합의서', '처벌불원서', '위임장', '약정서', '내용증명', '인사관리문서'];

  const CONTACTS = [
    { name: '김동우', email: 'dongwoo.kim@example.com', phone: '010-1234-5678' },
    { name: '박예빈', email: 'yebin.park@example.com', phone: '010-9876-5432' },
    { name: '김영신', email: 'ys.kim@example.com', phone: '010-2222-8282' },
    { name: '김연호', email: 'yeonho.kim@example.com', phone: '010-7777-1111' },
    { name: '송이슬', email: 'iseul.song@example.com', phone: '010-3141-5926' },
    { name: '우창현', email: 'ch.woo@example.com', phone: '010-8282-0909' },
    { name: '최현지', email: 'hj.choi@example.com', phone: '010-3333-4444' },
    { name: '이영민', email: 'ym.lee@example.com', phone: '010-1111-2222' },
    { name: '김춘중', email: 'cj.kim@example.com', phone: '010-5555-6666' },
    { name: '장태근', email: 'law4kwak@example.com', phone: '010-2824-2468' },
    { name: '강춘철', email: 'cc.kang@example.com', phone: '010-6060-7070' },
    { name: '노진명', email: 'jm.noh@example.com', phone: '010-4545-2323' },
  ];

  const TEMPLATES = [
    { id: 'tpl_agree', title: '합의서 (형사 표준)', fields: 6, usedCount: 182 },
    { id: 'tpl_nopunish', title: '처벌불원서', fields: 4, usedCount: 141 },
    { id: 'tpl_poa', title: '위임장 (소송)', fields: 5, usedCount: 97 },
    { id: 'tpl_fee', title: '수임 약정서', fields: 8, usedCount: 64 },
  ];

  // ── 문서 시드 데이터 ──────────────────────────────────────────────
  // status: DRAFT | SCHEDULED | NEED_MY_SIGN | PENDING_OTHERS | COMPLETED | REJECTED
  const now = Date.now();
  const H = 3600 * 1000;
  const D = 24 * H;

  function doc(o) {
    const d = Object.assign(
      {
        id: uid('doc'),
        workspaceId: WORKSPACE.id,
        label: null,
        urgent: false,
        locked: false,
        expirationDays: 14,
        hash: null,
        signers: [],
        createdAt: now - 3 * D,
        lastActivityAt: now - 3 * D,
        completedAt: null,
        audit: [],
      },
      o
    );
    if (d.status === 'COMPLETED') {
      d.locked = true;
      d.hash = pseudoSha256(d.id + d.title);
      d.completedAt = d.completedAt || d.lastActivityAt;
    }
    if (!d.audit.length) d.audit = defaultAudit(d);
    return d;
  }

  /** 프로토타입용 결정적 해시(표시용). 실서비스는 서버가 파일 버퍼로 SHA-256 생성. */
  function pseudoSha256(seed) {
    let h1 = 0x811c9dc5;
    let out = '';
    for (let i = 0; out.length < 64; i++) {
      const c = seed.charCodeAt(i % seed.length) + i;
      h1 = ((h1 ^ c) * 0x01000193) >>> 0;
      out += h1.toString(16).padStart(8, '0');
    }
    return out.slice(0, 64);
  }

  function defaultAudit(d) {
    const events = [
      { at: d.createdAt, type: 'ISSUED', actor: WORKSPACE.name, detail: '문서 발행 및 서명 요청', ip: '112.153.24.11', ua: 'Windows 11 · Chrome' },
    ];
    if (['PENDING_OTHERS', 'NEED_MY_SIGN', 'COMPLETED'].includes(d.status)) {
      events.push({ at: d.createdAt + 2 * H, type: 'VIEWED', actor: (d.signers[0] || {}).name || '서명자', detail: '문서 열람', ip: '211.234.88.42', ua: 'iOS 17 · Safari' });
    }
    if (d.status === 'COMPLETED') {
      events.push({ at: d.completedAt - 5 * 60000, type: 'SIGNED', actor: (d.signers[0] || {}).name || '서명자', detail: '서명 완료', ip: '211.234.88.42', ua: 'iOS 17 · Safari' });
      events.push({ at: d.completedAt, type: 'LOCKED', actor: 'LawSign 시스템', detail: '전체 완료 · 해시 등록 · 문서 잠금', ip: '-', ua: '-' });
    }
    return events;
  }

  const seedDocs = [
    doc({ title: '서울고등 26노3663 임승주 항소이유서 열람 동의', status: 'DRAFT', signers: [{ name: '김동우', contact: 'dongwoo.kim@example.com', status: 'WAITING' }], createdAt: now - 7 * D, lastActivityAt: now - 7 * D }),
    doc({ title: '(임시 저장) 수원지법 위임장 초안', status: 'DRAFT', signers: [], createdAt: now - 8 * D, lastActivityAt: now - 8 * D, expiresNote: '22일 후 삭제 예정' }),
    doc({ title: '260710 김민석 약정서(민사) 예약 발송', status: 'SCHEDULED', label: '약정서', signers: [{ name: '김민석', contact: '010-9090-1212', status: 'WAITING' }], createdAt: now - 1 * D, lastActivityAt: now - 1 * D }),
    doc({ title: '합의서(박예빈)_피해자 김영신 님', status: 'NEED_MY_SIGN', label: '합의서', urgent: true, signers: [{ name: '김영신', contact: 'ys.kim@example.com', status: 'SIGNED' }, { name: WORKSPACE.name, contact: 'me', status: 'WAITING' }], createdAt: now - 2 * D, lastActivityAt: now - 3 * H }),
    doc({ title: '춘천 26고단10049 김연호 합의서', status: 'PENDING_OTHERS', label: '합의서', signers: [{ name: '김연호', contact: 'yeonho.kim@example.com', status: 'VIEWED' }, { name: '송이슬', contact: 'iseul.song@example.com', status: 'WAITING' }], createdAt: now - 1 * D, lastActivityAt: now - 40 * 60000 }),
    doc({ title: '합의서(장호철)_피해자 장태근 님', status: 'PENDING_OTHERS', label: '합의서', signers: [{ name: '장태근', contact: 'law4kwak@example.com', status: 'WAITING' }], createdAt: now - 4 * D, lastActivityAt: now - 3 * D - 5 * H }),
    doc({ title: '정태환 합의 및 처벌불원서_우창현', status: 'PENDING_OTHERS', label: '처벌불원서', signers: [{ name: '우창현', contact: 'ch.woo@example.com', status: 'WAITING' }], createdAt: now - 11 * D, lastActivityAt: now - 10 * D }),
    doc({ title: '260703 노진명약정서(형사)_작성자 강춘철사무장', status: 'PENDING_OTHERS', label: '약정서', signers: [{ name: '노진명', contact: 'jm.noh@example.com', status: 'VIEWED' }], createdAt: now - 4 * D, lastActivityAt: now - 1 * D }),
    doc({ title: '합의서(김진원)_피해자 최현지 님', status: 'COMPLETED', label: '합의서', signers: [{ name: '최현지', contact: 'hj.choi@example.com', status: 'SIGNED' }], createdAt: now - 2 * D, lastActivityAt: now - 2 * H, completedAt: now - 2 * H }),
    doc({ title: '합의서(김춘중)_피해자 이영민 님', status: 'COMPLETED', label: '합의서', signers: [{ name: '이영민', contact: 'ym.lee@example.com', status: 'SIGNED' }], createdAt: now - 3 * D, lastActivityAt: now - 5 * H, completedAt: now - 5 * H }),
    doc({ title: '내용증명 회신 동의서(강춘철)_요청 취소', status: 'REJECTED', label: '내용증명', signers: [{ name: '강춘철', contact: 'cc.kang@example.com', status: 'REJECTED' }], createdAt: now - 6 * D, lastActivityAt: now - 5 * D }),
    doc({ title: '위임장(노진명)_서명 거절', status: 'REJECTED', label: '위임장', signers: [{ name: '노진명', contact: 'jm.noh@example.com', status: 'REJECTED' }], createdAt: now - 9 * D, lastActivityAt: now - 8 * D }),
  ];

  // 완료 문서 물량 생성 (총 325건 규모 시뮬레이션 — 리스트/칸반 가상 스크롤 검증용)
  const FILLER_TITLES = ['합의서', '처벌불원서', '위임장', '수임 약정서', '내용증명 회신 동의서'];
  const fillerDocs = [];
  for (let i = 0; i < 40; i++) {
    const c = CONTACTS[i % CONTACTS.length];
    const label = LABELS[i % LABELS.length];
    fillerDocs.push(
      doc({
        title: FILLER_TITLES[i % FILLER_TITLES.length] + '(' + c.name + ')_' + (2026060 + i) + '호',
        status: i % 5 === 0 ? 'PENDING_OTHERS' : 'COMPLETED',
        label,
        signers: [{ name: c.name, contact: c.email, status: i % 5 === 0 ? 'WAITING' : 'SIGNED' }],
        createdAt: now - (5 + i) * D,
        lastActivityAt: now - (4 + i) * D,
        completedAt: i % 5 === 0 ? null : now - (4 + i) * D,
      })
    );
  }
  const DB = { documents: seedDocs.concat(fillerDocs) };

  // 실제 상태별 총계는 서버 집계값 사용을 가정 (완료 325건 등)
  const REMOTE_TOTALS = { NEED_MY_SIGN: 1, PENDING_OTHERS: 32, COMPLETED: 325, SCHEDULED: 1, DRAFT: 3 };

  // ── 검증 포털용 해시 원장 (프로토타입: 데모 파일 해시를 부팅 시 등록) ──
  const HASH_LEDGER = new Map(); // hexHash -> document meta
  DB.documents.filter((d) => d.hash).forEach((d) => {
    HASH_LEDGER.set(d.hash, { documentId: d.id, title: d.title, issuer: WORKSPACE.name, completedAt: d.completedAt, txId: '0x' + d.hash.slice(0, 40) });
  });

  /** 데모 원본 파일 — 내용 기반 실제 SHA-256을 원장에 등록해 검증 성공 경로를 재현한다. */
  const DEMO_FILE = {
    name: '합의서(김진원)_원본.txt',
    content: [
      '전자서명 완료 문서 (로싸인 데모 원본)',
      '문서명: 합의서(김진원)_피해자 최현지 님',
      '발행처: 법무법인청 / 발행 플랫폼: LawSign',
      '본 파일의 SHA-256 해시는 로싸인 검증 원장에 등록되어 있습니다.',
    ].join('\n'),
  };

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  let demoLedgerReady = null;
  function ensureDemoLedger() {
    if (!demoLedgerReady) {
      demoLedgerReady = (async () => {
        if (!window.crypto || !crypto.subtle) return;
        const buf = new TextEncoder().encode(DEMO_FILE.content);
        const hex = await sha256Hex(buf);
        const src = DB.documents.find((d) => d.title.indexOf('김진원') >= 0) || DB.documents[0];
        HASH_LEDGER.set(hex, { documentId: src.id, title: src.title, issuer: WORKSPACE.name, completedAt: src.completedAt, txId: '0x' + hex.slice(0, 40) });
      })();
    }
    return demoLedgerReady;
  }

  // ── 공개 API ──────────────────────────────────────────────────────
  LS.workspace = WORKSPACE;
  LS.labels = LABELS;
  /** 연동된 발신 계정 — 실서비스: Gmail OAuth2(gmail.send 스코프) + 카카오 비즈메시지 발신프로필 */
  LS.senderAccounts = {
    gmail: { email: 'cheong.law@gmail.com', connected: true },
    kakao: { profile: '@법무법인청', connected: true },
  };

  LS.api = {
    /** GET /api/v1/dashboard/summary */
    async getDashboardSummary() {
      await delay();
      const trend = [];
      for (let i = 29; i >= 0; i--) {
        const base = 6 + Math.round(5 * Math.sin(i / 4)) + (i % 7 === 0 ? 4 : 0);
        trend.push({ date: new Date(now - i * D).toISOString().slice(5, 10).replace('-', '.'), completed: Math.max(1, base + ((i * 13) % 5)) });
      }
      const stale = Date.now() - 3 * D;
      const tooOld = Date.now() - 15 * D; // 15일 초과 건은 별도 만료 처리 대상으로 분리
      const urgent = DB.documents
        .filter((d) => d.status === 'PENDING_OTHERS' && d.lastActivityAt < stale && d.lastActivityAt > tooOld)
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
        .slice(0, 4);
      return { counts: Object.assign({}, REMOTE_TOTALS), trend, urgent, urgentTotal: urgent.length };
    },

    /** GET /api/v1/documents?status=&q=&label=&range=&page=&size= — status=REMIND는 서버측 지연 필터 */
    async listDocuments(params) {
      params = params || {};
      await delay();
      let rows = DB.documents.slice();
      if (params.status === 'REMIND') {
        const staleLine = Date.now() - 3 * D;
        rows = rows.filter((d) => d.status === 'PENDING_OTHERS' && d.lastActivityAt < staleLine);
      } else if (params.status) rows = rows.filter((d) => d.status === params.status);
      if (params.rangeDays) {
        const since = Date.now() - Number(params.rangeDays) * D;
        rows = rows.filter((d) => d.lastActivityAt >= since);
      }
      if (params.label) rows = rows.filter((d) => d.label === params.label);
      if (params.q) {
        const q = params.q.toLowerCase();
        rows = rows.filter((d) => d.title.toLowerCase().includes(q) || d.signers.some((s) => s.name.toLowerCase().includes(q)));
      }
      rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const size = params.size || 50;
      const page = params.page || 1;
      const total = params.status && !params.q && !params.label ? Math.max(rows.length, REMOTE_TOTALS[params.status] || rows.length) : rows.length;
      return { items: rows.slice((page - 1) * size, page * size), total, page, size };
    },

    /** GET /api/v1/documents/{id} */
    async getDocument(id) {
      await delay();
      const d = DB.documents.find((x) => x.id === id);
      if (!d) throw new Error('DOCUMENT_NOT_FOUND');
      return d;
    },

    /** PATCH /api/v1/documents/{id} — 칸반 드래그 앤 드롭 상태 변경 (Optimistic UI 대상) */
    async updateDocumentStatus(id, status) {
      await delay(220);
      const d = await this.getDocument(id);
      d.status = status;
      d.lastActivityAt = Date.now();
      d.audit.push({ at: d.lastActivityAt, type: 'STATUS', actor: WORKSPACE.name, detail: '상태 변경 → ' + status, ip: '112.153.24.11', ua: 'Web' });
      return d;
    },

    /** POST /api/v1/documents — 서명 요청 생성(발송). 서버는 큐에 적재 후 즉시 응답. */
    async sendDocument(payload) {
      await delay(300);
      const d = doc({
        title: payload.title,
        label: payload.label || null,
        status: payload.scheduledAt ? 'SCHEDULED' : 'PENDING_OTHERS',
        expirationDays: payload.expirationDays || 14,
        signers: (payload.signers || []).map((s, i) => ({ name: s.name, contact: s.contact, order: i + 1, status: 'WAITING' })),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      DB.documents.unshift(d);
      REMOTE_TOTALS.PENDING_OTHERS += payload.scheduledAt ? 0 : 1;
      return { document: d, queuedNotifications: (payload.signers || []).length };
    },

    /** POST /api/v1/documents/{id}/remind — 독촉 알림(카카오톡/이메일) 발송 */
    async remindSigners(id) {
      await delay(260);
      const d = await this.getDocument(id);
      d.lastActivityAt = Date.now();
      d.audit.push({ at: d.lastActivityAt, type: 'REMIND', actor: WORKSPACE.name, detail: '독촉 알림 발송 (카카오톡·이메일)', ip: '112.153.24.11', ua: 'Web' });
      return { sent: d.signers.filter((s) => s.status !== 'SIGNED').length };
    },

    /**
     * POST /api/v1/documents/{id}/notify — 메일함 발신
     * channel: 'EMAIL'(Gmail API users.messages.send) | 'KAKAO'(알림톡 템플릿)
     * 서버는 큐 적재 후 202 응답, Worker가 실제 발신. 발신 내역은 감사 로그에 기록.
     */
    async sendNotification(id, payload) {
      await delay(320);
      const d = await this.getDocument(id);
      const channelLabel = payload.channel === 'KAKAO' ? '카카오톡 알림톡' : 'Gmail 이메일';
      d.lastActivityAt = Date.now();
      d.audit.push({
        at: d.lastActivityAt,
        type: 'NOTIFY',
        actor: WORKSPACE.name,
        detail: channelLabel + ' 발신 → ' + (payload.to || []).join(', '),
        ip: '112.153.24.11',
        ua: 'Web',
      });
      return {
        sent: (payload.to || []).length,
        channel: payload.channel,
        messageId: (payload.channel === 'KAKAO' ? 'kko_' : 'gml_') + Math.random().toString(36).slice(2, 12),
      };
    },

    /** GET /api/v1/contacts?q= — 스마트 연락처 자동완성 (서버측 prefix 검색 가정) */
    async searchContacts(q) {
      await delay(80);
      if (!q) return [];
      const needle = q.toLowerCase();
      return CONTACTS.filter((c) => c.name.includes(q) || c.email.toLowerCase().includes(needle) || c.phone.replace(/-/g, '').includes(needle.replace(/-/g, ''))).slice(0, 5);
    },

    /** GET /api/v1/templates */
    async listTemplates() {
      await delay(60);
      return TEMPLATES.slice();
    },

    /**
     * POST /api/v1/verify { hash }
     * 원본 파일은 절대 서버로 전송하지 않는다(Zero-Knowledge).
     * 브라우저에서 계산한 SHA-256 hex 문자열만 대조한다.
     */
    async verifyHash(hexHash) {
      await ensureDemoLedger();
      await delay(180);
      const record = HASH_LEDGER.get(hexHash);
      return record ? { valid: true, record } : { valid: false };
    },

    /** 검증 데모용 파일 정의(변조본은 클라이언트에서 1글자 수정 생성) */
    getDemoFile() {
      return DEMO_FILE;
    },

    sha256Hex,
  };
})(window.LS);
