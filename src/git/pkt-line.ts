/**
 * Git pkt-line format encoding and decoding
 *
 * pkt-line format:
 * - 4 hex digits for length (including the 4 length bytes)
 * - Data payload
 * - Special lines: "0000" (flush), "0001" (delimiter), "0002" (response-end)
 */

export interface PktLine {
  type: "data" | "flush" | "delimiter" | "response-end";
  data?: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode a string as a pkt-line
 */
export function encodePktLine(data: string): string {
  const length = data.length + 4;
  const hex = length.toString(16).padStart(4, "0");
  return hex + data;
}

/**
 * Encode binary data as a pkt-line
 */
export function encodePktLineBytes(data: Uint8Array): Uint8Array {
  const length = data.length + 4;
  const hex = length.toString(16).padStart(4, "0");
  const hexBytes = encoder.encode(hex);

  const result = new Uint8Array(hexBytes.length + data.length);
  result.set(hexBytes, 0);
  result.set(data, hexBytes.length);

  return result;
}

/**
 * Return flush packet "0000"
 */
export function flushPkt(): string {
  return "0000";
}

/**
 * Return delimiter packet "0001"
 */
export function delimiterPkt(): string {
  return "0001";
}

/**
 * Return response-end packet "0002"
 */
export function responseEndPkt(): string {
  return "0002";
}

/**
 * Parse pkt-lines from a buffer
 */
export function* parsePktLines(buffer: Uint8Array): Generator<PktLine> {
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error("Incomplete pkt-line header");
    }

    const lengthHex = decoder.decode(buffer.slice(offset, offset + 4));
    const length = parseInt(lengthHex, 16);

    if (length === 0) {
      // Flush packet
      yield { type: "flush" };
      offset += 4;
      continue;
    }

    if (length === 1) {
      // Delimiter packet
      yield { type: "delimiter" };
      offset += 4;
      continue;
    }

    if (length === 2) {
      // Response-end packet
      yield { type: "response-end" };
      offset += 4;
      continue;
    }

    if (length < 4) {
      throw new Error(`Invalid pkt-line length: ${length}`);
    }

    const dataLength = length - 4;
    if (offset + 4 + dataLength > buffer.length) {
      throw new Error("Incomplete pkt-line data");
    }

    const data = buffer.slice(offset + 4, offset + 4 + dataLength);
    yield { type: "data", data };

    offset += length;
  }
}

/**
 * Parse all pkt-lines from a buffer into an array
 */
export function parsePktLinesAll(buffer: Uint8Array): PktLine[] {
  return Array.from(parsePktLines(buffer));
}

/**
 * Build a pkt-line response with multiple lines
 */
export function buildPktLines(lines: (string | Uint8Array | "flush" | "delimiter")[]): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const line of lines) {
    if (line === "flush") {
      parts.push(encoder.encode("0000"));
    } else if (line === "delimiter") {
      parts.push(encoder.encode("0001"));
    } else if (typeof line === "string") {
      parts.push(encoder.encode(encodePktLine(line)));
    } else {
      parts.push(encodePktLineBytes(line));
    }
  }

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Convert Uint8Array to string, trimming trailing newline
 */
export function pktLineDataToString(data: Uint8Array): string {
  let str = decoder.decode(data);
  if (str.endsWith("\n")) {
    str = str.slice(0, -1);
  }
  return str;
}
