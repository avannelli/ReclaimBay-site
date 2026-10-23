import type { jsPDF } from "jspdf";
import { BRAND } from "./brand";
import { formatDate, formatDateTime } from "./format";
import { GROUPING_RULE, TIER_LABEL, TIER_ORDER, tierRule, type FollowUp, type FollowUpPlan } from "./followUps";
import { clean } from "./pdfReport";

/*
 * A printable call sheet: one row per customer and vehicle, in call order,
 * with Reached / Booked boxes and room for notes. Drawn locally with jsPDF;
 * no DOM capture or network requests.
 */

export interface CallSheetInput {
  plan: FollowUpPlan;
  money: (n: number) => string;
  fileName: string;
  isSample: boolean;
  analyzedAt: Date;
}

const C = { navy: "#0b2238", ink: "#10263c", muted: "#44576b", line: "#dee2dd", amber: "#f2a51a", soft: "#f6f4ee" };
const PAGE_W = 792; // US Letter, landscape
const M = 36;
const W = PAGE_W - M * 2;
const TOP = 92;
const BOTTOM = 560;
// Column left edges and widths: #, customer/vehicle, contact, declined work, value, last declined, reached, booked, notes.
const COLS = [
  { key: "n", x: M, w: 22 },
  { key: "who", x: M + 22, w: 136 },
  { key: "contact", x: M + 158, w: 118 },
  { key: "work", x: M + 276, w: 184 },
  { key: "value", x: M + 460, w: 64 },
  { key: "last", x: M + 528, w: 64 },
  { key: "reached", x: M + 592, w: 40 },
  { key: "booked", x: M + 632, w: 40 },
  { key: "notes", x: M + 672, w: W - 672 },
] as const;
const col = (k: (typeof COLS)[number]["key"]) => COLS.find((c) => c.key === k)!;

export async function createCallSheetPdf(input: CallSheetInput): Promise<jsPDF> {
  const [{ jsPDF: JsPDF }, { PDF_LOGO_LOCKUP }] = await Promise.all([import("jspdf"), import("./brandRaster")]);
  const doc = new JsPDF({ unit: "pt", format: "letter", orientation: "landscape", compress: true });
  doc.setProperties({ title: `${BRAND.name} — Declined-work call sheet`, creator: BRAND.name });
  new CallSheetWriter(doc, input, PDF_LOGO_LOCKUP).write();
  return doc;
}

export async function downloadCallSheetPdf(input: CallSheetInput, saveAs: string) {
  const doc = await createCallSheetPdf(input);
  doc.save(saveAs);
}

class CallSheetWriter {
  private y = TOP;
  constructor(
    private readonly doc: jsPDF,
    private readonly input: CallSheetInput,
    private readonly logo: { data: string; width: number; height: number },
  ) {}

  private text(s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: string; align?: "left" | "right" } = {}) {
    this.doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    this.doc.setTextColor(opts.color ?? C.ink);
    this.doc.text(clean(s), x, y, { align: opts.align ?? "left", baseline: "alphabetic" });
  }

  private wrap(s: string, width: number, size: number, bold = false): string[] {
    this.doc.setFont("helvetica", bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    return this.doc.splitTextToSize(clean(s), width - 4) as string[];
  }

  private rule(y: number, color = C.line, weight = 0.6) {
    this.doc.setDrawColor(color);
    this.doc.setLineWidth(weight);
    this.doc.line(M, y, M + W, y);
  }

  private header() {
    this.doc.setFillColor(C.navy);
    this.doc.rect(M, 28, 128, 30, "F");
    const h = 21;
    this.doc.addImage(this.logo.data, "PNG", M + 10, 32, (h * this.logo.width) / this.logo.height, h);
    this.text("DECLINED-WORK CALL SHEET", M + W, 41, 9, { color: C.muted, align: "right" });
    this.text(this.input.isSample ? "SAMPLE · FICTIONAL DATA" : `${this.input.fileName} · Analyzed ${formatDateTime(this.input.analyzedAt)}`, M + W, 55, 8, { color: C.muted, align: "right" });
    this.rule(70);
    this.y = TOP;
  }

  private columns() {
    const top = this.y;
    this.rule(top, C.navy, 0.8);
    const labels: [string, (typeof COLS)[number]["key"], "left" | "right"][] = [
      ["#", "n", "left"],
      ["CUSTOMER / VEHICLE", "who", "left"],
      ["CONTACT", "contact", "left"],
      ["DECLINED WORK", "work", "left"],
      ["VALUE", "value", "right"],
      ["LAST DECLINED", "last", "left"],
      ["REACHED", "reached", "left"],
      ["BOOKED", "booked", "left"],
      ["NOTES", "notes", "left"],
    ];
    for (const [label, key, align] of labels) {
      const c = col(key);
      this.text(label, align === "right" ? c.x + c.w - 4 : c.x, top + 14, 7, { bold: true, color: C.muted, align });
    }
    this.rule(top + 22);
    this.y += 22;
  }

  private page(first = false) {
    if (!first) this.doc.addPage();
    this.header();
    if (!first) this.columns();
  }

  private tierHeading(label: string, count: number, value: number) {
    if (this.y + 46 > BOTTOM) this.page();
    this.doc.setFillColor(C.soft);
    this.doc.rect(M, this.y, W, 18, "F");
    this.text(`${label.toUpperCase()} · ${count} ${count === 1 ? "FOLLOW-UP" : "FOLLOW-UPS"} · ${this.input.money(value)}`, M + 6, this.y + 12.5, 8, { bold: true, color: C.navy });
    this.y += 18;
  }

  private row(f: FollowUp, rank: number) {
    const money = this.input.money;
    const who = [...this.wrap(f.customer ?? "No customer name in export", col("who").w, 8.5, true), ...this.wrap(f.vehicle ?? "Vehicle not listed", col("who").w, 8)];
    const contact = [f.phone, f.email].filter((v): v is string => Boolean(v)).flatMap((v) => this.wrap(v, col("contact").w, 8));
    if (!contact.length) contact.push("No phone or email");
    const work = f.items.flatMap((o) => this.wrap(`${o.service} · ${money(o.amount)}`, col("work").w, 8));
    const lines = Math.max(who.length, contact.length, work.length, 2);
    const height = lines * 10.5 + 10;
    if (this.y + height > BOTTOM) this.page();
    const top = this.y,
      base = top + 13;
    this.text(String(rank).padStart(2, "0"), col("n").x, base, 8, { color: C.muted });
    who.forEach((l, i) => this.text(l, col("who").x, base + i * 10.5, i === 0 ? 8.5 : 8, { bold: i === 0, color: i === 0 ? C.ink : C.muted }));
    contact.forEach((l, i) => this.text(l, col("contact").x, base + i * 10.5, 8, { color: f.reachable ? C.ink : C.muted }));
    work.forEach((l, i) => this.text(l, col("work").x, base + i * 10.5, 8, { color: C.ink }));
    this.text(money(f.total), col("value").x + col("value").w - 4, base, 9, { bold: true, color: C.navy, align: "right" });
    this.text(f.latestDate ? formatDate(f.latestDate) : "No date", col("last").x, base, 8, { color: C.muted });
    for (const k of ["reached", "booked"] as const) {
      this.doc.setDrawColor(C.muted);
      this.doc.setLineWidth(0.7);
      this.doc.rect(col(k).x + 4, top + 5, 10, 10);
    }
    this.y += height;
    this.rule(this.y);
  }

  write() {
    const { plan } = this.input;
    this.page(true);
    this.text("Declined-work call sheet", M, this.y + 18, 20, { color: C.navy });
    this.y += 30;
    const intro = `${plan.followUps.length} ${plan.basis === "customer" ? "follow-ups (customers and vehicles)" : "declined jobs"}, in call order. ${tierRule(plan.hasDates)}`;
    for (const l of [...this.wrap(intro, W, 8.5), ...(plan.basis === "customer" ? this.wrap(GROUPING_RULE, W, 8.5) : [])]) {
      this.text(l, M, this.y + 9, 8.5, { color: C.muted });
      this.y += 11;
    }
    this.y += 8;
    this.columns();
    let rank = 0;
    for (const tier of TIER_ORDER) {
      const s = plan.tiers[tier];
      if (!s.count) continue;
      this.tierHeading(TIER_LABEL[tier], s.count, s.value);
      for (const f of plan.followUps.filter((x) => x.tier === tier)) this.row(f, ++rank);
    }
    const total = this.doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      this.doc.setPage(p);
      this.rule(574);
      this.text("Reported declined estimates, not recovered revenue. Confirm each job is still needed before calling.", M, 588, 7.5, { color: C.muted });
      this.text(`${BRAND.name} · Generated on your device · Page ${p} of ${total}`, M + W, 588, 7.5, { color: C.muted, align: "right" });
    }
  }
}
