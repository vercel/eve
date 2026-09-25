import { StringDecoder } from "node:string_decoder";

/** Retain a suffix so even a credential split across pipe chunks is redacted. */
export class SecretRedactor {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private readonly secrets: string[];
  private readonly keep: number;

  constructor(secret: string) {
    this.secrets = [
      ...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]),
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    this.keep = Math.max(1, ...this.secrets.map((value) => value.length));
  }

  push(chunk: Buffer): string {
    this.pending += this.decoder.write(chunk);
    return this.drain(false);
  }

  finish(): string {
    this.pending += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";
    while (this.pending.length > 0) {
      const safe = final ? this.pending.length : Math.max(0, this.pending.length - this.keep + 1);
      if (!safe) break;
      let start = this.pending.length;
      let matched = "";
      for (const secret of this.secrets) {
        const index = this.pending.indexOf(secret);
        if (index >= 0 && index < start) {
          start = index;
          matched = secret;
        }
      }
      if (matched && start < safe) {
        output += this.pending.slice(0, start) + "[REDACTED]";
        this.pending = this.pending.slice(start + matched.length);
      } else {
        output += this.pending.slice(0, safe);
        this.pending = this.pending.slice(safe);
      }
    }
    return output;
  }
}
