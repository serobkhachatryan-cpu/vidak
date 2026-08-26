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
    title: 'Install the official W3DS skill',
    body: 'Start in the same project your coding agent will build. Add the W3DS knowledge skill before you discuss screens, schemas, or implementation decisions.',
    detail:
      'This is the whole first move. The skill gives the agent its W3DS map and the reference files it needs for protocol decisions.',
    example: {
      title: 'Prompt 1 — send this first',
      prompt:
        'Run this command in the project: npx skills add MetaState-Prototype-Project/prototype@w3ds. When it is complete, confirm that you can use the installed W3DS skill and its reference files.',
    },
    references: [
      [
        'AI Agent Skill',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ai-agent-skill',
      ],
      [
        'W3DS skill source',
        'https://github.com/MetaState-Prototype-Project/prototype/tree/main/skills/w3ds',
      ],
    ],
  },
  {
    number: '02',
    title: 'Make the skill your source of truth',
    body: 'Tell the agent how to use its new context: it must load the relevant W3DS reference before writing W3DS code or configuration, rather than relying on memory.',
    detail:
      'Ontology IDs, GraphQL fields, mapping directives, signature formats, and endpoint paths must be looked up. If a reference does not answer a question, the agent should search the W3DS docs before deciding.',
    example: {
      title: 'Prompt 2 — send after prompt 1',
      prompt:
        'The W3DS skill is installed. Use it as the source of truth for this project. Before you write W3DS code or configuration, load the relevant reference files. Do not invent ontology IDs, GraphQL fields, mapping directives, signatures, or endpoint paths. Confirm this working rule.',
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
    number: '03',
    title: 'Describe one human outcome',
    body: 'Give the agent one person, one moment, and one useful outcome for the first release. Keep this in product language so the W3DS work serves a real job.',
    detail:
      'Ask for a single finished loop, not a feature list. The first loop should make clear what a person does, what data or signed action it creates, and how they know it worked.',
    example: {
      title: 'Prompt 3 — send after prompt 2',
      prompt:
        'I want to build [app] for [person], who needs to [outcome] when [moment]. Help me define one complete first loop: the starting action, the data or signed action it creates, and the confirmation that means the person is done. Do not choose APIs, schemas, or screens yet.',
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
    number: '04',
    title: 'Load the references for that loop',
    body: 'Now have the agent translate the first loop into the W3DS questions it must answer: identity, eVault data, schemas, files, signing, or synchronization.',
    detail:
      'The skill routes each topic to the right source. For a platform build, load the two or three relevant references together before making technical recommendations.',
    example: {
      title: 'Prompt 4 — send after prompt 3',
      prompt:
        'For this first loop: [paste the result from prompt 3], identify the W3DS topics involved and load the two or three relevant skill references before recommending an implementation. Explain which references cover identity, eVault data, platform mapping, files, signing, or webhooks for this loop. If you are unsure, search the W3DS docs instead of inferring.',
    },
    references: [
      [
        'AI Agent Skill',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/ai-agent-skill',
      ],
      [
        'Platform Development Guide',
        'https://docs.w3ds.metastate.foundation/docs/Post%20Platform%20Guide/getting-started',
      ],
    ],
  },
  {
    number: '05',
    title: 'Choose the smallest W3DS data path',
    body: 'With the sources loaded, choose the simplest architecture that proves the first loop. Start with user-owned eVault data; add a local projection only when the product has a concrete need for one.',
    detail:
      'A local projection requires an explicit mapping, Web3 Adapter, and webhook path. The agent should also show who owns each record and how the app resolves the right eVault before it makes a request.',
    example: {
      title: 'Prompt 5 — send after prompt 4',
      prompt:
        'Using the loaded W3DS references and this first loop: [paste the results from prompts 3 and 4], recommend the smallest real data path. Show who signs in, which eVault owns each record or file, and whether direct eVault reads and writes are enough. If a local database is truly needed, define its mapping, Web3 Adapter, and webhook responsibilities. Cite the source reference for every protocol decision.',
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
    title: 'Build and verify the real loop',
    body: 'Implement only the approved happy path, then test the W3DS protocol boundary with a real test identity in the Dev Sandbox—not only a mocked browser flow.',
    detail:
      'Confirm the eVault path, authentication or signing, write, and read-back. If the app synchronizes data, prove that the webhook controller is idempotent by safely replaying the same change.',
    example: {
      title: 'Prompt 6 — send after prompt 5',
      prompt:
        'Implement the approved first loop from prompts 3–5. Before using any W3DS protocol value, load its source reference. In the Dev Sandbox, verify the real flow: authenticate the test identity, resolve the correct eVault, perform the write or signed action, and read the result back. If synchronization is included, replay the same webhook change and prove the local result stays correct. Report the references and test results.',
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

const whatIfs = [
  {
    number: '01',
    category: 'Product and agent',
    question: 'What if my agent starts inventing W3DS IDs, fields, or endpoints?',
    answer:
      'Stop the implementation task. Tell the agent to use the W3DS skill as its source of truth and to cite the exact guide before it chooses a protocol value. Never accept a made-up UUID, GraphQL field, mapping, or endpoint just to keep moving.',
  },
  {
    number: '02',
    category: 'Product and agent',
    question: 'What if my app idea keeps turning into a list of features?',
    answer:
      'Return to one person, one moment, and one outcome. Write the smallest complete loop that proves the value, then postpone every screen or capability that is not needed to finish that loop.',
  },
  {
    number: '03',
    category: 'Product and agent',
    question: 'What if I do not know which eVault owns a record?',
    answer:
      'Make an ownership map before creating a schema: who signs in, who owns each record and file, and how shared data is owned. Treat the eVault as the person’s portable data home, not as an app account.',
  },
  {
    number: '04',
    category: 'Product and agent',
    question: 'What if I cannot tell whether I need a local database?',
    answer:
      'Start with direct eVault reads and writes when that proves the first loop. Add a local projection only for a concrete need such as fast local search, existing system integration, or product logic that cannot run from eVault data alone.',
  },
  {
    number: '05',
    category: 'Protocol and data',
    question: 'What if I need an official W3DS write path before setup is ready?',
    answer:
      'Keep the path feature-gated and fail closed. Validate the required configuration, schema, and sandbox flow first; do not turn on official writes merely because a UI is ready to call them.',
  },
  {
    number: '06',
    category: 'Protocol and data',
    question: 'What if sign-in works locally but fails in production?',
    answer:
      'Compare the effective non-secret auth configuration at build time and runtime. Public client settings are baked into the production bundle, so rebuild with the intended production configuration and verify the provider before restarting.',
  },
  {
    number: '07',
    category: 'Protocol and data',
    question: 'What if a signed action never finishes publishing?',
    answer:
      'Check the flow in order: action creation, user approval, callback or session completion, and the final read-back. Test the same path with a Dev Sandbox identity before changing production behavior.',
  },
  {
    number: '08',
    category: 'Protocol and data',
    question: 'What if a webhook arrives but the app does not update?',
    answer:
      'Record the inbound outcome, then check schema admission, mapping, readiness, and the handler’s result. A successful HTTP delivery only proves the packet arrived; it does not prove the app accepted and applied it.',
  },
  {
    number: '09',
    category: 'Protocol and data',
    question: 'What if the same webhook is delivered twice?',
    answer:
      'Make the handler idempotent. Store a receipt or use a stable event or record ID, upsert instead of blindly inserting, and replay the packet in a test until the local result stays exactly the same.',
  },
  {
    number: '10',
    category: 'Protocol and data',
    question: 'What if data is in the eVault but the local view is stale?',
    answer:
      'A local database needs an explicit projection strategy: mapping rules, a change handler, and a webhook path that updates the local record by stable global ID. Do not assume a local copy will synchronize on its own.',
  },
  {
    number: '11',
    category: 'Protocol and data',
    question: 'What if a file is linked but media cannot be shown or played?',
    answer:
      'Verify the File URI mapping, asset metadata, and content-retrieval path separately. Start with a small known file and confirm the app can write, read, and render it before adding larger media workflows.',
  },
  {
    number: '12',
    category: 'Protocol and data',
    question: 'What if the original thumbnail or media bytes are gone?',
    answer:
      'Do not promise a technical recovery that does not exist. Preserve the record and metadata, then re-upload the asset from a known original and verify the new storage reference end to end.',
  },
  {
    number: '13',
    category: 'Release and recovery',
    question: 'What if the app works locally but the production build fails?',
    answer:
      'Run the actual production build in a clean, production-like environment and fix the first reported failure. Treat route type errors, missing runtime files, and bundler differences as release blockers rather than browser-only problems.',
  },
  {
    number: '14',
    category: 'Release and recovery',
    question: 'What if a migration fails or production starts with the wrong schema?',
    answer:
      'Stop the release, preserve the existing data, and run the safe migration procedure before restarting the app. A release is complete only when the migration, build, service status, and readiness check all succeed.',
  },
  {
    number: '15',
    category: 'Release and recovery',
    question: 'What if Git cannot fast-forward the production checkout?',
    answer:
      'Stop instead of forcing the branch. Compare the deployed SHA with the intended SHA, confirm whether the history is safe to fast-forward, and resolve the divergence deliberately without rewriting the production checkout.',
  },
  {
    number: '16',
    category: 'Release and recovery',
    question: 'What if a generated build file makes the checkout look dirty?',
    answer:
      'Identify the exact generated file before doing anything. Keep generated drift out of commits, preserve intentional server-only configuration, and clean or regenerate only the known artifact—not the whole working tree.',
  },
  {
    number: '17',
    category: 'Release and recovery',
    question: 'What if a deployment succeeds but the custom domain shows the old app?',
    answer:
      'Verify which host actually serves the custom domain. A successful CI or platform deployment does not update a separate VPS or proxy automatically; check the deployed SHA and page response at the public hostname.',
  },
  {
    number: '18',
    category: 'Release and recovery',
    question: 'What if the server has the new commit but my browser still shows old content?',
    answer:
      'Verify the rendered page with a revision query or response check, then hard-refresh the browser. Confirming the public HTML prevents a cache issue from being mistaken for a failed deployment.',
  },
  {
    number: '19',
    category: 'Release and recovery',
    question: 'What if a small UI change accidentally creates a second header or flow?',
    answer:
      'Inspect the shared layout and existing components first. Make the smallest possible change in the real shell, then test the affected route so a new page-level component does not duplicate established navigation or behavior.',
  },
  {
    number: '20',
    category: 'Release and recovery',
    question: 'What if my coding tool loses context or a long task stalls?',
    answer:
      'Start a bounded follow-up with the current commit SHA, the exact goal, constraints, and checks to run. Ask it to inspect first, change one concern at a time, and report the deployed revision and verification result.',
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
                  <p className="text-muted-foreground">01 — Install the official W3DS skill.</p>
                  <p className="rounded-lg border border-primary/20 bg-primary/10 p-3 text-foreground">
                    &gt; npx skills add MetaState-Prototype-Project/prototype@w3ds
                  </p>
                  <p className="text-muted-foreground">02 — Make the skill your source of truth.</p>
                  <p className="rounded-lg border border-border bg-background p-3 text-foreground">
                    ✓ load the relevant W3DS references before code
                    <br />✓ look up, never guess, protocol values
                    <br />✓ define one human outcome and first loop
                  </p>
                  <p className="text-primary">
                    03 — Load the right references. Build and prove the loop.
                  </p>
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
                  <code>npx skills add MetaState-Prototype-Project/prototype@w3ds</code>
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
          id="what-if"
          className="scroll-mt-8 border-y border-border bg-background px-5 py-16 sm:px-8 sm:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <div className="max-w-3xl">
              <p className="font-mono text-xs font-bold tracking-[0.16em] text-primary uppercase">
                A practical recovery guide
              </p>
              <h2 className="mt-3 text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-5xl">
                What if something went wrong?
              </h2>
              <p className="mt-5 text-lg leading-8 text-muted-foreground">
                Twenty common moments in a W3DS build, with the next safe move. Open the one that
                matches what you see, fix the observed problem, and keep the rest of the system
                unchanged.
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
