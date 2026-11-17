/**
 * The viewer page's script, served inline with a CSP nonce. It renders one of
 * two stream protocols on a canvas and sends the person's input back:
 *
 * - `screencast`: agent-browser's stream (JSON frames with base64 JPEG,
 *   CDP-style `input_mouse` / `input_keyboard` messages).
 * - `rfb`: VNC (RFC 6143) over a binary WebSocket, with no VNC password
 *   because the proxy's token is the gate. Raw, CopyRect, and DesktopSize
 *   encodings only: enough for a sign-in, not a remote desktop product.
 *
 * Plain browser JavaScript with no dependencies, so the page loads nothing
 * from third parties. Keep it free of backticks and `${`, since it lives in a
 * template string.
 */
export const VIEWER_CLIENT_SOURCE = String.raw`
(() => {
  const data = JSON.parse(document.getElementById("takeover-data").textContent);
  const canvas = document.getElementById("screen");
  const ctx2d = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const urlEl = document.getElementById("url");
  const noticeEl = document.getElementById("notice");
  const reconnectBtn = document.getElementById("reconnect");
  const doneBtn = document.getElementById("done");
  const cancelBtn = document.getElementById("cancel");
  const timeEl = document.getElementById("time");
  let socket = null;
  let renderer = null;

  function setStatus(text, tone) {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  }
  function showNotice(text) {
    noticeEl.textContent = text;
    noticeEl.hidden = !text;
  }
  function tick() {
    const left = Math.max(0, Math.round((data.expiresAt - Date.now()) / 60000));
    timeEl.textContent = left + " min left";
  }
  tick();
  setInterval(tick, 15000);

  function modifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }
  function point(e, width, height) {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * width;
    const y = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * height;
    return {
      x: Math.round(Math.min(Math.max(x, 0), width)),
      y: Math.round(Math.min(Math.max(y, 0), height)),
    };
  }
  function setAspect(width, height) {
    canvas.style.aspectRatio = width + " / " + height;
  }

  // agent-browser screencast -------------------------------------------------

  const SPECIAL = {
    Enter: { text: "\r", code: 13 }, Tab: { text: "\t", code: 9 }, Backspace: { code: 8 },
    Escape: { code: 27 }, ArrowLeft: { code: 37 }, ArrowUp: { code: 38 }, ArrowRight: { code: 39 },
    ArrowDown: { code: 40 }, Delete: { code: 46 }, Home: { code: 36 }, End: { code: 35 },
    PageUp: { code: 33 }, PageDown: { code: 34 },
  };
  const PUNCT = {
    " ": 32, ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, "_": 189,
    ".": 190, ">": 190, "/": 191, "?": 191, "\u0060": 192, "~": 192, "[": 219, "{": 219,
    "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222, "\"": 222,
  };
  function keyCode(key) {
    if (SPECIAL[key]) return SPECIAL[key].code;
    if (Array.from(key).length !== 1) return 0;
    const c = key.toUpperCase().charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return c;
    return PUNCT[key] || 0;
  }

  function screencast() {
    let viewport = { width: 1280, height: 720 };
    let drawing = false;
    const send = (m) => socket && socket.readyState === 1 && socket.send(JSON.stringify(m));
    return {
      open() {
        send({ type: "config", maxFps: 15 });
      },
      message(event) {
        if (typeof event.data !== "string") return;
        let m;
        try { m = JSON.parse(event.data); } catch { return; }
        if (m.type === "url" && typeof m.url === "string") urlEl.textContent = m.url;
        if (m.type !== "frame" || typeof m.data !== "string" || drawing) return;
        drawing = true;
        const image = new Image();
        image.onload = () => {
          drawing = false;
          // agent-browser can report its configured viewport (1280x720) while
          // Chrome renders another (1280x577 headless), so the height comes
          // from the image, never from deviceHeight.
          const w = (m.metadata && m.metadata.deviceWidth) || image.naturalWidth;
          const next = { width: w, height: Math.round((w * image.naturalHeight) / Math.max(image.naturalWidth, 1)) };
          if (next.width !== viewport.width || next.height !== viewport.height) {
            viewport = next;
            setAspect(next.width, next.height);
          }
          if (canvas.width !== image.naturalWidth) canvas.width = image.naturalWidth;
          if (canvas.height !== image.naturalHeight) canvas.height = image.naturalHeight;
          ctx2d.drawImage(image, 0, 0);
        };
        image.onerror = () => { drawing = false; };
        image.src = "data:image/jpeg;base64," + m.data;
      },
      mouse(e, type) {
        const p = point(e, viewport.width, viewport.height);
        const moved = type === "mouseMoved";
        send({
          type: "input_mouse", eventType: type, x: p.x, y: p.y,
          button: moved ? "none" : ["left", "middle", "right"][e.button] || "none",
          clickCount: moved ? 0 : Math.max(e.detail, 1), modifiers: modifiers(e),
        });
      },
      wheel(e) {
        const p = point(e, viewport.width, viewport.height);
        send({ type: "input_mouse", eventType: "mouseWheel", x: p.x, y: p.y, button: "none",
          clickCount: 0, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
      },
      key(e, down) {
        const chord = e.ctrlKey || e.metaKey;
        const text = down && !chord
          ? (SPECIAL[e.key] ? SPECIAL[e.key].text : (Array.from(e.key).length === 1 ? e.key : undefined))
          : undefined;
        const m = {
          type: "input_keyboard",
          // Like Puppeteer: a press that inserts no text is a rawKeyDown, so
          // Chrome runs its editing command (Backspace, arrows) instead.
          eventType: down ? (text === undefined ? "rawKeyDown" : "keyDown") : "keyUp",
          key: e.key, code: e.code, windowsVirtualKeyCode: keyCode(e.key), modifiers: modifiers(e),
        };
        if (text !== undefined) m.text = text;
        send(m);
      },
      paste(text) {
        for (const ch of Array.from(text.replace(/\r\n?/g, "\n"))) {
          send({ type: "input_keyboard", eventType: "char", text: ch === "\n" ? "\r" : ch });
        }
      },
    };
  }

  // VNC (RFB 3.8) --------------------------------------------------------------

  const KEYSYMS = {
    Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50,
    ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, PageUp: 0xff55,
    PageDown: 0xff56, End: 0xff57, Insert: 0xff63, Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9,
    Meta: 0xffeb, CapsLock: 0xffe5,
    F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3, F7: 0xffc4,
    F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  };
  function keysym(key) {
    if (KEYSYMS[key]) return KEYSYMS[key];
    const chars = Array.from(key);
    if (chars.length !== 1) return 0;
    const cp = chars[0].codePointAt(0);
    return cp < 0x100 ? cp : 0x01000000 + cp;
  }

  function rfb() {
    let queue = new Uint8Array(0);
    let state = "version";
    let width = 0;
    let height = 0;
    let rectsLeft = 0;
    let image = null;
    let buttons = 0;
    const out = (bytes) => socket && socket.readyState === 1 && socket.send(new Uint8Array(bytes));
    const u16 = (v) => [(v >> 8) & 255, v & 255];
    const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const peek = (n) => queue.length >= n;
    const take = (n) => { const b = queue.subarray(0, n); queue = queue.subarray(n); return b; };
    const r16 = (b, o) => (b[o] << 8) | b[o + 1];
    const r32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

    function request(incremental) {
      out([3, incremental ? 1 : 0, ...u16(0), ...u16(0), ...u16(width), ...u16(height)]);
    }
    function resize(w, h) {
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      setAspect(w, h);
      image = ctx2d.createImageData(w, h);
    }
    function fail(text) {
      showNotice(text);
      socket && socket.close();
    }
    function step() {
      switch (state) {
        case "version":
          if (!peek(12)) return false;
          take(12);
          out(Array.from("RFB 003.008\n").map((c) => c.charCodeAt(0)));
          state = "security";
          return true;
        case "security": {
          if (!peek(1)) return false;
          const n = queue[0];
          if (n === 0) { fail("The desktop refused the connection."); return false; }
          if (!peek(1 + n)) return false;
          const types = Array.from(take(1 + n).subarray(1));
          if (!types.includes(1)) { fail("The desktop asks for a VNC password; start it with -nopw."); return false; }
          out([1]);
          state = "result";
          return true;
        }
        case "result":
          if (!peek(4)) return false;
          if (r32(take(4), 0) !== 0) { fail("The desktop refused the connection."); return false; }
          out([1]); // ClientInit: shared
          state = "init";
          return true;
        case "init": {
          if (!peek(24)) return false;
          const nameLength = r32(queue, 20);
          if (!peek(24 + nameLength)) return false;
          const init = take(24 + nameLength);
          resize(r16(init, 0), r16(init, 2));
          // 32 bpp, depth 24, little-endian true colour: bytes arrive as B, G, R, X.
          out([0, 0, 0, 0, 32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 16, 8, 0, 0, 0, 0]);
          // Raw, CopyRect, DesktopSize.
          out([2, 0, ...u16(3), ...u32(0), ...u32(1), ...u32(-223 >>> 0)]);
          request(false);
          state = "message";
          setStatus("Live", "live");
          return true;
        }
        case "message": {
          if (!peek(1)) return false;
          const type = queue[0];
          if (type === 0) {
            if (!peek(4)) return false;
            rectsLeft = r16(take(4), 2);
            state = rectsLeft === 0 ? "message" : "rect";
            if (rectsLeft === 0) request(true);
            return true;
          }
          if (type === 1) {
            if (!peek(6)) return false;
            const count = r16(queue, 4);
            if (!peek(6 + count * 6)) return false;
            take(6 + count * 6);
            return true;
          }
          if (type === 2) { take(1); return true; }
          if (type === 3) {
            if (!peek(8)) return false;
            const length = r32(queue, 4);
            if (!peek(8 + length)) return false;
            take(8 + length);
            return true;
          }
          fail("The desktop sent a message this viewer doesn't understand.");
          return false;
        }
        case "rect": {
          if (!peek(12)) return false;
          const x = r16(queue, 0), y = r16(queue, 2), w = r16(queue, 4), h = r16(queue, 6);
          const encoding = r32(queue, 8) | 0;
          if (encoding === 0) {
            if (!peek(12 + w * h * 4)) return false;
            const pixels = take(12 + w * h * 4).subarray(12);
            for (let row = 0; row < h; row++) {
              for (let col = 0; col < w; col++) {
                const s = (row * w + col) * 4;
                const d = ((y + row) * width + (x + col)) * 4;
                image.data[d] = pixels[s + 2];
                image.data[d + 1] = pixels[s + 1];
                image.data[d + 2] = pixels[s];
                image.data[d + 3] = 255;
              }
            }
            ctx2d.putImageData(image, 0, 0, x, y, w, h);
          } else if (encoding === 1) {
            if (!peek(16)) return false;
            const rect = take(16);
            const sx = r16(rect, 12), sy = r16(rect, 14);
            ctx2d.drawImage(canvas, sx, sy, w, h, x, y, w, h);
            image = ctx2d.getImageData(0, 0, width, height);
          } else if (encoding === -223) {
            take(12);
            resize(w, h);
          } else {
            fail("The desktop used an encoding this viewer doesn't support.");
            return false;
          }
          rectsLeft -= 1;
          if (rectsLeft === 0) {
            state = "message";
            request(true);
          }
          return true;
        }
      }
      return false;
    }
    function pointer(e) {
      const p = point(e, width, height);
      out([5, buttons, ...u16(p.x), ...u16(p.y)]);
    }
    function key(sym, down) {
      if (sym) out([4, down ? 1 : 0, 0, 0, ...u32(sym)]);
    }
    return {
      binary: true,
      open() {},
      message(event) {
        const chunk = new Uint8Array(event.data);
        const next = new Uint8Array(queue.length + chunk.length);
        next.set(queue);
        next.set(chunk, queue.length);
        queue = next;
        while (step()) {}
      },
      mouse(e, type) {
        const bit = [1, 2, 4][e.button] || 0;
        if (type === "mousePressed") buttons |= bit;
        if (type === "mouseReleased") buttons &= ~bit;
        pointer(e);
      },
      wheel(e) {
        const bit = e.deltaY < 0 ? 8 : 16;
        buttons |= bit;
        pointer(e);
        buttons &= ~bit;
        pointer(e);
      },
      key(e, down) {
        key(keysym(e.key), down);
      },
      paste(text) {
        for (const ch of Array.from(text.replace(/\r\n?/g, "\n"))) {
          const sym = ch === "\n" ? KEYSYMS.Enter : keysym(ch);
          key(sym, true);
          key(sym, false);
        }
      },
    };
  }

  // Connection -------------------------------------------------------------------

  async function post(path) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store" });
  }

  async function connect() {
    if (socket) { const old = socket; socket = null; old.close(); }
    setStatus("Connecting", "pending");
    showNotice("");
    reconnectBtn.hidden = true;
    let response;
    try {
      response = await post(data.tokenPath);
    } catch {
      setStatus("Offline", "off");
      showNotice("Couldn't reach the agent. Check your connection.");
      reconnectBtn.hidden = false;
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
      setStatus("Offline", "off");
      showNotice(body.error || "This takeover link can't be opened.");
      return;
    }
    renderer = data.protocol === "rfb" ? rfb() : screencast();
    const ws = new WebSocket(data.stream + "?token=" + encodeURIComponent(body.token));
    if (renderer.binary) ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (data.protocol !== "rfb") setStatus("Live", "live");
      renderer.open();
      canvas.focus();
    };
    ws.onmessage = (event) => renderer.message(event);
    ws.onclose = () => {
      if (socket !== ws) return;
      setStatus("Offline", "off");
      showNotice("The live " + data.label + " disconnected. If the agent hasn't taken it back yet, reconnect.");
      reconnectBtn.hidden = false;
    };
  }

  canvas.addEventListener("mousedown", (e) => { canvas.focus(); renderer && renderer.mouse(e, "mousePressed"); });
  canvas.addEventListener("mouseup", (e) => renderer && renderer.mouse(e, "mouseReleased"));
  canvas.addEventListener("mousemove", (e) => renderer && renderer.mouse(e, "mouseMoved"));
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); renderer && renderer.wheel(e); }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("keydown", (e) => {
    // Let the person's own paste shortcut fire the paste event.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    renderer && renderer.key(e, true);
  });
  canvas.addEventListener("keyup", (e) => { e.preventDefault(); renderer && renderer.key(e, false); });
  canvas.addEventListener("paste", (e) => {
    e.preventDefault();
    renderer && renderer.paste(e.clipboardData.getData("text/plain"));
  });
  reconnectBtn.addEventListener("click", () => connect());
  // Done and Cancel open eve's sign-in callback for this takeover, which resumes the agent.
  function handBack(url) {
    if (socket) { const old = socket; socket = null; old.close(); }
    doneBtn.disabled = true;
    cancelBtn.disabled = true;
    window.location.assign(url);
  }
  doneBtn.addEventListener("click", () => handBack(data.doneUrl));
  cancelBtn.addEventListener("click", () => handBack(data.cancelUrl));
  connect();
})();
`;
