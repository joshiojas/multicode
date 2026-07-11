/**
 * A byte-bounded accumulator for provider/command output. Once `maxBytes` of content has been
 * retained, further writes are counted but discarded, so a runaway process cannot exhaust memory. The
 * retained portion is the *head* of the stream (the start, where setup/errors usually appear), with a
 * trailing marker noting how much was dropped.
 */
export class BoundedBuffer {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #retainedBytes = 0;
  #droppedBytes = 0;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive integer');
    }
    this.#maxBytes = maxBytes;
  }

  /** Append a chunk. Returns how many bytes were retained vs dropped for this write. */
  write(chunk: string | Buffer): { retained: number; dropped: number } {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const room = this.#maxBytes - this.#retainedBytes;
    if (room <= 0) {
      this.#droppedBytes += buf.length;
      return { retained: 0, dropped: buf.length };
    }
    if (buf.length <= room) {
      this.#chunks.push(buf);
      this.#retainedBytes += buf.length;
      return { retained: buf.length, dropped: 0 };
    }
    // Partial fit: keep the head, drop the rest.
    this.#chunks.push(buf.subarray(0, room));
    this.#retainedBytes += room;
    const dropped = buf.length - room;
    this.#droppedBytes += dropped;
    return { retained: room, dropped };
  }

  get truncated(): boolean {
    return this.#droppedBytes > 0;
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  get droppedBytes(): number {
    return this.#droppedBytes;
  }

  get totalBytes(): number {
    return this.#retainedBytes + this.#droppedBytes;
  }

  /** The retained content, with a truncation marker appended when applicable. */
  toString(): string {
    const body = Buffer.concat(this.#chunks).toString('utf8');
    if (!this.truncated) return body;
    return `${body}\n… [truncated ${this.#droppedBytes} byte(s) of output]`;
  }

  /** The raw retained bytes (no marker). */
  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}
