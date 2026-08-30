'use client';

import { Button, Card, Checkbox, Page, Textarea } from '@w3ds/ui';
import { type FormEvent, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; automaticTask: boolean }
  | { status: 'error'; message: string };

export function SupportPageFeature() {
  const [description, setDescription] = useState('');
  const [includeTechnicalDetails, setIncludeTechnicalDetails] = useState(true);
  const [allowAutomatedAnalysis, setAllowAutomatedAnalysis] = useState(true);
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitState({ status: 'submitting' });
    try {
      const response = await fetch('/api/support/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          includeTechnicalDetails,
          allowAutomatedAnalysis,
          ...(includeTechnicalDetails ? { technicalDiagnostics: collectTechnicalDetails() } : {}),
        }),
      });
      const body = (await response.json()) as {
        report?: { automaticTask?: { status?: string } | null };
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? 'Your report could not be submitted. Please try again.',
        );
      }
      setDescription('');
      setSubmitState({ status: 'success', automaticTask: Boolean(body.report?.automaticTask) });
    } catch (error) {
      setSubmitState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Your report could not be submitted.',
      });
    }
  };

  return (
    <ApplicationShell currentHref="/support">
      <Page
        title="Report a problem"
        description="Tell Vidak what happened. You decide whether to include technical details and whether the report becomes an engineering task for automated analysis."
      >
        <div className="grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card elevated className="p-5 sm:p-6">
            <form className="space-y-5" onSubmit={(event) => void submit(event)}>
              <div className="space-y-2">
                <label
                  htmlFor="support-description"
                  className="text-sm font-semibold text-foreground"
                >
                  What went wrong?
                </label>
                <p className="text-sm text-muted-foreground">
                  Include what you expected, what happened instead, and the last action you took.
                </p>
                <Textarea
                  id="support-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="For example: I opened a call recording, pressed play, and the player stayed black."
                  minLength={12}
                  maxLength={5000}
                  required
                  rows={8}
                  disabled={submitState.status === 'submitting'}
                />
                <p className="text-right text-xs text-muted-foreground" aria-live="polite">
                  {description.length}/5,000
                </p>
              </div>

              <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
                <Checkbox
                  id="support-technical-details"
                  checked={includeTechnicalDetails}
                  onChange={(event) => setIncludeTechnicalDetails(event.target.checked)}
                  disabled={submitState.status === 'submitting'}
                  label="Include limited technical details"
                />
                <p className="pl-6 text-sm text-muted-foreground">
                  This adds the Vidak version, current page, browser, language, time zone, and
                  viewport. It never includes message text, videos, calls, eVault records, cookies,
                  or authentication tokens.
                </p>
                <details className="pl-6 text-sm text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-foreground">
                    See the exact technical fields
                  </summary>
                  <p className="mt-2">
                    App version, page path, browser user agent, language, time zone, and viewport
                    dimensions. No query parameters, console logs, or network payloads are sent.
                  </p>
                </details>
              </div>

              <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
                <Checkbox
                  id="support-automated-analysis"
                  checked={allowAutomatedAnalysis}
                  onChange={(event) => setAllowAutomatedAnalysis(event.target.checked)}
                  disabled={submitState.status === 'submitting'}
                  label="Allow Vidak to create a private engineering task from this report"
                />
                <p className="pl-6 text-sm text-muted-foreground">
                  When enabled, your report enters Vidak’s internal analysis queue. It is never
                  published as a public issue. Turning this off sends a private support report only.
                </p>
              </div>

              {submitState.status === 'error' ? (
                <p
                  className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground"
                  role="alert"
                >
                  {submitState.message}
                </p>
              ) : null}
              {submitState.status === 'success' ? (
                <p
                  className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-foreground"
                  role="status"
                >
                  {submitState.automaticTask
                    ? 'Thank you. A private engineering task is queued for analysis.'
                    : 'Thank you. Your report was received in Vidak’s private support queue.'}
                </p>
              ) : null}

              <Button type="submit" disabled={submitState.status === 'submitting'}>
                {submitState.status === 'submitting' ? 'Sending report…' : 'Send report'}
              </Button>
            </form>
          </Card>

          <aside className="space-y-4">
            <Card>
              <h2 className="font-semibold text-foreground">How reports are handled</h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
                <li>Your report is stored privately with your Vidak account.</li>
                <li>Only the consented fields are included in engineering analysis.</li>
                <li>Automated analysis creates a task; a fix is still tested before release.</li>
              </ol>
            </Card>
            <Card>
              <h2 className="font-semibold text-foreground">Urgent access issue?</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Include the page where the issue occurred and what you were trying to watch or
                upload. Do not paste a password, recovery phrase, token, or private link.
              </p>
            </Card>
          </aside>
        </div>
      </Page>
    </ApplicationShell>
  );
}

function collectTechnicalDetails() {
  if (typeof window === 'undefined') return {};
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? 'web',
    path: window.location.pathname,
    userAgent: window.navigator.userAgent,
    language: window.navigator.language,
    ...(timezone ? { timezone } : {}),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}
