import type { Metadata } from 'next';
import { ApplicationShell } from '../../components/application-shell';

export const metadata: Metadata = {
  title: 'Vibe-code on W3DS',
  description:
    'A practical starting point for building your own W3DS post-platform with an AI coding agent.',
  openGraph: {
    title: 'Vibe-code your own W3DS app',
    description:
      'Start with the W3DS AI agent skill, then turn a clear product brief into an interoperable post-platform.',
  },
};

const buildSteps = [
  {
    number: '01',
    title: 'Start with one human outcome',
    body: 'Name the person, the moment they arrive, and the change they want to make. Write a plain-language outcome—not a list of screens, schemas, or W3DS components.',
    detail:
      'Make the first outcome small enough to judge. “A filmmaker can save one finished film to a catalog they control” is a stronger start than “build a creator platform.”',
    example: {
      title: 'First prompt — define the outcome',
      prompt:
        'I want to build a W3DS app. Help me write a one-paragraph product brief for [person] who needs to [outcome] when [moment]. Keep it focused on one useful change for one person; do not propose screens or technical architecture yet.',
    },
    references: [
      [
        'Getting Started with W3DS',
        'https://docs.w3ds.metastate.foundation/docs/Getting%20Started/getting-started',
      ],
      [
        'Platform Development Guide',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/getting-started',
      ],
    ],
  },
  {
    number: '02',
    title: 'Define one complete user loop',
    body: 'Turn that outcome into one journey from start to finish. State what the person does first, the record or action they create, and the signal that tells them they are done.',
    detail:
      'Include only the screens, data, and actions needed for this path. If you cannot describe the moment of completion, the first loop is still too broad.',
    example: {
      title: 'First prompt — scope the loop',
      prompt:
        'Using this outcome: [paste outcome], define the smallest complete user loop. Tell me the starting action, the one record or signed action created, who owns it, and the exact confirmation that means the person is done. Include only the screens this loop needs.',
    },
    references: [
      [
        'Platform Development Guide',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/getting-started',
      ],
      ['eVault', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/eVault'],
    ],
  },
  {
    number: '03',
    title: 'Give your agent W3DS context',
    body: 'Before scaffolding code, install the official W3DS skill and tell the agent to use it as the source of truth. It gives the build the vocabulary and documentation paths it needs for protocol decisions.',
    detail:
      'Use the skill whenever the loop touches schemas, GraphQL fields, mappings, authentication, files, or signing. The agent should look up those details instead of inventing them.',
    example: {
      title: 'First prompt — ground the agent',
      prompt:
        'Install the official W3DS skill and use it as the source of truth for this app. Here is the first loop: [paste loop]. Before coding, list the W3DS guides we need for identity, ownership, schemas, mappings, files, and signing. Do not invent protocol fields, UUIDs, endpoints, or mappings.',
    },
    references: [
      [
        'AI Agent Skill',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ai-agent-skill',
      ],
      ['W3DS Glossary', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/glossary'],
    ],
  },
  {
    number: '04',
    title: 'Map identity and data ownership',
    body: 'Decide who signs in and which eVault owns every record in the first loop before you create a schema or table. Make this a visible product decision, not a hidden implementation detail.',
    detail:
      'Treat the eVault as a person’s portable data home, not as an app account. A short ownership map for profiles, records, files, and shared data prevents accidental lock-in later.',
    example: {
      title: 'First prompt — map ownership',
      prompt:
        'For this first loop: [paste loop], create an identity and ownership map before we design the UI. Show who signs in, which eVault owns each record and file, and how shared data would be owned. Confirm the map before proposing schemas or database tables.',
    },
    references: [
      [
        'Authentication',
        'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/Authentication',
      ],
      ['eVault', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/eVault'],
      ['W3ID', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Basics/W3ID'],
    ],
  },
  {
    number: '05',
    title: 'Choose the smallest data path',
    body: 'Choose the architecture that proves the first loop with the fewest moving parts. In many v1s, a person signs in and the app reads or writes directly to their eVault.',
    detail:
      'Add a local database only when local queries, existing systems, or product logic truly require it. When you add one, define the mapping, Web3 Adapter, and webhook path that keep it aligned with user-owned data.',
    example: {
      title: 'First prompt — choose the architecture',
      prompt:
        'Recommend the smallest W3DS architecture for this first loop: [paste loop and ownership map]. Start with direct eVault reads and writes unless there is a concrete reason for local data. If a local database is needed, explain the mapping, Web3 Adapter, and webhook responsibilities.',
    },
    references: [
      ['eVault', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/eVault'],
      ['Web3 Adapter', 'https://docs.w3ds.metastate.foundation/docs/Infrastructure/Web3-Adapter'],
      [
        'Mapping Rules',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/mapping-rules',
      ],
    ],
  },
  {
    number: '06',
    title: 'Build and prove the first loop',
    body: 'Build only the happy path, then exercise it with a real W3DS test identity in the Dev Sandbox. Sign in, create the record or action, approve the signed write, and read the result back.',
    detail:
      'This proves the protocol boundary—not just a mocked browser flow. If you use synchronization, replay the same webhook packet twice and confirm the local state remains correct.',
    example: {
      title: 'First prompt — build and verify',
      prompt:
        'Turn this first loop into an implementation plan and acceptance test: [paste loop, ownership map, and architecture]. Build only the happy path. In the Dev Sandbox, sign in with a test identity, create the record, approve the signed write, read it back, and report the result. If sync is included, test an idempotent webhook replay.',
    },
    references: [
      [
        'Using the Dev Sandbox',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/dev-sandbox',
      ],
      ['Signing', 'https://docs.w3ds.metastate.foundation/docs/W3DS%20Protocol/Signing'],
      [
        'Webhook Controller Guide',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/webhook-controller',
      ],
    ],
  },
] as const;

const referenceGroups = [
  {
    title: 'Start with the platform',
    description: 'Orientation, agent context, platform setup, and a safe local feedback loop.',
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
    title: 'Move and model data',
    description:
      'User-owned storage, schemas, mappings, files, and synchronization between platforms.',
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
    title: 'Identity, wallets, and trusted actions',
    description:
      'Sign people in, work with their identities and keys, and verify important actions.',
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
    title: 'A concrete domain example',
    description: 'Use this when your product needs accounts, ledgers, or currency-oriented data.',
    docs: [
      [
        'eCurrency: Accounts and Ledger MetaEnvelopes',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ecurrency-accounts-and-ledger',
      ],
    ],
  },
] as const;

const starterPrompt = `Use the installed W3DS skill as the source of truth while we build this app.

Build a focused post-platform for [people] to [complete a valuable action].
The first version should let a person [primary outcome] and should feel [three experience qualities].

Before writing code, propose:
1. the smallest user journey that proves the idea;
2. the user-owned data this journey creates and which eVault owns it;
3. whether the app can write directly to eVaults or needs a local database plus Web3 Adapter;
4. the W3DS documents we must consult for auth, schemas, mapping, sync, files, or signing.

Do not invent ontology UUIDs, GraphQL fields, mapping directives, or W3DS endpoints. Look them up in the installed skill and linked docs. Build the happy path first, include a test plan using the Dev Sandbox, then show the next three implementation steps.`;

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
            <div className="grid items-center gap-12 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <div className="min-w-0">
                <p className="mb-5 inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-xs font-semibold tracking-[0.14em] text-primary uppercase">
                  Build in the open. Own the data.
                </p>
                <h1 className="max-w-3xl text-4xl font-black tracking-[-0.045em] text-foreground sm:text-6xl lg:text-7xl">
                  Vibe-code your own app on W3DS.
                </h1>
                <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
                  Take a clear idea, give your AI coding agent the W3DS skill, and create an app
                  where people keep control of the data they make.
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <a
                    href="#start"
                    className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 font-semibold text-primary-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    Start building{' '}
                    <span className="ml-2" aria-hidden="true">
                      ↓
                    </span>
                  </a>
                  <a
                    href="#reference"
                    className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-surface px-5 font-semibold text-foreground transition hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    Explore all W3DS docs
                  </a>
                </div>
                <p className="mt-5 text-sm text-muted-foreground">
                  Start small. You can ship a useful W3DS-native experience before you need every
                  protocol in the ecosystem.
                </p>
              </div>

              <div className="relative mx-auto min-w-0 w-full max-w-xl rounded-2xl border border-border bg-surface p-4 shadow-2xl shadow-primary/10 sm:p-6">
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <div className="flex gap-1.5" aria-hidden="true">
                    <span className="size-2.5 rounded-full bg-danger" />
                    <span className="size-2.5 rounded-full bg-warning" />
                    <span className="size-2.5 rounded-full bg-success" />
                  </div>
                  <p className="font-mono text-[0.7rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    your next build
                  </p>
                </div>
                <div className="space-y-4 py-5 font-mono text-sm leading-6">
                  <p className="text-muted-foreground">01 — Name the change you want to make.</p>
                  <p className="rounded-lg border border-primary/20 bg-primary/10 p-3 text-foreground">
                    &gt; Help independent filmmakers publish work, keep their catalog portable, and
                    find collaborators.
                  </p>
                  <p className="text-muted-foreground">
                    02 — Let the W3DS skill shape the foundation.
                  </p>
                  <p className="rounded-lg border border-border bg-background p-3 text-foreground">
                    ✓ identity &amp; eVault ownership
                    <br />✓ shared ontology &amp; files
                    <br />✓ sync only where it serves the product
                  </p>
                  <p className="text-primary">03 — Build the smallest real loop. Ship it. Learn.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="start" className="scroll-mt-8 bg-surface px-5 py-16 sm:px-8 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary uppercase">
                Your path from spark to app
              </p>
              <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                Follow the product, then let the protocol support it.
              </h2>
              <p className="mt-5 text-lg leading-8 text-muted-foreground">
                W3DS is most powerful when it stays connected to a human outcome. Use this sequence
                to keep your build intentional, fast, and interoperable.
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
                  <nav
                    className="mt-4 flex flex-wrap gap-x-4 gap-y-2"
                    aria-label="Related W3DS documentation"
                  >
                    {step.references.map(([title, href]) => (
                      <a
                        key={href}
                        className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Read: {title} <Arrow />
                      </a>
                    ))}
                  </nav>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-y border-border bg-background px-5 py-16 sm:px-8 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-10 xl:grid-cols-[0.8fr_1.2fr] xl:gap-16">
            <div>
              <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary uppercase">
                One command, then one good brief
              </p>
              <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                Give your agent a map before asking it to build.
              </h2>
              <p className="mt-5 text-lg leading-8 text-muted-foreground">
                The official W3DS skill is the shortcut from generic code generation to informed
                collaboration. It tells your agent where to find the precise W3DS details when they
                matter.
              </p>
              <a
                className="mt-7 inline-flex items-center gap-2 font-semibold text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
                href="https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ai-agent-skill"
                target="_blank"
                rel="noreferrer"
              >
                Read the AI Agent Skill guide <Arrow />
              </a>
            </div>

            <div className="space-y-5">
              <div className="overflow-hidden rounded-xl border border-border bg-surface">
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                  <p className="font-mono text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase">
                    1. Add the W3DS skill
                  </p>
                  <span className="rounded bg-primary/10 px-2 py-1 font-mono text-xs font-bold text-primary">
                    terminal
                  </span>
                </div>
                <pre className="overflow-x-auto p-5 font-mono text-sm leading-7 text-foreground">
                  <code>npx skills add MetaState-Prototype-Project/prototype@w3ds -a codex</code>
                </pre>
              </div>
              <div className="overflow-hidden rounded-xl border border-border bg-surface">
                <div className="border-b border-border px-5 py-3">
                  <p className="font-mono text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase">
                    2. Use this starter brief
                  </p>
                </div>
                <pre className="max-h-[29rem] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-6 text-foreground sm:text-sm">
                  <code>{starterPrompt}</code>
                </pre>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-surface px-5 py-16 sm:px-8 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-8 xl:grid-cols-[0.75fr_1.25fr] xl:items-end">
              <div>
                <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary uppercase">
                  A useful decision point
                </p>
                <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                  Stateless first, sync when it earns its place.
                </h2>
              </div>
              <p className="text-lg leading-8 text-muted-foreground">
                A post-platform can be intentionally lightweight: write directly to user eVaults and
                keep no app-owned copy of their data. If your product needs a local database, use
                mappings, the Web3 Adapter, and an idempotent webhook controller to keep the two
                worlds aligned.
              </p>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2">
              <article className="rounded-xl border border-success/30 bg-success/10 p-6">
                <p className="font-mono text-xs font-bold tracking-[0.12em] text-success uppercase">
                  Direct-to-eVault app
                </p>
                <h3 className="mt-4 text-2xl font-bold text-foreground">
                  Keep the first version lean.
                </h3>
                <p className="mt-3 leading-7 text-foreground">
                  A strong fit for personal tools, publishing experiences, and new ideas where
                  portability and ownership are the main value.
                </p>
                <p className="mt-5 text-sm leading-6 text-muted-foreground">
                  Focus on the user flow, authentication, the right ontology, eVault reads and
                  writes, and any needed file or signing flow.
                </p>
              </article>
              <article className="rounded-xl border border-primary/30 bg-primary/10 p-6">
                <p className="font-mono text-xs font-bold tracking-[0.12em] text-primary uppercase">
                  Local database + sync
                </p>
                <h3 className="mt-4 text-2xl font-bold text-foreground">
                  Use it when local speed or logic matters.
                </h3>
                <p className="mt-3 leading-7 text-foreground">
                  A strong fit for apps that need a local projection, complex queries, existing
                  data, or domain-specific workflows that must stay in sync with eVault data.
                </p>
                <p className="mt-5 text-sm leading-6 text-muted-foreground">
                  Add mappings, the Web3 Adapter, change handling, and webhook upserts keyed by a
                  stable global ID.
                </p>
              </article>
            </div>
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
                  Every guide from the Vidak docs, sorted by the question you have.
                </h2>
                <p className="mt-5 text-lg leading-8 text-muted-foreground">
                  Open the document your agent needs at the moment it needs it. Each link leads to
                  the official W3DS documentation used to shape this page.
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

        <section className="bg-primary px-5 py-16 text-primary-foreground sm:px-8">
          <div className="mx-auto flex max-w-6xl flex-col justify-between gap-8 md:flex-row md:items-center">
            <div className="max-w-3xl">
              <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary-foreground/75 uppercase">
                Your next move
              </p>
              <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] sm:text-5xl">
                Start with one real problem worth solving.
              </h2>
              <p className="mt-4 text-lg leading-8 text-primary-foreground/85">
                Give your agent the context, make data ownership part of the product idea, and build
                the smallest app that lets someone feel the difference.
              </p>
            </div>
            <a
              href="#start"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-primary-foreground px-5 font-semibold text-primary transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
            >
              Build your first loop{' '}
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
