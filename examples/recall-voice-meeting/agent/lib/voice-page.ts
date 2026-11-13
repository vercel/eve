/**
 * The page a Recall bot streams as its camera and microphone. It plays the
 * agent's speech from `voice/stream`, shows what it's saying, and stops
 * talking when someone in the meeting talks over it.
 */
export const VOICE_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>eve</title>
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #ededed;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { height: 100%; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 48px; }
  #orb { width: 220px; height: 220px; border-radius: 50%; display: grid; place-items: center;
    background: radial-gradient(circle at 35% 30%, #3b3b3b, #161616 70%);
    box-shadow: 0 0 0 0 rgba(255,255,255,0.0); transition: box-shadow 120ms linear; }
  #orb span { font-size: 64px; font-weight: 600; letter-spacing: -0.04em; }
  #caption { max-width: 1040px; min-height: 2.6em; padding: 0 64px; text-align: center;
    font-size: 34px; line-height: 1.3; color: #a1a1a1; }
  #status { position: fixed; bottom: 24px; font-size: 18px; color: #555; }
</style>
</head>
<body>
<main>
  <div id="orb"><span>eve</span></div>
  <div id="caption"></div>
</main>
<div id="status">connecting</div>
<script>
(() => {
  const orb = document.getElementById("orb");
  const caption = document.getElementById("caption");
  const status = document.getElementById("status");
  const audio = new AudioContext();
  const output = audio.createAnalyser();
  output.fftSize = 512;
  output.connect(audio.destination);

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
      caption.textContent = "";
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
    caption.textContent = next.text;
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
    caption.textContent = "";
  }

  async function listen() {
    // Recall grants the page the meeting's mixed audio, without the bot's own voice.
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    const meeting = audio.createAnalyser();
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

  function animate() {
    const samples = new Float32Array(output.fftSize);
    output.getFloatTimeDomainData(samples);
    const glow = Math.min(1, rms(samples) * 6);
    orb.style.boxShadow = "0 0 " + (20 + glow * 80) + "px " + glow * 24 + "px rgba(255,255,255," + glow * 0.35 + ")";
    requestAnimationFrame(animate);
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
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  animate();
  listen().catch((error) => console.error("could not hear the meeting", error));
  follow();
})();
</script>
</body>
</html>
`;
