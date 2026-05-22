import { describe, expect, it } from 'vitest';

import { sanitizeTextForArtifact, stripAnsiControlCodes } from '../src/textSanitizer.js';

const gb18030Decoder = new TextDecoder('gb18030');
const utf8Encoder = new TextEncoder();

function simulateUtf8ReadAsGbk(value: string): string {
  return gb18030Decoder.decode(utf8Encoder.encode(value));
}

describe('textSanitizer', () => {
  it('removes ANSI terminal control codes and bare carriage returns', () => {
    expect(stripAnsiControlCodes('\u001b[36mvite\u001b[39m\rtransforming...\u001b[2K')).toBe('vitetransforming...');
  });

  it('repairs lossless UTF-8-as-GB18030 mojibake before writing artifacts', () => {
    const corrupted = simulateUtf8ReadAsGbk('中文文件读取');

    expect(sanitizeTextForArtifact(corrupted)).toBe('中文文件读取');
  });

  it('leaves ordinary English and code-like text untouched', () => {
    const content = 'const knownCount = (aEntry?.knownCount ?? 0) + 1;';

    expect(sanitizeTextForArtifact(content)).toBe(content);
  });
});
