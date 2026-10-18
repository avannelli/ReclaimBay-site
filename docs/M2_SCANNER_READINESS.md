# M2 entry task: assess commercial readiness of the scanner

Next milestone: **M2 — Commercial readiness of the customer-facing scanner**.
This document defines the next task; it does not claim that M2 has started or passed.

## Exact next task

Perform a **local, end-to-end scanner-readiness assessment** and produce an
evidence-backed acceptance matrix for the existing experience:

**Landing page → sample or CSV/XLSX import → header/column mapping → scanner
results → CSV/PDF/summary export → customer next action.**

Use synthetic or appropriately sanitized fixtures, never private customer data
from production. Trace a known report from its input rows to the displayed totals
and exported results. Identify the first concrete barrier to an unaided shop
obtaining and understanding a trustworthy result. Recommend the smallest fix
supported by that evidence; implementation requires its own task.

## Evidence to collect

| Area | Assessment |
| --- | --- |
| Product promise | A shop understands what to upload, what the scanner measures and what it does not establish. Claims match actual behavior. |
| Import | CSV and XLSX, sample data, ambiguous/headerless inputs, missing columns, malformed files and empty results have clear outcomes without silent data loss. |
| Numerical trust | Known row amounts reconcile with the dashboard, age/category breakdowns and exports; exclusions, undated rows and data-quality limits are visible. |
| Self-service usability | Assess the existing desktop/mobile flow, keyboard access, error recovery, reset and navigation. Record any need for personal assistance. |
| Privacy | Confirm file/report contents stay in browser memory and out of network requests, persistent storage, analytics and contact payloads. |
| Commercial next step | Describe the existing path from a useful scan to further use or purchase. Record absent pricing, payment, entitlement or repeat-use behavior as gaps, not implemented capabilities. |
| Measurement | Separate sample usage, real scans, exports and contact intent. Do not substitute email acceptance for product adoption or paying customers. |

Start with the existing `test/` suites and scanner code in `components/ScannerApp.tsx`,
`components/UploadPanel.tsx`, `components/ColumnMapper.tsx`, `components/Dashboard.tsx`
and `lib/`. Run the relevant local checks and inspect the customer journey; tests
alone do not establish an unaided, commercially ready experience.

## Required output

A concise matrix of **pass / gap / not verified**, with reproducible fixture or
interaction evidence for each finding, a prioritized list of release blockers,
and one recommended first scanner-readiness fix. Distinguish existing capabilities
from proposed work and identify which customer or commercial assumptions still
need validation. Do not invent a pricing model or add features during the assessment.

No production data changes, discovery, research triggers, campaigns, email,
deployment or replenishment activation are part of this entry task.
