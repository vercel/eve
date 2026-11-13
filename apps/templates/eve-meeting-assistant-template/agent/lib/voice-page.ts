/**
 * The page a Recall bot streams as its camera and microphone. It plays the
 * agent's speech from `voice/stream`, draws a dot-matrix waveform that follows
 * the meeting while people talk and eve's own voice while it speaks, shows when
 * eve is thinking, and stops talking when someone in the meeting talks over it.
 */
export const VOICE_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>eve</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0a0a0a; color: #ededed;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  #wave { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
  #name { position: fixed; top: 32px; left: 40px; font-size: 34px; font-weight: 600;
    letter-spacing: -0.04em; color: #a1a1a1; }
  #status { position: fixed; bottom: 32px; width: 100%; text-align: center; font-size: 26px; color: #555; }
</style>
</head>
<body>
<canvas id="wave"></canvas>
<div id="name">eve</div>
<div id="status">connecting</div>
<script>
(() => {
  const canvas = document.getElementById("wave");
  const status = document.getElementById("status");
  const audio = new AudioContext();
  const output = audio.createAnalyser();
  output.fftSize = 512;
  output.connect(audio.destination);
  let meeting = null;

  // Sentences waiting to play, decoded in arrival order.
  const queue = [];
  let playing = null;
  const interrupted = new Set();
  let cursor = null;

  function enqueue(message) {
    if (interrupted.has(message.turnId)) return;
    const bytes = Uint8Array.from(atob(message.audio), (c) => c.charCodeAt(0));
    queue.push({ ...message, buffer: audio.decodeAudioData(bytes.buffer) });
    if (playing === null) playNext();
  }

  async function playNext() {
    const next = queue.shift();
    if (next === undefined) {
      playing = null;
      return;
    }
    playing = next;
    let buffer;
    try {
      buffer = await next.buffer;
    } catch (error) {
      console.error("could not decode speech", error);
      return playNext();
    }
    if (playing !== next) return;
    await audio.resume();
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    next.source = source;
    source.onended = () => {
      if (playing === next) playNext();
    };
    source.start();
  }

  // Someone talking over eve stops it, like a person would, and drops the rest of that reply.
  function interrupt() {
    if (playing === null) return;
    interrupted.add(playing.turnId);
    for (const item of queue) interrupted.add(item.turnId);
    queue.length = 0;
    const current = playing;
    playing = null;
    current.source?.stop();
  }

  async function listen() {
    // Recall grants the page the meeting's mixed audio, without the bot's own voice.
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    meeting = audio.createAnalyser();
    meeting.fftSize = 1024;
    audio.createMediaStreamSource(media).connect(meeting);
    const samples = new Float32Array(meeting.fftSize);
    let loudSince = null;
    setInterval(() => {
      meeting.getFloatTimeDomainData(samples);
      const level = rms(samples);
      if (level > 0.04) {
        loudSince ??= performance.now();
        if (performance.now() - loudSince > 350) interrupt();
      } else {
        loudSince = null;
      }
    }, 50);
  }

  function rms(samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  // Dot-matrix waveform. Each column is the loudness from a moment ago, so speech
  // scrolls out from the right edge. Gray while the meeting talks, white with blue
  // tips while eve speaks, a blue glow sweeping the center while eve thinks, and a
  // dim breathing center line when it's quiet. Faint ripples spread from the
  // center throughout. The grid is coarse so it still reads in a small video tile.
  const GAP = 26;
  const HISTORY_RATE = 40;
  const RIPPLE_PERIOD = 7;
  const WHITE = [237, 237, 237];
  const BLUE = [0, 112, 243];
  const GRAY_400 = [143, 143, 143];
  const GRAY_900 = [31, 31, 31];
  const ctx = canvas.getContext("2d");
  const outputSamples = new Float32Array(output.fftSize);
  const meetingSamples = new Float32Array(1024);
  const history = new Float32Array(256);
  const weights = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  let head = 0;
  let historyClock = 0;
  let levels = new Float32Array(0);
  let meetingLevel = 0;
  let outputLevel = 0;
  let heardAt = -Infinity;
  let thinking = false;
  let width = 0;
  let height = 0;
  let last = performance.now();

  function resize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgba = (c, alpha) => "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + alpha + ")";

  // Fast attack, slower release, so syllables read as distinct peaks.
  function smooth(current, target, dt) {
    const rate = target > current ? 28 : 9;
    return current + (target - current) * (1 - Math.exp(-dt * rate));
  }

  function currentState(now) {
    if (playing !== null) return "speaking";
    if (now - heardAt < 600) return "listening";
    return thinking ? "thinking" : "idle";
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    output.getFloatTimeDomainData(outputSamples);
    outputLevel = smooth(outputLevel, clamp01((rms(outputSamples) - 0.005) * 6), dt);
    if (meeting !== null) {
      meeting.getFloatTimeDomainData(meetingSamples);
      meetingLevel = smooth(meetingLevel, clamp01((rms(meetingSamples) - 0.01) * 6), dt);
    }
    if (meetingLevel > 0.08) heardAt = now;

    const state = currentState(now);
    const ease = 1 - Math.exp(-dt * 4.5);
    for (const key in weights) weights[key] += ((key === state ? 1 : 0) - weights[key]) * ease;

    historyClock += dt;
    while (historyClock >= 1 / HISTORY_RATE) {
      historyClock -= 1 / HISTORY_RATE;
      history[head] = weights.listening * meetingLevel + weights.speaking * outputLevel;
      head = (head + 1) % history.length;
    }

    draw(now / 1000);
    requestAnimationFrame(tick);
  }

  // How much a ring spreading from the center lights a dot that far away, 0 to 1.
  function ripple(distance, maxDistance, t) {
    let glow = 0;
    for (const offset of [0, RIPPLE_PERIOD / 2]) {
      const phase = ((t + offset) % RIPPLE_PERIOD) / RIPPLE_PERIOD;
      const ring = (distance - phase * maxDistance) / (GAP * 1.6);
      glow += Math.exp(-ring * ring) * (1 - phase) * (1 - phase);
    }
    return glow;
  }

  function draw(t) {
    ctx.clearRect(0, 0, width, height);
    const cols = Math.floor((width - GAP) / GAP);
    const rows = Math.floor((height - GAP) / GAP) | 1;
    const left = (width - (cols - 1) * GAP) / 2;
    const top = (height - (rows - 1) * GAP) / 2;
    const mid = (rows - 1) / 2;
    const maxDistance = Math.hypot(width, height) / 2;
    if (levels.length !== cols) levels = new Float32Array(cols);
    const active = weights.listening + weights.speaking;
    const lit = mix(GRAY_400, WHITE, weights.speaking);
    const tip = mix(lit, BLUE, weights.speaking * 0.9);
    const thinkGlow = mix(BLUE, WHITE, 0.25);
    // The thinking glow sweeps back and forth across the middle rows.
    const sweep = 0.5 + 0.42 * Math.sin(t * 1.7);
    const rippleStrength = 0.22 * (1 - weights.speaking * 0.6);
    const dot = GAP * 0.13;

    for (let c = 0; c < cols; c++) {
      const x = cols > 1 ? c / (cols - 1) : 0.5;
      const envelope = Math.pow(Math.sin(Math.PI * x), 0.7);
      const ago = Math.floor((cols - 1 - c) * 0.9);
      const sample = history[(head - 1 - ago + history.length * 4) % history.length];
      levels[c] += (clamp01(sample * envelope * 1.25) * active - levels[c]) * 0.35;
      const reach = levels[c] * mid;
      const idleGlow = weights.idle * (0.25 + 0.12 * Math.sin(t * 1.4 + (1 - Math.abs(x - 0.5) * 2) * 3));
      const along = (x - sweep) * cols / 5;
      const think = weights.thinking * Math.exp(-along * along) * (0.75 + 0.25 * Math.sin(t * 6 + c));
      const px = left + c * GAP;

      for (let r = 0; r < rows; r++) {
        const dy = Math.abs(r - mid);
        const py = top + r * GAP;
        let color = GRAY_900;
        let alpha = 0.6;
        let radius = dot;
        const on = clamp01(reach + 0.6 - dy);
        if (on > 0) {
          color = mix(GRAY_900, dy > reach - 1.2 ? tip : lit, on);
          alpha = 0.6 + on * 0.4;
          radius = dot * (1 + on * 0.35);
        }
        if (dy < 0.5) color = mix(color, GRAY_400, idleGlow);
        const thought = think * clamp01(1.6 - dy * 0.55);
        if (thought > 0.01) {
          color = mix(color, thinkGlow, thought);
          alpha = Math.max(alpha, 0.6 + thought * 0.4);
          radius = Math.max(radius, dot * (1 + thought * 0.3));
        }
        const wave = rippleStrength * ripple(Math.hypot(px - width / 2, py - height / 2), maxDistance, t);
        if (wave > 0.005) color = mix(color, GRAY_400, wave);
        ctx.fillStyle = rgba(color, alpha);
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  async function follow() {
    for (;;) {
      const url = new URL(location.pathname.replace(/\\/$/, "") + "/stream" + location.search, location.origin);
      if (cursor !== null) url.searchParams.set("cursor", String(cursor));
      try {
        const response = await fetch(url);
        if (response.status === 404) {
          status.textContent = "this page is not linked to a meeting";
          return;
        }
        if (!response.ok || response.body === null) {
          status.textContent = response.status === 425 ? "waiting for the meeting" : "reconnecting";
          await sleep(2000);
          continue;
        }
        status.textContent = "";
        await read(response.body);
      } catch (error) {
        console.error("speech stream failed", error);
        status.textContent = "reconnecting";
        await sleep(1000);
      }
    }
  }

  async function read(body) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += value;
      const lines = pending.split("\\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "cursor") cursor = message.cursor;
        else if (message.type === "say") enqueue(message);
        else if (message.type === "turn") thinking = message.thinking;
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(tick);
  listen().catch((error) => console.error("could not hear the meeting", error));
  follow();
})();
</script>
</body>
</html>
`;
