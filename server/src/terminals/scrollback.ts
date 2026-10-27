const countNewlines = (s: string): number => {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

/**
 * The newest part of a shell's output: at most `maxLines` lines and `maxBytes` characters.
 * Output is kept as a queue of chunks. Old chunks are dropped whole, and only the oldest remaining chunk is ever
 * cut, so a flood of output costs work in proportion to what arrives, never to the size of the buffer.
 */
export class Scrollback {
  private chunks: string[] = [];
  private head = 0;
  private chars = 0;
  private newlines = 0;

  constructor(
    private readonly maxLines = 5000,
    private readonly maxBytes = 1_048_576,
  ) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.chars += chunk.length;
    this.newlines += countNewlines(chunk);
    // Lines first: drop from the front until at most maxLines newlines remain.
    while (this.newlines > this.maxLines) {
      const first = this.chunks[this.head]!;
      const n = countNewlines(first);
      if (n <= this.newlines - this.maxLines) {
        this.dropHead(first.length, n);
        continue;
      }
      let at = -1;
      for (let k = this.newlines - this.maxLines; k > 0; k--) at = first.indexOf('\n', at + 1);
      this.cutHead(at + 1);
    }
    this.cap(this.maxBytes);
  }

  /** Keeps only the newest `maxBytes` characters. Used on a shell that has ended. */
  shrink(maxBytes: number): void {
    this.cap(maxBytes);
  }

  text(): string {
    return this.chunks.slice(this.head).join('');
  }

  private cap(maxBytes: number): void {
    while (this.chars > maxBytes) {
      const first = this.chunks[this.head]!;
      if (this.chars - first.length >= maxBytes) this.dropHead(first.length, countNewlines(first));
      else this.cutHead(this.chars - maxBytes);
    }
  }

  private dropHead(len: number, newlines: number): void {
    this.chunks[this.head++] = '';
    this.chars -= len;
    this.newlines -= newlines;
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  /** Removes the first `n` characters of the oldest chunk. */
  private cutHead(n: number): void {
    const first = this.chunks[this.head]!;
    this.newlines -= countNewlines(first.slice(0, n));
    this.chars -= n;
    this.chunks[this.head] = first.slice(n);
  }
}
