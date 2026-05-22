const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const C0_CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const C1_CONTROL_REGEX = /[\u0080-\u009F]/g;
const GBK_MOJIBAKE_MARKER_REGEX = /[\u9286\u951B\u9428\u93C8\u7CA1\u6769\u95AB\u6D5C\u6942\u6A3B\u579C\u9225\u20AC\uE000-\uF8FF]/;
const CJK_REGEX = /[\u3400-\u9FFF]/g;
const SUSPICIOUS_CJK_REGEX = /[\u9286\u951B\u9428\u93C8\u7CA1\u6769\u95AB\u6D5C\u6942\u6A3B\u579C\u9225\u20AC\uE000-\uF8FF]/g;
const COMMON_CHINESE_REGEX = /[\u4E00-\u9FFF]/g;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const GB18030_DECODER = new TextDecoder('gb18030', { fatal: false });

let gb18030EncodeMap: Map<string, readonly number[]> | undefined;

export function sanitizeTextForArtifact(content: string): string {
  return repairGbkMojibake(stripAnsiControlCodes(content));
}

export function stripAnsiControlCodes(content: string): string {
  return content
    .replace(ANSI_REGEX, '')
    .replace(/\r(?!\n)/g, '')
    .replace(C0_CONTROL_REGEX, '')
    .replace(C1_CONTROL_REGEX, '');
}

export function repairGbkMojibake(content: string): string {
  if (!GBK_MOJIBAKE_MARKER_REGEX.test(content)) return content;
  return content
    .split(/(\r?\n)/)
    .map((part) => (part === '\n' || part === '\r\n' ? part : repairMojibakeSegment(part)))
    .join('');
}

function repairMojibakeSegment(segment: string): string {
  if (!GBK_MOJIBAKE_MARKER_REGEX.test(segment)) return segment;

  const repaired = decodeGb18030BytesAsUtf8(segment) ?? decodeLatin1BytesAsUtf8(segment);
  if (mojibakeScore(repaired) >= mojibakeScore(segment)) return segment;
  if (repaired.includes('\uFFFD')) return segment;
  if (commonChineseCount(segment) > 0 && commonChineseCount(repaired) === 0) return segment;

  return repaired;
}

function decodeGb18030BytesAsUtf8(value: string): string | undefined {
  const bytes = encodeGb18030(value);
  return bytes ? UTF8_DECODER.decode(bytes) : undefined;
}

function decodeLatin1BytesAsUtf8(value: string): string {
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
  return UTF8_DECODER.decode(bytes);
}

function encodeGb18030(value: string): Uint8Array | undefined {
  const map = getGb18030EncodeMap();
  const bytes: number[] = [];
  for (const char of value) {
    const encoded = map.get(char);
    if (!encoded) return undefined;
    bytes.push(...encoded);
  }
  return Uint8Array.from(bytes);
}

function getGb18030EncodeMap(): Map<string, readonly number[]> {
  if (gb18030EncodeMap) return gb18030EncodeMap;

  const map = new Map<string, readonly number[]>();
  for (let byte = 0x00; byte <= 0x80; byte += 1) {
    const decoded = GB18030_DECODER.decode(Uint8Array.of(byte));
    if (decoded.length === 1) map.set(decoded, [byte]);
  }

  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const decoded = GB18030_DECODER.decode(Uint8Array.of(lead, trail));
      if (decoded.length !== 1 || decoded === '\uFFFD' || map.has(decoded)) continue;
      map.set(decoded, [lead, trail]);
    }
  }

  gb18030EncodeMap = map;
  return map;
}

function mojibakeScore(value: string): number {
  const suspicious = value.match(SUSPICIOUS_CJK_REGEX)?.length ?? 0;
  const cjk = value.match(CJK_REGEX)?.length ?? 0;
  return suspicious * 3 + Math.max(0, suspicious - (cjk - suspicious));
}

function commonChineseCount(value: string): number {
  return value.match(COMMON_CHINESE_REGEX)?.length ?? 0;
}
