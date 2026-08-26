import type { Metadata } from 'next';
import { ApplicationShell } from '../../components/application-shell';

export const metadata: Metadata = {
  title: 'Build an app on W3DS',
  description: 'A clear, step-by-step guide to building an app on W3DS with a coding agent.',
  openGraph: {
    title: 'Build your own W3DS app',
    description: 'Use six simple prompts to turn an idea into a working W3DS app.',
  },
};

const buildSteps = [
  {
    number: '01',
    title: 'Install the W3DS skill',
    body: 'Add the W3DS skill to the project before you plan the app.',
    detail: 'It gives your coding agent the W3DS docs it needs to make informed decisions.',
    example: {
      title: 'Prompt 1 — send this first',
      prompt:
        'Run this command in the project: npx skills add MetaState-Prototype-Project/prototype@w3ds. When it finishes, confirm that the W3DS skill is available.',
    },
  },
  {
    number: '02',
    title: 'Use the skill before you code',
    body: 'Tell the agent to check the W3DS skill before it writes W3DS code or configuration.',
    detail: 'It should look up details in the docs instead of guessing values or endpoints.',
    example: {
      title: 'Prompt 2 — send after prompt 1',
      prompt:
        'Use the installed W3DS skill as the source of truth for this project. Before writing W3DS code or configuration, load the relevant references. Do not guess ontology IDs, GraphQL fields, mapping rules, signatures, or endpoints.',
    },
  },
  {
    number: '03',
    title: 'Name one user outcome',
    body: 'Describe one person, one moment, and one useful result for the first version.',
    detail: 'Keep it to one finished user journey, not a list of features.',
    example: {
      title: 'Prompt 3 — send after prompt 2',
      prompt:
        'I want to build [app] for [person], who needs to [outcome] when [moment]. Define one complete first journey: what they do first, what they create, and how they know it worked. Do not choose screens, APIs, or schemas yet.',
    },
  },
  {
    number: '04',
    title: 'Load the right references',
    body: 'Ask the agent to load only the W3DS docs this first journey needs.',
    detail: 'Start with the relevant identity, eVault, data, signing, or sync guides.',
    example: {
      title: 'Prompt 4 — send after prompt 3',
      prompt:
        'For this first journey: [paste prompt 3], identify the W3DS topics involved and load the relevant skill references before recommending an implementation. If the docs do not answer a question, say so instead of guessing.',
    },
  },
  {
    number: '05',
    title: 'Choose the smallest data path',
    body: 'Pick the simplest data setup that makes the first journey work.',
    detail:
      'Start with user-owned eVault data. Add a local database and sync only when there is a clear need.',
    example: {
      title: 'Prompt 5 — send after prompt 4',
      prompt:
        'Using this journey and the loaded W3DS references, recommend the smallest data path. Show who signs in, who owns each record or file, and whether direct eVault reads and writes are enough. Add a local database only if it solves a specific need.',
    },
  },
  {
    number: '06',
    title: 'Build and test the first journey',
    body: 'Build only the approved happy path, then test it with a real W3DS test identity.',
    detail:
      'Check sign-in, the write, and the read-back. If you use sync, test the same change twice.',
    example: {
      title: 'Prompt 6 — send after prompt 5',
      prompt:
        'Implement the approved first journey. Use the Dev Sandbox to sign in with a test identity, make the write or signed action, and read the result back. If the app synchronizes data, replay the same webhook change and confirm the result stays correct.',
    },
  },
] as const;

const referenceGroups = [
  {
    title: 'Start here',
    description: 'Skill setup, platform basics, and local testing.',
    docs: [
      [
        'AI Agent Skill',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ai-agent-skill',
      ],
      [
        'Getting Started with W3DS',
        'https://docs.w3ds.metastate.foundation/docs/Getting%20Started/getting-started',
      ],
      ['W3DS Basics', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/getting-started'],
      ['Glossary', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/glossary'],
      [
        'Getting Started with Platform Development',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/getting-started',
      ],
      [
        'Local Dev Quick Start',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/local-dev-quick-start',
      ],
      [
        'Using the Dev Sandbox',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/dev-sandbox',
      ],
      [
        'Registering a Platform eVault',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/platform-evault-registration',
      ],
    ],
  },
  {
    title: 'Data and sync',
    description: 'eVaults, schemas, files, mappings, and webhooks.',
    docs: [
      ['eVault', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/eVault'],
      ['Ontology', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/Ontology'],
      ['Registry', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/Registry'],
      ['Web3 Adapter', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/Web3-Adapter'],
      [
        'Mapping Rules',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/mapping-rules',
      ],
      [
        'Webhook Controller Guide',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/webhook-controller',
      ],
      [
        'Awareness Protocol',
        'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/Awareness-Protocol',
      ],
      [
        'Awareness as a Service (AaaS)',
        'https://docs.w3ds.metastate.foundation/docs/Services/Awareness-as-a-Service',
      ],
      ['File URIs', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/File-URIs'],
    ],
  },
  {
    title: 'Identity and signing',
    description: 'Sign people in, work with identity, and approve important actions.',
    docs: [
      [
        'Authentication',
        'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/Authentication',
      ],
      ['Signing', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/Signing'],
      [
        'Signature Formats',
        'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/Signature-Formats',
      ],
      ['W3ID', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/W3ID'],
      ['eName', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/eName'],
      [
        'Binding Documents',
        'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/Binding-Documents',
      ],
      ['eID Wallet', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/eID-Wallet'],
      ['wallet-sdk', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/wallet-sdk'],
      [
        'eVault Key Delegation',
        'https://docs.w3ds.metastate.foundation/docs/Infrastructure/eVault-Key-Delegation',
      ],
    ],
  },
  {
    title: 'Money and ledgers',
    description: 'Use this for accounts, balances, or currency data.',
    docs: [
      [
        'eCurrency: Accounts and Ledger MetaEnvelopes',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ecurrency-accounts-and-ledger',
      ],
    ],
  },
] as const;

const whatIfs = [
  {
    number: '01',
    category: 'Getting started',
    question: 'What if my agent guesses a W3DS detail?',
    answer:
      'Pause the task. Ask it to check the W3DS skill and name the guide it used before it chooses an ID, field, mapping rule, or endpoint.',
  },
  {
    number: '02',
    category: 'Getting started',
    question: 'What if my first version keeps getting bigger?',
    answer:
      'Return to one person, one moment, and one outcome. Keep only the work needed to finish that first journey.',
  },
  {
    number: '03',
    category: 'Data',
    question: 'What if I do not know who owns a record?',
    answer:
      'Make a simple ownership map before you design a schema: who signs in, which eVault owns each record or file, and how shared data works.',
  },
  {
    number: '04',
    category: 'Data',
    question: 'What if I am unsure about a local database?',
    answer:
      'Start with direct eVault reads and writes. Add local data only for a clear need, such as local search, an existing system, or product logic.',
  },
  {
    number: '05',
    category: 'Testing',
    question: 'What if sign-in or a write does not finish?',
    answer:
      'Test the full path in the Dev Sandbox: sign in, approve the action, and read the result back. Fix the first step that fails.',
  },
  {
    number: '06',
    category: 'Sync',
    question: 'What if the same change arrives twice?',
    answer:
      'Use a stable record or event ID and update existing data instead of creating a duplicate. Replay the same change in a test.',
  },
  {
    number: '07',
    category: 'Release',
    question: 'What if the production build fails?',
    answer:
      'Fix the first reported error, then rebuild. Do not publish until the build, service, and readiness check all pass.',
  },
  {
    number: '08',
    category: 'Release',
    question: 'What if the live site still shows the old version?',
    answer:
      'Check which server the public domain uses, confirm the deployed revision, then refresh the page after the new version is ready.',
  },
] as const;

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function CreateAnAppPage() {
  return (
    <ApplicationShell>
      <main className="overflow-hidden">
        <section className="relative isolate border-b border-border bg-background">
          <div className="absolute inset-x-0 top-0 -z-10 h-[30rem] bg-[radial-gradient(ellipse_at_top,_var(--w3ds-color-primary)_0%,_transparent_62%)] opacity-15" />
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
            <div className="max-w-3xl">
              <h1 className="max-w-3xl text-4xl font-black tracking-[-0.045em] text-foreground sm:text-6xl lg:text-7xl">
                Build your app on W3DS.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
                Start with a clear idea. Give your coding agent the W3DS skill, then build an app
                where people keep control of their data.
              </p>
            </div>
          </div>
        </section>

        <section id="start" className="scroll-mt-8 bg-surface px-5 py-16 sm:px-8 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                Step-by-step instruction
              </h2>
              <p className="mt-5 text-lg leading-8 text-muted-foreground">
                Follow these six prompts in order. They keep your first app clear, small, and
                interoperable.
              </p>
            </div>

            <ol className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {buildSteps.map((step) => (
                <li key={step.number} className="rounded-xl border border-border bg-background p-6">
                  <p className="font-mono text-sm font-bold text-primary">{step.number}</p>
                  <h3 className="mt-5 text-xl font-bold text-foreground">{step.title}</h3>
                  <p className="mt-3 leading-7 text-foreground">{step.body}</p>
                  <p className="mt-4 border-t border-border pt-4 text-sm leading-6 text-muted-foreground">
                    {step.detail}
                  </p>
                  <details className="group mt-5 overflow-hidden rounded-lg border border-primary/25 bg-primary/5">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset">
                      <span>{step.example.title}</span>
                      <span
                        aria-hidden="true"
                        className="shrink-0 text-base transition-transform group-open:rotate-180"
                      >
                        ↓
                      </span>
                    </summary>
                    <div className="border-t border-primary/20 bg-background/70 px-4 py-4">
                      <p className="text-sm leading-6 text-muted-foreground">
                        Copy and adapt this prompt for your coding agent:
                      </p>
                      <blockquote className="mt-3 border-l-2 border-primary/50 pl-3 text-sm leading-6 text-foreground">
                        {step.example.prompt}
                      </blockquote>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="what-if"
          className="scroll-mt-8 border-y border-border bg-background px-5 py-16 sm:px-8 sm:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <div className="max-w-3xl">
              <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary uppercase">
                Quick fixes
              </p>
              <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                What if something went wrong?
              </h2>
              <p className="mt-5 text-lg leading-8 text-muted-foreground">
                Eight common problems and the next simple move. Open the one that matches what you
                see.
              </p>
            </div>

            <ol className="mt-12 grid gap-4 lg:grid-cols-2">
              {whatIfs.map((item) => (
                <li key={item.number}>
                  <details className="group h-full overflow-hidden rounded-xl border border-border bg-surface">
                    <summary className="flex min-h-20 cursor-pointer list-none items-center gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset">
                      <span className="font-mono text-sm font-bold text-primary">
                        {item.number}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-[0.65rem] font-bold tracking-[0.12em] text-muted-foreground uppercase">
                          {item.category}
                        </span>
                        <span className="mt-1 block text-base font-bold leading-6 text-foreground sm:text-lg">
                          {item.question}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="shrink-0 text-lg text-primary transition-transform group-open:rotate-180"
                      >
                        ↓
                      </span>
                    </summary>
                    <div className="border-t border-border bg-background/70 px-5 py-5">
                      <p className="leading-7 text-muted-foreground">{item.answer}</p>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="reference"
          className="scroll-mt-8 border-t border-border bg-background px-5 py-16 sm:px-8 sm:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
              <div className="max-w-3xl">
                <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary uppercase">
                  The full W3DS reference shelf
                </p>
                <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                  Every guide from the W3DS docs, sorted by the question you may have.
                </h2>
                <p className="mt-5 text-lg leading-8 text-muted-foreground">
                  Open only the guide your next step needs. Every link leads to the official W3DS
                  docs.
                </p>
              </div>
              <a
                className="shrink-0 font-semibold text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
                href="https://github.com/serobkhachatryan-cpu/vidak/tree/develop/docs"
                target="_blank"
                rel="noreferrer"
              >
                View the source library <Arrow />
              </a>
            </div>

            <div className="mt-12 grid gap-5 lg:grid-cols-2">
              {referenceGroups.map((group) => (
                <section
                  key={group.title}
                  className="rounded-xl border border-border bg-surface p-6"
                >
                  <h3 className="text-xl font-bold text-foreground">{group.title}</h3>
                  <p className="mt-2 leading-6 text-muted-foreground">{group.description}</p>
                  <ul
                    className="mt-5 grid gap-2 sm:grid-cols-2"
                    aria-label={`${group.title} W3DS documentation`}
                  >
                    {group.docs.map(([title, href]) => (
                      <li key={href}>
                        <a
                          className="group flex min-h-10 items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>{title}</span>
                          <span
                            className="text-muted-foreground transition group-hover:text-primary"
                            aria-hidden="true"
                          >
                            ↗
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-primary px-5 py-8 text-primary-foreground sm:px-8">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-2xl font-bold tracking-[-0.03em]">Ready to build?</p>
            <a
              href="#start"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-primary-foreground px-5 font-semibold text-primary transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
            >
              Start at step 1
              <span className="ml-2" aria-hidden="true">
                ↑
              </span>
            </a>
          </div>
        </section>
      </main>
    </ApplicationShell>
  );
}
