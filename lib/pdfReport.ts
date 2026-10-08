import type { jsPDF } from "jspdf";
import { RECENT_DAYS } from "./analyze";
import { BRAND } from "./brand";
import {
  allocatePercents,
  formatAge,
  formatAverage,
  formatDate,
  formatDateTime,
  moneyFormat,
  undatedSplitNote,
} from "./format";
import type { Analysis, Bucket, Opportunity } from "./types";

/*
 * One-click executive-summary PDF, drawn directly with jsPDF (not a
 * screenshot). Runs entirely in the browser; nothing is sent anywhere.
 */

// Mirrors the color tokens in app/globals.css.
const C = {
  navy: "#0c253b",
  navyDeep: "#071725",
  amber: "#d9901a",
  amberHover: "#b96f0d",
  amberSoft: "#fff5df",
  amberInk: "#975e0b",
  amberLight: "#eecd98", // amber at 45% on white, as used for 31–90 days
  emerald: "#168a5b",
  emeraldBright: "#3cc18a",
  ink: "#0f172a",
  ink2: "#475569",
  ink3: "#64748b",
  line: "#e2e8f0",
  canvas: "#f7f9fc",
  slate100: "#f1f5f9",
  slate300: "#cbd5e1",
  slate400: "#94a3b8",
  navyBar: "#30465a", // navy at 85% on white
  white: "#ffffff",
};

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const M = 40;
const W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 52; // content stops above the footer
const TOP_CONT = 52; // content start on continuation pages
const TABLE_ROWS = 25;

const AGE_COLORS = [C.amber, C.amberLight, C.slate400, C.slate300, C.slate300];
const categoryColor = (i: number) =>
  i === 0 ? C.amber : i < 4 ? C.navyBar : C.slate400;

export interface SummaryInput {
  analysis: Analysis;
  fileName: string;
  isSample: boolean;
  /** File-quality notes, exactly as shown on the results page. */
  notes: string[];
  /** When the report was analyzed, in the viewer's local time. */
  analyzedAt: Date;
}

// Built-in PDF fonts cover Latin-1 plus a few typographic marks. Anything
// else (emoji, other scripts) becomes "?" rather than garbled output.
const EXTRA_OK = new Set("–—‘’“”•…€™");
const clean = (s: string) =>
  Array.from(s)
    .map((ch) => (ch.charCodeAt(0) <= 0xff || EXTRA_OK.has(ch) ? ch : "?"))
    .join("");

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export async function downloadSummaryPdf(input: SummaryInput, saveAs: string) {
  const [{ jsPDF: JsPDF }, logos] = await Promise.all([import("jspdf"), import("./brandRaster")]);
  const doc = new JsPDF({ unit: "pt", format: "letter", compress: true });
  doc.setProperties({ title: `${BRAND.name} declined-work report`, creator: BRAND.name });
  new SummaryWriter(doc, input, { full: logos.PDF_LOGO_FULL, lockup: logos.PDF_LOGO_LOCKUP }).write();
  doc.save(saveAs);
}

/** A PNG render of the logo (lib/brandRaster.ts). */
interface LogoImage {
  data: string;
  width: number;
  height: number;
}

/** Where the wordmark's baseline sits, as a fraction of the logo's height. */
const LOGO_BASELINE = 0.709;

interface TextOpts {
  size: number;
  color?: string;
  bold?: boolean;
  align?: "left" | "right" | "center";
  charSpace?: number;
}

class SummaryWriter {
  private y = M;
  private readonly a: Analysis;
  /** The report's money format, matching the on-screen results. */
  private readonly money: (n: number) => string;

  constructor(
    private readonly doc: jsPDF,
    private readonly input: SummaryInput,
    private readonly logos: { full: LogoImage; lockup: LogoImage },
  ) {
    this.a = input.analysis;
    this.money = moneyFormat(input.analysis.showCents);
  }

  // ------------------------------------------------------------ primitives

  private font(size: number, bold = false) {
    this.doc.setFont("helvetica", bold ? "bold" : "normal");
    this.doc.setFontSize(size);
  }

  private text(str: string, x: number, y: number, o: TextOpts) {
    this.font(o.size, o.bold);
    this.doc.setTextColor(o.color ?? C.ink);
    const s = clean(str);
    if (o.align === "right" && o.charSpace) x -= o.charSpace * (s.length - 1);
    this.doc.text(s, x, y, {
      align: o.align ?? "left",
      charSpace: o.charSpace ?? 0,
      baseline: "alphabetic",
    });
  }

  private width(str: string, size: number, bold = false, charSpace = 0) {
    this.font(size, bold);
    const s = clean(str);
    return this.doc.getTextWidth(s) + charSpace * Math.max(s.length - 1, 0);
  }

  /** Largest font size (down to `min`) at which the text fits `maxW`. */
  private fit(str: string, maxW: number, start: number, min: number, bold = true) {
    let size = start;
    while (size > min && this.width(str, size, bold) > maxW) size -= 0.5;
    return size;
  }

  private wrap(str: string, maxW: number, size: number, bold = false, maxLines?: number) {
    this.font(size, bold);
    let lines = this.doc.splitTextToSize(clean(str), maxW) as string[];
    if (maxLines && lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1];
      while (last.length > 1 && this.doc.getTextWidth(`${last}...`) > maxW) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = `${last.trimEnd()}...`;
    }
    return lines;
  }

  private truncate(str: string, maxW: number, size: number, bold = false) {
    return this.wrap(str, maxW, size, bold, 1)[0] ?? "";
  }

  private rect(x: number, y: number, w: number, h: number, fill: string, r = 0) {
    this.doc.setFillColor(fill);
    if (r > 0) this.doc.roundedRect(x, y, w, h, r, r, "F");
    else this.doc.rect(x, y, w, h, "F");
  }

  private hline(y: number, color = C.line, x1 = M, x2 = M + W, weight = 0.6) {
    this.doc.setDrawColor(color);
    this.doc.setLineWidth(weight);
    this.doc.line(x1, y, x2, y);
  }

  /**
   * The ReclaimBay logo in its reverse version, for the navy bands. Placed so
   * its wordmark sits on `baseline`; `h` is its height. Returns its width.
   */
  private logo(img: LogoImage, x: number, baseline: number, h: number) {
    const w = (h * img.width) / img.height;
    this.doc.addImage(img.data, "PNG", x, baseline - LOGO_BASELINE * h, w, h, undefined, "NONE");
    return w;
  }

  private dot(x: number, y: number, color: string, r = 2.4) {
    this.doc.setFillColor(color);
    this.doc.circle(x, y, r, "F");
  }

  // ------------------------------------------------------------ pagination

  private newPage() {
    this.doc.addPage();
    this.rect(0, 0, PAGE_W, 26, C.navy);
    this.rect(0, 26, PAGE_W, 1.2, C.amber);
    const lw = this.logo(this.logos.lockup, M, 17, 15);
    this.text("Declined-work review", M + lw + 8, 17, {
      size: 8,
      color: C.slate400,
    });
    if (this.input.isSample) {
      this.text("SAMPLE REPORT", M + W, 17, {
        size: 7.5,
        bold: true,
        color: C.amber,
        align: "right",
        charSpace: 0.8,
      });
    }
    this.y = TOP_CONT;
  }

  /** Starts a new page unless `h` more points fit on this one. */
  private ensure(h: number) {
    if (this.y + h > BOTTOM) this.newPage();
  }

  private footers() {
    const pages = this.doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      this.doc.setPage(p);
      const fy = PAGE_H - 30;
      this.hline(fy - 10);
      let x = M;
      if (this.input.isSample) {
        this.text("SAMPLE REPORT", x, fy, {
          size: 7,
          bold: true,
          color: C.amberInk,
          charSpace: 0.6,
        });
        x += this.width("SAMPLE REPORT", 7, true, 0.6) + 8;
      }
      this.text(
        `${BRAND.name} · Reported declined estimates. Recovery is not tracked. Generated on your device.`,
        x,
        fy,
        { size: 7, color: C.ink3 },
      );
      this.text(`Page ${p} of ${pages}`, M + W, fy, {
        size: 7,
        color: C.ink3,
        align: "right",
      });
    }
  }

  // ------------------------------------------------------------ sections

  write() {
    this.header();
    this.hero();
    this.kpis();
    if (this.a.hasDates) {
      this.recency();
      this.breakdown(
        "When the work was declined",
        "Declined value by days since the estimate.",
        this.a.ageBuckets,
        (_, i) => AGE_COLORS[i] ?? C.slate300,
        false,
        this.a.undated,
      );
    }
    this.breakdown(
      "Where declined value is concentrated",
      "Grouped by service category.",
      this.a.categories,
      (_, i) => categoryColor(i),
      true,
    );
    this.table();
    this.notes();
    this.footers();
  }

  private header() {
    const { isSample, fileName, analyzedAt } = this.input;
    this.rect(0, 0, PAGE_W, 78, C.navy);
    this.rect(0, 78, PAGE_W, 2, C.amber);

    // The full logo, tagline included.
    this.logo(this.logos.full, M, 48, 44);

    this.text(`Analyzed ${formatDateTime(analyzedAt)}`, M + W, 36, {
      size: 8.5,
      color: C.slate300,
      align: "right",
    });
    this.text(this.truncate(`Source: ${fileName}`, 230, 8), M + W, 50, {
      size: 8,
      color: C.slate400,
      align: "right",
    });
    this.y = 98;

    if (isSample) {
      this.rect(M, this.y, W, 26, C.amberSoft, 5);
      this.rect(M, this.y, 3, 26, C.amber);
      this.text("SAMPLE REPORT", M + 14, this.y + 16.5, {
        size: 8,
        bold: true,
        color: C.amberInk,
        charSpace: 1,
      });
      this.text(
        "Built from made-up data to show what a scan looks like. These are not real customer records.",
        M + 14 + this.width("SAMPLE REPORT", 8, true, 1) + 10,
        this.y + 16.5,
        { size: 8, color: C.ink2 },
      );
      this.y += 38;
    }
  }

  private hero() {
    const a = this.a;
    const h = 128;
    const x = M;
    const y = this.y;
    this.rect(x, y, W, h, C.navyDeep, 10);
    this.rect(x + 16, y + h - 2, W - 32, 2, C.amber);

    const lead = a.ranked.slice(0, 5);
    const showLead = a.count > 5;
    const leftW = showLead ? W - 220 : W - 48;

    this.text("DECLINED WORK IDENTIFIED", x + 24, y + 30, {
      size: 7.5,
      bold: true,
      color: C.amber,
      charSpace: 1.4,
    });
    const total = this.money(a.total);
    this.text(total, x + 24, y + 72, {
      size: this.fit(total, leftW, 40, 20),
      bold: true,
      color: C.white,
    });

    // "38 opportunities found  ·  $10,456 declined in the last 90 days"
    let tx = x + 24;
    const ty = y + 100;
    const count = a.count.toLocaleString("en-US");
    this.text(count, tx, ty, { size: 9.5, bold: true, color: C.white });
    tx += this.width(count, 9.5, true) + 3;
    const found = `${a.count === 1 ? "opportunity" : "opportunities"} found`;
    this.text(found, tx, ty, { size: 9.5, color: C.slate300 });
    tx += this.width(found, 9.5);
    if (a.hasDates && a.recency.recent.count > 0) {
      tx += 14;
      this.dot(tx, ty - 3, C.emeraldBright, 2);
      tx += 7;
      const recent = this.money(a.recency.recent.value);
      this.text(recent, tx, ty, { size: 9.5, bold: true, color: C.emeraldBright });
      tx += this.width(recent, 9.5, true) + 3;
      this.text(`declined in the last ${RECENT_DAYS} days`, tx, ty, {
        size: 9.5,
        color: C.slate300,
      });
    }

    if (showLead) {
      const leadValue = lead.reduce((s, o) => s + o.amount, 0);
      const pct = Math.round((leadValue / a.total) * 100);
      const px = x + W - 196;
      const py = y + 18;
      const pw = 176;
      this.rect(px, py, pw, h - 36, C.navy, 8);
      this.text("LARGEST 5 OPPORTUNITIES", px + 14, py + 20, {
        size: 6.5,
        bold: true,
        color: C.slate400,
        charSpace: 1,
      });
      const lv = this.money(leadValue);
      this.text(lv, px + 14, py + 46, {
        size: this.fit(lv, pw - 28, 20, 11),
        bold: true,
        color: C.white,
      });
      this.rect(px + 14, py + 58, pw - 28, 4, "#1c3148", 2);
      this.rect(px + 14, py + 58, Math.max((pw - 28) * (pct / 100), 3), 4, C.amber, 2);
      this.text(`${pct}%`, px + 14, py + 78, { size: 8, bold: true, color: C.amber });
      this.text(
        "of all declined value",
        px + 14 + this.width(`${pct}%`, 8, true) + 3,
        py + 78,
        { size: 8, color: C.slate400 },
      );
    }
    this.y = y + h + 14;
  }

  private kpis() {
    const a = this.a;
    const [recentPct] = allocatePercents([a.recency.recent.value, a.recency.older.value]);
    const cards: { label: string; value: string; note?: string; accent: string; color: string }[] = [
      {
        label: "Declined opportunities",
        value: a.count.toLocaleString("en-US"),
        note: "Opportunities included in this analysis",
        accent: C.slate400,
        color: C.ink,
      },
      {
        label: "Average opportunity",
        value: formatAverage(a.average, a.showCents),
        note: "Per declined job",
        accent: C.navy,
        color: C.navy,
      },
      {
        label: "Highest-value opportunity",
        value: this.money(a.highest.amount),
        note: a.highest.service,
        accent: C.amber,
        color: C.amberHover,
      },
    ];
    if (a.hasDates) {
      cards.push({
        label: `Declined in last ${RECENT_DAYS} days`,
        value: this.money(a.recency.recent.value),
        note: `${recentPct}% of dated declined value`,
        accent: C.emerald,
        color: C.emerald,
      });
    }

    const gap = 10;
    const cw = (W - gap * (cards.length - 1)) / cards.length;
    const h = 86;
    cards.forEach((c, i) => {
      const x = M + i * (cw + gap);
      const y = this.y;
      this.rect(x, y, cw, h, C.line, 6);
      this.rect(x + 0.7, y + 0.7, cw - 1.4, h - 1.4, C.white, 5.5);
      this.rect(x + 6, y + 0.7, cw - 12, 2.2, c.accent);
      const inner = cw - 24;
      const labelLines = this.wrap(c.label.toUpperCase(), inner - 14, 6.5, true, 2);
      labelLines.forEach((l, j) =>
        this.text(l, x + 12, y + 18 + j * 8.5, { size: 6.5, bold: true, color: C.ink3, charSpace: 0.4 }),
      );
      this.text(c.value, x + 12, y + 50, {
        size: this.fit(c.value, inner, 17, 9),
        bold: true,
        color: c.color,
      });
      if (c.note) {
        this.wrap(c.note, inner, 7, false, 2).forEach((l, j) =>
          this.text(l, x + 12, y + 64 + j * 9, { size: 7, color: C.ink3 }),
        );
      }
    });
    this.y += h + 22;
  }

  private sectionTitle(title: string, subtitle?: string) {
    this.rect(M, this.y - 1, 3, 12, C.navy, 1.5);
    this.text(title, M + 10, this.y + 9, { size: 11, bold: true, color: C.navy });
    if (subtitle) this.text(subtitle, M + 10, this.y + 22, { size: 8, color: C.ink3 });
    this.y += subtitle ? 34 : 22;
  }

  private recency() {
    const { recent, older } = this.a.recency;
    const [rp, op] = allocatePercents([recent.value, older.value]);
    const undatedNote =
      this.a.undatedCount > 0
        ? undatedSplitNote(this.a.undatedCount, this.a.undated.value, this.money)
        : undefined;
    this.ensure(undatedNote ? 128 : 110);
    this.sectionTitle(
      "How recently the work was declined",
      `Split at ${RECENT_DAYS} days since the work was declined.`,
    );
    const y = this.y;
    this.rect(M, y, W, 8, C.slate100, 4);
    const total = recent.value + older.value || 1;
    const rw = recent.value > 0 ? Math.max((W - 3) * (recent.value / total), 4) : 0;
    const ow = older.value > 0 ? W - 3 - rw : 0;
    if (rw) this.rect(M, y, rw + (ow ? 0 : 3), 8, C.amber, 4);
    if (ow) this.rect(M + rw + 3, y, ow, 8, C.slate300, 4);

    const cols: [Bucket, number, string, boolean][] = [
      [recent, rp, C.amber, false],
      [older, op, C.slate300, true],
    ];
    for (const [b, pct, color, right] of cols) {
      const x = right ? M + W : M;
      const align = right ? "right" : "left";
      const label = b.label;
      const lw = this.width(label, 8);
      this.dot(right ? x - lw - 7 : x + 3, y + 25, color);
      this.text(label, right ? x : x + 10, y + 28, { size: 8, color: C.ink2, align });
      this.text(this.money(b.value), x, y + 50, { size: 17, bold: true, color: C.ink, align });
      this.text(
        `${b.count ? pct : 0}% of value · ${plural(b.count, "opportunity", "opportunities")}`,
        x,
        y + 63,
        { size: 8, color: C.ink3, align },
      );
    }
    if (undatedNote) {
      this.hline(y + 74, C.line);
      this.text(undatedNote, M, y + 88, { size: 8, color: C.ink3 });
      this.y = y + 106;
      return;
    }
    this.y = y + 88;
  }

  private breakdown(
    title: string,
    subtitle: string,
    buckets: Bucket[],
    color: (b: Bucket, i: number) => string,
    withDots = false,
    /** Undated work: listed after the bars without one, plus a total row. */
    unknown?: Bucket,
  ) {
    const rowH = 19;
    const extra = unknown && unknown.count > 0 ? unknown : undefined;
    const all = extra ? [...buckets, extra] : buckets;
    // Keep short sections together; long ones flow row by row.
    this.ensure(Math.min(34 + (all.length + (extra ? 1 : 0)) * rowH + 8, 260));
    this.sectionTitle(title, subtitle);
    const shares = allocatePercents(all.map((b) => b.value));
    const max = Math.max(...buckets.map((b) => b.value), 1);
    const labelW = 130;
    const barX = M + labelW + 8;
    const barW = 190;
    const amountX = barX + barW + 72;

    buckets.forEach((b, i) => {
      this.ensure(rowH);
      const y = this.y;
      const c = color(b, i);
      let lx = M;
      if (withDots) {
        this.dot(M + 3, y + 5.5, c);
        lx += 11;
      }
      this.text(this.truncate(b.label, labelW - (lx - M), 8.5), lx, y + 8.5, {
        size: 8.5,
        color: C.ink,
      });
      this.rect(barX, y + 3, barW, 5, C.slate100, 2.5);
      this.rect(barX, y + 3, Math.max(barW * (b.value / max), b.value > 0 ? 3 : 0), 5, c, 2.5);
      this.text(this.money(b.value), amountX, y + 8.5, {
        size: 8.5,
        bold: true,
        color: C.ink,
        align: "right",
      });
      this.text(
        `${plural(b.count, "opportunity", "opportunities")} · ${shares[i]}% of value`,
        M + W,
        y + 8.5,
        { size: 7.5, color: C.ink3, align: "right" },
      );
      if (i < buckets.length - 1) this.hline(y + 14, C.slate100);
      this.y += rowH;
    });

    if (extra) {
      const summary = (
        label: string,
        b: Bucket,
        pct: number,
        bold: boolean,
      ) => {
        this.ensure(rowH);
        const y = this.y;
        this.hline(y - 5, C.line);
        this.text(label, M, y + 8.5, { size: 8.5, bold, color: bold ? C.ink : C.ink2 });
        this.text(this.money(b.value), amountX, y + 8.5, {
          size: 8.5,
          bold: true,
          color: C.ink,
          align: "right",
        });
        this.text(
          `${plural(b.count, "opportunity", "opportunities")} · ${pct}% of value`,
          M + W,
          y + 8.5,
          { size: 7.5, color: C.ink3, align: "right" },
        );
        this.y += rowH;
      };
      this.y += 4;
      summary(extra.label, extra, shares[buckets.length], false);
      summary(
        "Total",
        {
          label: "Total",
          count: all.reduce((s, b) => s + b.count, 0),
          value: all.reduce((s, b) => s + b.value, 0),
        },
        shares.reduce((s, p) => s + p, 0),
        true,
      );
    }
    this.y += 18;
  }

  // ------------------------------------------------------------ table

  private readonly col = {
    rank: M,
    opp: M + 26,
    oppW: 226,
    cat: M + 264,
    catW: 104,
    date: M + 378,
    dateW: 78,
    amountR: M + W - 6,
  };

  private tableHeader() {
    const y = this.y;
    this.rect(M, y, W, 20, C.canvas);
    this.hline(y + 20);
    const o = { size: 6.5, bold: true, color: C.ink3, charSpace: 0.8 } as const;
    this.text("#", this.col.rank + 8, y + 13, o);
    this.text("OPPORTUNITY", this.col.opp, y + 13, o);
    this.text("CATEGORY", this.col.cat, y + 13, o);
    this.text("DECLINED", this.col.date, y + 13, o);
    this.text("AMOUNT", this.col.amountR, y + 13, { ...o, align: "right" });
    this.y += 20;
  }

  private rowLayout(o: Opportunity) {
    const k = this.col;
    const service = this.wrap(o.service, k.oppW, 9, true, 3);
    const who = [o.customer, o.vehicle].filter(Boolean).join(" · ");
    const whoLines = who ? this.wrap(who, k.oppW, 8, false, 2) : [];
    const contact = [o.phone, o.email].filter(Boolean).join(" · ");
    const contactLines = contact ? this.wrap(contact, k.oppW, 7, false, 1) : [];
    const recent = o.ageDays !== undefined && o.ageDays <= RECENT_DAYS;
    const tags = [recent && `Last ${RECENT_DAYS} days`, o.possibleDuplicate && "Possible duplicate"].filter(
      Boolean,
    ) as string[];
    const catLines = this.wrap(o.category, k.catW - 10, 8, false, 2);
    const left =
      service.length * 11 + whoLines.length * 10 + contactLines.length * 9 + (tags.length ? 12 : 0);
    const height = Math.max(left, catLines.length * 10, 22) + 16;
    return { service, whoLines, contactLines, tags, catLines, height };
  }

  private table() {
    const a = this.a;
    const rows = a.ranked.slice(0, TABLE_ROWS);
    const first = this.rowLayout(rows[0]);
    this.ensure(34 + 20 + first.height);
    this.sectionTitle(
      "Highest-value opportunities",
      a.count > TABLE_ROWS
        ? `The ${TABLE_ROWS} largest declined jobs in this report.`
        : "The largest declined jobs in this report.",
    );
    this.tableHeader();

    rows.forEach((o, i) => {
      const L = this.rowLayout(o);
      if (this.y + L.height > BOTTOM) {
        this.newPage();
        this.tableHeader();
      }
      const y = this.y;
      const k = this.col;
      const top = i < 3;

      if (top) this.rect(M, y + 6, 2.5, L.height - 12, C.amber, 1);
      this.rect(k.rank + 5, y + 8, 16, 16, top ? C.amberSoft : C.slate100, 4);
      this.text(String(i + 1), k.rank + 13, y + 19, {
        size: 7.5,
        bold: true,
        color: top ? C.amberInk : C.ink2,
        align: "center",
      });

      let ly = y + 18;
      L.service.forEach((l) => {
        this.text(l, k.opp, ly, { size: 9, bold: true, color: C.ink });
        ly += 11;
      });
      L.whoLines.forEach((l) => {
        this.text(l, k.opp, ly, { size: 8, color: C.ink2 });
        ly += 10;
      });
      L.contactLines.forEach((l) => {
        this.text(l, k.opp, ly, { size: 7, color: C.ink3 });
        ly += 9;
      });
      if (L.tags.length) {
        let tx = k.opp;
        L.tags.forEach((t, j) => {
          const recentTag = j === 0 && t.startsWith("Last");
          if (recentTag) {
            this.dot(tx + 2, ly - 2.2, C.amber, 1.8);
            tx += 7;
          }
          this.text(t, tx, ly, { size: 7, color: recentTag ? C.amberInk : C.ink3 });
          tx += this.width(t, 7) + 10;
        });
      }

      this.dot(k.cat + 3, y + 15.5, C.slate400, 2);
      L.catLines.forEach((l, j) =>
        this.text(l, k.cat + 10, y + 18 + j * 10, { size: 8, color: C.ink2 }),
      );

      if (o.date && o.ageDays !== undefined) {
        this.text(formatDate(o.date), k.date, y + 18, { size: 8, color: C.ink2 });
        this.text(`${formatAge(o.ageDays)} ago`, k.date, y + 28, { size: 7, color: C.ink3 });
      } else {
        this.text("No date", k.date, y + 18, { size: 8, color: C.ink3 });
      }

      const amount = this.money(o.amount);
      const amountW = k.amountR - (k.date + k.dateW + 6);
      this.text(amount, k.amountR, y + 18.5, {
        size: this.fit(amount, amountW, top ? 10.5 : 9.5, 6.5),
        bold: true,
        color: C.ink,
        align: "right",
      });

      this.y += L.height;
      this.hline(this.y, C.line);
    });

    if (a.count > rows.length) {
      this.ensure(22);
      this.text(
        `Showing the ${rows.length} largest of ${a.count.toLocaleString("en-US")} opportunities. Download the CSV for the full list.`,
        M,
        this.y + 14,
        { size: 7.5, color: C.ink3 },
      );
      this.y += 22;
    }
    this.y += 18;
  }

  private notes() {
    const notes = this.input.notes;
    const lines = notes.map((n) => this.wrap(n, W - 14, 8.5));
    const h = 34 + (notes.length ? lines.reduce((s, l) => s + l.length * 11 + 4, 0) : 14);
    this.ensure(Math.min(h, 200));
    this.sectionTitle("About this analysis", "File-quality notes from this scan.");
    if (!notes.length) {
      this.text("No file-quality issues detected.", M, this.y + 4, { size: 8.5, color: C.ink2 });
      this.y += 16;
      return;
    }
    lines.forEach((ls) => {
      this.ensure(ls.length * 11 + 4);
      this.dot(M + 3, this.y + 1.5, C.slate400, 1.6);
      ls.forEach((l, j) => this.text(l, M + 12, this.y + 4 + j * 11, { size: 8.5, color: C.ink2 }));
      this.y += ls.length * 11 + 4;
    });
  }
}
