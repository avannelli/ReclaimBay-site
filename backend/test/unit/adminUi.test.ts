import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CANDIDATE_STATUSES } from "../../src/discovery/candidateStatus.js";
import { STATUSES } from "../../src/prospectStatus.js";
import { signalFieldName } from "../../src/prospects.js";
import { SIGNALS } from "../../src/scoring.js";
import {
  bandBadge,
  candidateBadge,
  emptyState,
  errorSummary,
  esc,
  field,
  fieldErrors,
  obsBadge,
  qualificationBadge,
  statusBadge,
  stepper,
} from "../../src/admin/ui.js";
import { STYLE } from "../../src/admin/styles.js";

describe("fieldErrors: existing validator messages map onto their fields", () => {
  test("contact, business, and location messages", () => {
    const fe = fieldErrors([
      "Website must be a valid http(s) URL.",
      "Phone must be a phone number, e.g. (555) 010-0100.",
      "Phone needs the public URL where it is listed.",
      "Phone source URL is set without a phone number.",
      "Email must be an email address.",
      "Email needs the public URL where it is listed.",
      "Business name is too long (max 120).",
      "Postal code has invalid characters.",
      "Country must be a 2-letter code, e.g. US.",
    ]);
    assert.deepEqual(fe.byField.get("website"), ["Website must be a valid http(s) URL."]);
    assert.equal(fe.byField.get("phone")?.length, 1, "only the phone-format message is about the phone field");
    assert.equal(fe.byField.get("phoneSourceUrl")?.length, 2, "both source-URL messages land on the source field");
    assert.equal(fe.byField.get("email")?.length, 1);
    assert.equal(fe.byField.get("emailSourceUrl")?.length, 1);
    assert.equal(fe.byField.get("businessName")?.length, 1);
    assert.equal(fe.byField.get("postalCode")?.length, 1);
    assert.equal(fe.byField.get("country")?.length, 1);
    assert.equal(fe.all.length, 9, "nothing is dropped from the summary");
  });

  test("signal messages map to that signal's control", () => {
    for (const def of SIGNALS) {
      const fe = fieldErrors([`${def.label}: can only be observed on a website.`]);
      assert.equal(fe.byField.get(signalFieldName(def.key))?.length, 1, def.key);
    }
    const fe = fieldErrors(["Invalid value for signal independent_shop."]);
    assert.equal(fe.byField.get("signal_independent_shop")?.length, 1);
  });

  test("evidence, note, and status messages map to their fields", () => {
    assert.ok(fieldErrors(["Choose the signal this evidence supports."]).byField.has("signalKey"));
    assert.ok(fieldErrors(["Source URL must be a valid public http(s) URL."]).byField.has("sourceUrl"));
    assert.ok(fieldErrors(["Excerpt is 400 characters; keep it to a short quote of at most 280."]).byField.has("excerpt"));
    assert.ok(fieldErrors(["Note can't be empty."]).byField.has("body"));
    for (const m of ["Can't move from New to Contacted.", "Moving to Do not contact requires a reason.", "Do not contact is permanent and can't be changed here.", "Qualified requires Qualification \"Meets criteria\"; this prospect is Unverified."]) {
      assert.ok(fieldErrors([m]).byField.has("status"), m);
    }
  });

  test("unrecognized messages stay in the summary only", () => {
    const fe = fieldErrors(["Something unexpected."]);
    assert.equal(fe.byField.size, 0);
    assert.deepEqual(fe.all, ["Something unexpected."]);
  });

  test("the summary links each mapped message to its field and escapes the rest", () => {
    const errors = ["Phone must be a phone number.", "<b>odd</b> message"];
    const html = errorSummary(errors, fieldErrors(errors));
    assert.match(html, /role="alert"/);
    assert.match(html, /<a href="#f-phone">Phone must be a phone number\.<\/a>/);
    assert.doesNotMatch(html, /<b>odd/);
    assert.equal(errorSummary([], fieldErrors([])), "");
  });
});

describe("field()", () => {
  test("connects label, hint, and error for assistive technology, and keeps the value", () => {
    const fe = fieldErrors(["Phone must be a phone number."]);
    const html = field({ name: "phone", label: "Business phone", values: { phone: "call us" }, errors: fe, hint: "Digits only" });
    assert.match(html, /<label for="f-phone">Business phone<\/label>/);
    assert.match(html, /id="f-phone"/);
    assert.match(html, /value="call us"/);
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /aria-describedby="h-phone e-phone"/);
    assert.match(html, /class="ferr" id="e-phone">Phone must be a phone number\./);
  });

  test("a clean field has no error markup", () => {
    const html = field({ name: "city", label: "City", values: { city: "Ojai" } });
    assert.doesNotMatch(html, /aria-invalid|ferr/);
  });

  test("values are escaped", () => {
    assert.doesNotMatch(field({ name: "city", label: "City", values: { city: `"><script>` } }), /<script>/);
  });
});

describe("badges: meaning is in the text, never in color alone", () => {
  test("every status has a visible text label and its own class", () => {
    for (const s of STATUSES) assert.match(statusBadge(s), new RegExp(`class="st st-${s}">[A-Z][^<]+</span>`), s);
    for (const s of CANDIDATE_STATUSES) assert.match(candidateBadge(s), new RegExp(`class="st cs-${s}">[A-Z][^<]+</span>`), s);
  });

  test("qualification, band, and observed values carry text labels", () => {
    assert.match(qualificationBadge("meets_criteria"), />Meets criteria</);
    assert.match(qualificationBadge("unverified"), />Unverified</);
    assert.match(qualificationBadge("disqualified"), />Disqualified</);
    assert.match(bandBadge("high"), />High</);
    assert.match(bandBadge("medium"), />Medium</);
    assert.match(bandBadge("low"), />Low</);
    assert.match(obsBadge("yes"), />Yes</);
    assert.match(obsBadge("no"), />No</);
    assert.match(obsBadge("unknown"), />Unknown</);
  });

  test("each state gets a distinct glyph in the stylesheet (shape, not just shade)", () => {
    const glyph = (cls: string) => new RegExp(`\\.${cls}::before \\{ content:"([^"]+)"`).exec(STYLE)?.[1];
    const statusGlyphs = STATUSES.map((s) => glyph(`st-${s}`));
    assert.ok(statusGlyphs.every(Boolean), "every prospect status has a glyph");
    assert.equal(new Set(statusGlyphs).size, STATUSES.length, "prospect status glyphs are all different");
    const qual = ["meets_criteria", "unverified", "disqualified"].map((q) => glyph(`q-${q}`));
    assert.equal(new Set(qual).size, 3);
    const obs = ["yes", "no", "unknown"].map((v) => glyph(`obs-${v}`));
    assert.equal(new Set(obs).size, 3);
  });

  test("qualification and opportunity band use different visual families", () => {
    assert.doesNotMatch(bandBadge("high"), /q-/);
    assert.doesNotMatch(qualificationBadge("meets_criteria"), /band-/);
  });
});

describe("stepper and empty states", () => {
  const labels = { a: "A", b: "B", c: "C" };
  test("marks done, current, and upcoming steps in text as well as style", () => {
    const html = stepper(["a", "b", "c"], labels, "b");
    assert.match(html, /<li class="done">A<span class="sr-only"> \(done\)<\/span>/);
    assert.match(html, /<li class="now" aria-current="step">B<span class="sr-only"> \(current\)<\/span>/);
    assert.match(html, /<li class="next">C/);
  });

  test("an off-path status marks nothing as current", () => {
    assert.doesNotMatch(stepper(["a", "b"], labels, "zzz"), /aria-current|class="now"/);
  });

  test("empty states are calm text, not illustrations", () => {
    const html = emptyState("No prospects yet.", "Add your first prospect.");
    assert.match(html, /<b>No prospects yet\.<\/b>/);
    assert.doesNotMatch(html, /<img|<svg/);
  });

  test("esc escapes the five HTML-significant characters", () => {
    assert.equal(esc(`<a href="x">'&'</a>`), "&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;");
  });
});

describe("stylesheet", () => {
  test("has visible focus styles and a reduced-motion-safe transition rule", () => {
    assert.match(STYLE, /:focus-visible \{ outline:2px solid/);
    assert.match(STYLE, /prefers-reduced-motion: no-preference/);
  });

  test("loads nothing external (the admin CSP allows inline styles only)", () => {
    assert.doesNotMatch(STYLE, /@import|url\(\s*["']?https?:/i);
  });

  test("supports dark mode and responsive table cards", () => {
    assert.match(STYLE, /prefers-color-scheme: dark/);
    assert.match(STYLE, /\.tbl\.cards td::before \{ content:attr\(data-label\)/);
  });
});
