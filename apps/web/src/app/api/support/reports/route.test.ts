import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportReports, supportTasks } from '../../../../server/db/schema';
import * as supportReportModule from '../../../../server/support-report';
import { SupportReportService } from '../../../../server/support-report';
import {
  appOrigin,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../../../server/test/integration-harness';
import { GET, POST } from './route';

const reporter = {
  eName: '@support-reporter.w3id',
  eVaultId: 'evault-support-reporter',
  eVaultUri: 'https://evault.example/support-reporter',
} as const;

describe('support report API', () => {
  let harness: IntegrationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('creates a private engineering task only after explicit automated-analysis consent', async () => {
    harness = await createIntegrationHarness();
    const accessToken = await harness.loginAs(reporter);
    const service = new SupportReportService({
      db: harness.db,
      resolveUser: async (token) =>
        (await requireHarness(harness).authService.getSession(token)).user,
      createId: (() => {
        let sequence = 0;
        return () => `support-${++sequence}`;
      })(),
      now: () => new Date('2026-08-25T10:00:00.000Z'),
    });
    vi.spyOn(supportReportModule, 'getSupportReportService').mockReturnValue(service);

    const response = await POST(
      new NextRequest(`${appOrigin}/api/support/reports`, {
        method: 'POST',
        body: JSON.stringify({
          description: 'The Meshenger video player remains blank after I press play.',
          includeTechnicalDetails: true,
          allowAutomatedAnalysis: true,
          technicalDiagnostics: {
            path: '/meshenger',
            appVersion: 'web-test',
            userAgent: 'Vidak Test Browser',
            language: 'en-US',
            timezone: 'Asia/Yerevan',
            viewport: { width: 1440, height: 900 },
            ignored: 'must not persist',
          },
        }),
        headers: { 'Content-Type': 'application/json', ...harness.bearerHeaders(accessToken) },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      report: { diagnosticsIncluded: true, automaticTask: { status: 'queued' } },
    });

    const rows = await harness.db
      .select({ report: supportReports, task: supportTasks })
      .from(supportReports)
      .innerJoin(supportTasks, eq(supportTasks.reportId, supportReports.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.report.description).toContain('Meshenger video player');
    expect(rows[0]?.report.technicalDiagnostics).toEqual({
      appVersion: 'web-test',
      path: '/meshenger',
      userAgent: 'Vidak Test Browser',
      language: 'en-US',
      timezone: 'Asia/Yerevan',
      viewport: { width: 1440, height: 900 },
    });
    expect(rows[0]?.task.status).toBe('queued');
  });

  it('stores no diagnostics and creates no automatic task without consent', async () => {
    harness = await createIntegrationHarness();
    const accessToken = await harness.loginAs(reporter);
    const service = new SupportReportService({
      db: harness.db,
      resolveUser: async (token) =>
        (await requireHarness(harness).authService.getSession(token)).user,
    });
    vi.spyOn(supportReportModule, 'getSupportReportService').mockReturnValue(service);

    const response = await POST(
      new NextRequest(`${appOrigin}/api/support/reports`, {
        method: 'POST',
        body: JSON.stringify({
          description: 'I cannot find the video that was shared with me yesterday.',
          includeTechnicalDetails: false,
          allowAutomatedAnalysis: false,
          technicalDiagnostics: { userAgent: 'must not persist' },
        }),
        headers: { 'Content-Type': 'application/json', ...harness.bearerHeaders(accessToken) },
      }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      report: { diagnosticsIncluded: false, automaticTask: null },
    });

    const reportRows = await harness.db.select().from(supportReports);
    expect(reportRows).toHaveLength(1);
    expect(reportRows[0]?.technicalDiagnostics).toBeNull();
    const taskRows = await harness.db.select().from(supportTasks);
    expect(taskRows).toHaveLength(0);
  });

  it('requires a trusted origin for a cookie-authenticated report submission', async () => {
    harness = await createIntegrationHarness();
    const accessToken = await harness.loginAs(reporter);
    const service = new SupportReportService({
      db: harness.db,
      resolveUser: async (token) =>
        (await requireHarness(harness).authService.getSession(token)).user,
    });
    vi.spyOn(supportReportModule, 'getSupportReportService').mockReturnValue(service);

    const response = await POST(
      new NextRequest(`${appOrigin}/api/support/reports`, {
        method: 'POST',
        body: JSON.stringify({ description: 'A report submitted without an origin header.' }),
        headers: {
          'Content-Type': 'application/json',
          ...harness.cookieHeaders(accessToken, false),
        },
      }),
    );
    expect(response.status).toBe(403);

    const rows = await harness.db.select().from(supportReports);
    expect(rows).toHaveLength(0);
  });

  it('lists only the signed-in reporter’s own support state', async () => {
    harness = await createIntegrationHarness();
    const accessToken = await harness.loginAs(reporter);
    const service = new SupportReportService({
      db: harness.db,
      resolveUser: async (token) =>
        (await requireHarness(harness).authService.getSession(token)).user,
      createId: (() => {
        let sequence = 0;
        return () => `report-${++sequence}`;
      })(),
    });
    vi.spyOn(supportReportModule, 'getSupportReportService').mockReturnValue(service);
    await service.submit(accessToken, {
      description: 'The uploaded recording cannot be played from my library.',
      allowAutomatedAnalysis: true,
    });

    const response = await GET(
      new NextRequest(`${appOrigin}/api/support/reports`, {
        headers: harness.bearerHeaders(accessToken),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ automaticTask: { status: 'queued' }, diagnosticsIncluded: false }],
    });
    expect(response.headers.get('Cache-Control')).toContain('private');
  });
});

function requireHarness(harness: IntegrationHarness | undefined): IntegrationHarness {
  if (!harness) throw new Error('Expected integration harness.');
  return harness;
}
