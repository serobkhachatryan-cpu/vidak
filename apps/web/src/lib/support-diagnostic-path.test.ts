import { describe, expect, it } from 'vitest';
import { supportDiagnosticPath } from './support-diagnostic-path';

describe('supportDiagnosticPath', () => {
  it('keeps fixed page types without retaining a route value', () => {
    expect(supportDiagnosticPath('/support')).toBe('/support');
  });

  it('redacts dynamic video and identity path segments', () => {
    expect(supportDiagnosticPath('/watch/space/private-record-value')).toBe(
      '/watch/space/[video]',
    );
    expect(supportDiagnosticPath('/watch/imported/source-video-value')).toBe(
      '/watch/imported/[video]',
    );
    expect(supportDiagnosticPath('/user/account-value')).toBe('/user/[user]');
  });

  it('does not persist unexpected paths or URL-like values', () => {
    expect(supportDiagnosticPath('/unknown/private-value')).toBe('/other');
    expect(supportDiagnosticPath('/watch/space/private-value?token=value')).toBe('/other');
  });
});
