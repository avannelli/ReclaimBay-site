# ReclaimBay V2 customer experience

The frontend presents a declined-work review for independent repair shops.
It totals reported estimates and ranks included jobs. It does not verify job
status, track recovered revenue, contact customers, or audit invoices/contracts.
The backend, AOS package, data model, and API contracts remain unchanged.

The visual system uses warm paper, navy structure, a restrained gold accent,
Geist body/financial typography, and system Georgia for editorial emphasis.
Thin rules and whitespace organize information; contained surfaces mark the
product demonstration, upload area, and actual report. No customer proof or
recovery statistics are invented.

Reference review: [Kage](https://kage.design/),
[Refero Styles](https://styles.refero.design/ai-agents/design-context),
[Scrolltide](https://www.scrolltide.co/),
[Prompt Motion](https://prompt-motion.com/), and
[Magic UI number ticker](https://magicui.design/docs/components/number-ticker).
These informed the review of composition and purposeful motion; no templates,
reference code, animation dependencies, or external assets were added.

The homepage moves from the financial problem and interactive product to a
three-step method, report evidence, private upload, and methodology/privacy
answers. `lib/demoReport.ts` contains six fictional Juniper Auto Care jobs.
Both the demonstration and full sample use the existing scanner functions;
the displayed $4,327.48 reconciles to those six source records. The demo's
September snapshot is clearly fictional, and its brief replay is demonstrative.

The importer and preference safeguards are unchanged. Ambiguous headers retain
every nonblank row and require a choice. Mapping labels, amount validation,
duplicates, source values, report totals, and all backend contracts keep their
existing meaning. Results distinguish reported value from recovery, expose
source details on demand, and offer an optional tour without interrupting
the initial review. PDF and CSV exports remain local.

Motion is finite: a short upload transition, a demonstration replay, total
count-up, and small state changes. Reduced motion removes artificial holds
and visual transitions. Native details/summary elements provide evidence and
FAQ disclosure. Skip navigation, meaningful labels, focus outlines, stage
focus, focus-trapped overlays, and live error/progress announcements support
keyboard and assistive-technology use.

Desktop places the real demo beside the headline. Tablet moves it below the
headline; mobile stacks the method, upload, and privacy narrative. Narrow
confirmation actions stack rather than compress. Reports retain their totals,
filters and exports across viewport sizes. Visual QA covers 1440, 768, 390,
and 320 pixel widths, normal/reduced motion, and scanner/report states.
