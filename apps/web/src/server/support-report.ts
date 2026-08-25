import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@w3ds/auth';
import { and, desc, eq } from 'drizzle-orm';
import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { type SupportTaskStatus, supportReports, supportTasks } from './db/schema';
import { getW3dsAuthService, W3dsAuthError } from './w3ds-auth';

const minimumDescriptionLength = 12;
const maximumDescriptionLength = 5_000;

export interface SupportTechnicalDiagnosticsInput {
  appVersion?: unknown;
  path?: unknown;
  userAgent?: unknown;
  language?: unknown;
  timezone?: unknown;
  viewport?: unknown;
}

export interface SubmitSupportReportInput {
  description: unknown;
  includeTechnicalDetails?: unknown;
  allowAutomatedAnalysis?: unknown;
  technicalDiagnostics?: SupportTechnicalDiagnosticsInput;
}

export interface SupportReportSummary {
  id: string;
  createdAt: string;
  diagnosticsIncluded: boolean;
  automaticTask: { status: SupportTaskStatus } | null;
}

export interface SupportReportServiceOptions {
  db: W3dsDatabase;
  resolveUser?: (accessToken: string) => Promise<AuthUser>;
  createId?: () => string;
  now?: () => Date;
}

export class SupportReportError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_report' | 'internal_error',
    public readonly status: 400 | 500,
  ) {
    super(message);
    this.name = 'SupportReportError';
  }
}

/**
 * Private support-intake domain service. A consented report creates one durable
 * engineering task in Vidak's own queue; it never creates a public issue or
 * forwards a report to another platform.
 */
export class SupportReportService {
  private readonly db: W3dsDatabase;
  private readonly resolveUser: (accessToken: string) => Promise<AuthUser>;
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: SupportReportServiceOptions) {
    this.db = options.db;
    this.resolveUser =
      options.resolveUser ??
      (async (accessToken) => (await getW3dsAuthService().getSession(accessToken)).user);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async submit(
    accessToken: string,
    input: SubmitSupportReportInput,
  ): Promise<SupportReportSummary> {
    const user = await this.requireUser(accessToken);
    const report = normalizeSubmitInput(input);
    const now = this.now();
    const reportId = this.createId();
    const taskId = report.allowAutomatedAnalysis ? this.createId() : undefined;

    await this.db.transaction(async (tx) => {
      await tx.insert(supportReports).values({
        id: reportId,
        reporterId: user.id,
        description: report.description,
        ...(report.technicalDiagnostics
          ? { technicalDiagnostics: report.technicalDiagnostics }
          : {}),
        diagnosticsConsent: report.includeTechnicalDetails,
        automatedAnalysisConsent: report.allowAutomatedAnalysis,
        createdAt: now,
        updatedAt: now,
      });
      if (taskId) {
        await tx.insert(supportTasks).values({
          id: taskId,
          reportId,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    return {
      id: reportId,
      createdAt: now.toISOString(),
      diagnosticsIncluded: report.includeTechnicalDetails,
      automaticTask: taskId ? { status: 'queued' } : null,
    };
  }

  /** The reporter can see the state of their own submissions, never another user's report. */
  async listForReporter(accessToken: string): Promise<SupportReportSummary[]> {
    const user = await this.requireUser(accessToken);
    const rows = await this.db
      .select({
        id: supportReports.id,
        createdAt: supportReports.createdAt,
        diagnosticsIncluded: supportReports.diagnosticsConsent,
        taskStatus: supportTasks.status,
      })
      .from(supportReports)
      .leftJoin(supportTasks, eq(supportTasks.reportId, supportReports.id))
      .where(and(eq(supportReports.reporterId, user.id)))
      .orderBy(desc(supportReports.createdAt))
      .limit(20);

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      diagnosticsIncluded: row.diagnosticsIncluded,
      automaticTask: row.taskStatus ? { status: row.taskStatus } : null,
    }));
  }

  private async requireUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken.trim()) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    try {
      return await this.resolveUser(accessToken);
    } catch (error) {
      if (error instanceof W3dsAuthError) throw error;
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
  }
}

interface NormalizedSubmitInput {
  description: string;
  includeTechnicalDetails: boolean;
  allowAutomatedAnalysis: boolean;
  technicalDiagnostics?: Record<string, unknown>;
}

function normalizeSubmitInput(input: SubmitSupportReportInput): NormalizedSubmitInput {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length < minimumDescriptionLength) {
    throw new SupportReportError(
      'Please describe the problem in at least 12 characters.',
      'invalid_report',
      400,
    );
  }
  if (description.length > maximumDescriptionLength) {
    throw new SupportReportError(
      'Please keep the report under 5,000 characters.',
      'invalid_report',
      400,
    );
  }

  const includeTechnicalDetails = input.includeTechnicalDetails === true;
  return {
    description,
    includeTechnicalDetails,
    allowAutomatedAnalysis: input.allowAutomatedAnalysis === true,
    ...(includeTechnicalDetails
      ? { technicalDiagnostics: normalizeTechnicalDiagnostics(input.technicalDiagnostics) }
      : {}),
  };
}

/**
 * Keep the persisted diagnostic payload deliberately small and structural.
 * Raw console output, URLs with queries, network response bodies, media,
 * eVault data, cookies, and authentication tokens are never accepted here.
 */
function normalizeTechnicalDiagnostics(
  input: SupportTechnicalDiagnosticsInput | undefined,
): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {};
  const record = input && typeof input === 'object' ? input : {};

  const appVersion = boundedText(record.appVersion, 80);
  if (appVersion) diagnostics.appVersion = appVersion;

  const path = boundedText(record.path, 240);
  if (path?.startsWith('/') && !/[?#\\\r\n]/.test(path)) diagnostics.path = path;

  const userAgent = boundedText(record.userAgent, 600);
  if (userAgent) diagnostics.userAgent = userAgent;

  const language = boundedText(record.language, 40);
  if (language) diagnostics.language = language;

  const timezone = boundedText(record.timezone, 80);
  if (timezone) diagnostics.timezone = timezone;

  const viewport = normalizeViewport(record.viewport);
  if (viewport) diagnostics.viewport = viewport;

  return diagnostics;
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = Array.from(value, (character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character,
  )
    .join('')
    .trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumLength);
}

function normalizeViewport(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { width?: unknown; height?: unknown };
  const width = typeof candidate.width === 'number' ? candidate.width : Number.NaN;
  const height = typeof candidate.height === 'number' ? candidate.height : Number.NaN;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width < 0 || width > 20_000 || height < 0 || height > 20_000) return undefined;
  return { width, height };
}

let supportReportService: SupportReportService | undefined;

export function getSupportReportService(): SupportReportService {
  supportReportService ??= new SupportReportService({ db: getW3dsDatabase() });
  return supportReportService;
}

/** Test helper to reset the process-wide production service. */
export function resetSupportReportServiceForTests(): void {
  supportReportService = undefined;
}
