import { describe, expect, it } from 'vitest';
import { parseSingleByteRange } from './media-byte-range';

describe('parseSingleByteRange', () => {
  it('treats missing headers as full-body requests', () => {
    expect(parseSingleByteRange(null, 10)).toEqual({ kind: 'absent' });
    expect(parseSingleByteRange('', 10)).toEqual({ kind: 'absent' });
  });

  it('parses closed, open-ended, and suffix ranges', () => {
    expect(parseSingleByteRange('bytes=0-3', 10)).toEqual({ kind: 'range', start: 0, end: 3 });
    expect(parseSingleByteRange('bytes=2-', 10)).toEqual({ kind: 'range', start: 2, end: 9 });
    expect(parseSingleByteRange('bytes=-4', 10)).toEqual({ kind: 'range', start: 6, end: 9 });
    expect(parseSingleByteRange('bytes=0-99', 10)).toEqual({ kind: 'range', start: 0, end: 9 });
  });

  it('rejects multipart and malformed ranges', () => {
    expect(parseSingleByteRange('bytes=0-1,2-3', 10)).toEqual({ kind: 'invalid' });
    expect(parseSingleByteRange('bytes=abc', 10)).toEqual({ kind: 'invalid' });
    expect(parseSingleByteRange('items=0-1', 10)).toEqual({ kind: 'invalid' });
    expect(parseSingleByteRange('bytes=5-1', 10)).toEqual({ kind: 'invalid' });
  });

  it('marks ranges past the object size as unsatisfiable', () => {
    expect(parseSingleByteRange('bytes=10-11', 10)).toEqual({ kind: 'unsatisfiable' });
    expect(parseSingleByteRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
