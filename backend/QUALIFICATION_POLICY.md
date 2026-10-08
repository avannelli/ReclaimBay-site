# Qualification/scoring policy boundary

`src/qualification/policy.ts` contains the pure, business-independent contract and
execution. `ScoringPolicy<Input, Key>` supplies identity, criterion definitions,
thresholds, labels, observation resolution, explanations and consistency checks.
`QualificationPolicy<Input, Key, EvidenceInput>` adds evidence validation. Inputs
are generic types: the executor has no prospect fields or business signal keys.

`src/policies/reclaimbay/scoring.ts` owns the existing criteria, weights, labels,
derived observations, automotive implication/contradiction rules and explanation
text. `src/policies/reclaimbay/qualification.ts` composes its evidence contract
with the existing repair/collision classifiers. Those classifiers remain in
place because research, approval and messaging still use them; this milestone
does not change those workflows. Separate composition keeps the scoring module
independent of the classifiers' existing normalization/prospect dependencies.

`src/scoring.ts` remains the compatibility entry point. Existing consumers use
the ReclaimBay policy without signature changes. Full scoring and validation
results carry `policyId` and `version`. Legacy helpers still return their existing
state maps, bands or error arrays; they are not standalone policy assessments.

The identity is `reclaimbay.qualification` / `v3`. Version `v3` is intentionally
unchanged: definitions and behavior are unchanged. Existing database score and
outreach snapshots continue storing `v3`; no new database fields, migration or
rescore is introduced. A future behavior change (including evidence semantics)
must bump the policy version and explicitly decide how cached scores and queued
messages are handled. This is not a multibusiness persistence contract.

Scoring evaluates recorded observations; it does **not** certify evidence or
authorize an action. The prospect service still checks evidence at the same
qualification/readiness write boundary, with the same completed-research query.
Approval holds, lifecycle transitions, suppression, internal-test restrictions
and sending guards remain authoritative and unchanged.

Tests:

- `qualification.policy.test.ts` uses a two-criterion synthetic library policy
  with unrelated input fields, a non-100-point maximum, independent fit/priority,
  evidence validation and version changes. A source guard keeps the core free of
  business imports and vocabulary.
- `reclaimbay.policy.test.ts` compares all 177,147 ternary observation combinations
  against a digest captured from commit `ccf651e` before extraction, cycling five
  contact/website contexts. It includes full reasons and consistency errors,
  excluding only the additive `policyId`. Existing workflow/evidence tests remain
  the regression authority for write and sending behavior.

Remaining business coupling (outside this milestone): provider selection,
research strategy, approval heuristics, lifecycle display text, messaging,
analytics and SQL qualification filters. The filters continue consuming the
same required criteria/implication definitions through the compatibility entry
point; this policy boundary does not make those queries generic.
