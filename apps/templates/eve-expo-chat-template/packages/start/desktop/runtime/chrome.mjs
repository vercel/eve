// Keep the cloud browser alive without restarting the desktop or its VNC sessions.
export class CloudChrome {
  constructor({ launch, health, attach, detach, onReady, retryMs = 500, monitorMs = 2000 }) {
    Object.assign(this, { launch, health, attach, detach, onReady, retryMs, monitorMs });
    this.stopping = false;
    this.child = null;
    this.recovery = null;
    this.ready = false;
    const report = this.onReady;
    this.onReady = (value) => {
      this.ready = value;
      report(value);
    };
  }
  async start() {
    await this.ensure();
    this.monitor = setInterval(() => {
      if (!this.recovery && !this.stopping)
        void (this.ready ? this.health() : this.ensure()).catch(() => {
          this.onReady(false);
          void this.ensure().catch(() => {});
        });
    }, this.monitorMs);
    this.monitor.unref?.();
  }
  ensure() {
    if (this.stopping || (this.ready && this.child)) return Promise.resolve();
    if (this.recovery) return this.recovery;
    this.recovery = this.recover().finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }
  async recover() {
    this.onReady(false);
    for (let attempt = 0; attempt < 90 && !this.stopping; attempt++) {
      if (!this.child) {
        await this.detach().catch(() => {});
        if (this.stopping) return;
        const child = this.launch();
        this.child = child;
        const exited = () => {
          if (this.child !== child) return;
          this.child = null;
          this.onReady(false);
          if (!this.stopping) {
            clearTimeout(this.retry);
            this.retry = setTimeout(() => void this.ensure().catch(() => {}), this.retryMs);
          }
        };
        child.once("exit", exited);
        child.once("error", exited);
      }
      try {
        await this.health();
        await this.attach();
        if (this.child && !this.stopping) {
          clearTimeout(this.retry);
          this.onReady(true);
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, this.retryMs));
    }
    if (!this.stopping) throw Error("Cloud Chrome did not become ready");
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.retry);
    clearInterval(this.monitor);
    this.onReady(false);
    const child = this.child;
    if (!child) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exited,
      new Promise((r) => {
        timer = setTimeout(r, 10000);
      }),
    ]);
    clearTimeout(timer);
  }
}
