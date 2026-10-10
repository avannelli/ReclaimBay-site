import type { jsPDF } from "jspdf";
import { BRAND } from "./brand";
import { formatDate, formatDateTime, moneyFormat } from "./format";
import type { Analysis, Opportunity } from "./types";

/* A print-native review, drawn locally with jsPDF. No DOM capture or network requests. */
const C = {
  navy: "#0b2238",
  amber: "#f2a51a",
  ink: "#10263c",
  muted: "#44576b",
  line: "#dee2dd",
};
const PAGE_W = 612; // US Letter, points
const M = 48;
const W = PAGE_W - M * 2;
const BOTTOM = 716;
const BODY_TOP = 100;
const CALCULATION_NOTE =
  "Readable, positive declined amounts are totaled. Included jobs are ranked by value, then newer date on ties. Identical records sharing a unique record ID are counted once. Matching records without a unique ID remain in the total and are flagged for review.";
const FINAL_NOTE =
  "Before following up, confirm job status and whether the work was completed elsewhere. These are reported estimates, not recovered revenue. ReclaimBay does not track recovery or contact your customers.";

export interface SummaryInput {
  analysis: Analysis;
  fileName: string;
  isSample: boolean;
  /** Report checks, exactly as shown in the browser report. */
  notes: string[];
  /** When the report was analyzed, in the viewer's local time. */
  analyzedAt: Date;
}

// Reliable built-in PDF fonts: Helvetica body/data, Times for editorial headings.
// Preserve the existing Latin-1 fallback; unsupported characters become "?".
const EXTRA_OK = new Set("–—‘’“”•…€™");
const clean = (s: string) =>
  Array.from(s)
    .map((ch) => {
      if (ch === "\n") return ch;
      if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) return " ";
      return ch.charCodeAt(0) <= 0xff || EXTRA_OK.has(ch) ? ch : "?";
    })
    .join("");

/** Also used by PDF tests; the same local document is passed to the download. */
export async function createSummaryPdf(input: SummaryInput): Promise<jsPDF> {
  const [{ jsPDF: JsPDF }, { PDF_LOGO_LOCKUP }] = await Promise.all([
    import("jspdf"),
    import("./brandRaster"),
  ]);
  const doc = new JsPDF({ unit: "pt", format: "letter", compress: true });
  doc.setProperties({
    title: `${BRAND.name} — Declined Work Revenue Review`,
    creator: BRAND.name,
  });
  new SummaryWriter(doc, input, PDF_LOGO_LOCKUP).write();
  return doc;
}

export async function downloadSummaryPdf(input: SummaryInput, saveAs: string) {
  const doc = await createSummaryPdf(input);
  doc.save(saveAs);
}

interface LogoImage {
  data: string;
  width: number;
  height: number;
}
interface TextOpts {
  size: number;
  color?: string;
  bold?: boolean;
  editorial?: boolean;
  align?: "left" | "right";
}
interface RowLine {
  text: string;
  size: number;
  bold?: boolean;
  color: string;
  leading: number;
}

class SummaryWriter {
  private y = BODY_TOP;
  private readonly a: Analysis;
  private readonly money: (n: number) => string;
  private readonly col = {
    job: M + 28,
    jobW: 300,
    date: M + 344,
    value: M + W,
    valueW: 90,
  };

  constructor(
    private readonly doc: jsPDF,
    private readonly input: SummaryInput,
    private readonly logo: LogoImage,
  ) {
    this.a = input.analysis;
    this.money = moneyFormat(this.a.showCents);
  }

  private font(size: number, bold = false, editorial = false) {
    this.doc.setFont(
      editorial ? "times" : "helvetica",
      editorial ? "italic" : bold ? "bold" : "normal",
    );
    this.doc.setFontSize(size);
  }

  private text(str: string, x: number, y: number, opts: TextOpts) {
    this.font(opts.size, opts.bold, opts.editorial);
    this.doc.setTextColor(opts.color ?? C.ink);
    this.doc.text(clean(str), x, y, {
      align: opts.align ?? "left",
      baseline: "alphabetic",
    });
  }

  private width(str: string, size: number, bold = false) {
    this.font(size, bold);
    return this.doc.getTextWidth(clean(str));
  }

  private fit(str: string, width: number, start: number, min = 9) {
    let size = start;
    while (size > min && this.width(str, size, true) > width) size -= 0.5;
    return size;
  }

  private wrap(
    str: string,
    width: number,
    size: number,
    bold = false,
    maxLines?: number,
  ): string[] {
    this.font(size, bold);
    const lines = this.doc.splitTextToSize(clean(str), width - 3) as string[];
    if (!maxLines || lines.length <= maxLines) return lines;
    const result = lines.slice(0, maxLines);
    let last = result[maxLines - 1];
    while (last.length && this.width(`${last}...`, size, bold) > width)
      last = last.slice(0, -1);
    result[maxLines - 1] = `${last.trimEnd()}...`;
    return result;
  }

  private rule(
    y: number,
    color = C.line,
    weight = 0.6,
    left = M,
    right = M + W,
  ) {
    this.doc.setDrawColor(color);
    this.doc.setLineWidth(weight);
    this.doc.line(left, y, right, y);
  }

  private pageHeader() {
    // Reuse the approved reverse logo on a compact navy label, rather than a full-page band.
    this.doc.setFillColor(C.navy);
    this.doc.rect(M, 36, 128, 30, "F");
    const height = 21;
    this.doc.addImage(
      this.logo.data,
      "PNG",
      M + 10,
      40,
      (height * this.logo.width) / this.logo.height,
      height,
    );
    this.text("DECLINED-WORK REVIEW", M + W, 49, {
      size: 9,
      color: C.muted,
      align: "right",
    });
    this.text(
      this.input.isSample
        ? "SAMPLE REPORT · FICTIONAL DATA"
        : "LOCAL REPORT ANALYSIS",
      M + W,
      65,
      {
        size: 8,
        color: C.muted,
        align: "right",
      },
    );
    this.rule(82);
    this.y = BODY_TOP;
  }

  private newPage() {
    this.doc.addPage();
    this.pageHeader();
  }
  private ensure(height: number) {
    if (this.y + height > BOTTOM) this.newPage();
  }

  /** Paragraphs flow at line boundaries; callers reserve headings with their first lines. */
  private paragraph(
    str: string,
    opts: TextOpts = { size: 10.5, color: C.muted },
    width = W,
    leading = 13,
  ) {
    const lines = this.wrap(str, width, opts.size, opts.bold);
    for (const line of lines) {
      this.ensure(leading);
      this.text(line, M, this.y + opts.size, opts);
      this.y += leading;
    }
    this.y += 8;
  }

  private section(title: string, minimumBody = 28) {
    this.ensure(32 + minimumBody);
    this.y += 8;
    this.text(title, M, this.y + 16, {
      size: 19,
      editorial: true,
      color: C.navy,
    });
    this.y += 24;
  }

  write() {
    this.pageHeader();
    this.summary();
    this.shortlist();
    // The findings page is followed by a complete working list, never capped at 25 jobs.
    this.newPage();
    this.table();
    this.evidence();
    this.methodology();
    this.nextStep();
    this.footers();
  }

  private summary() {
    this.text("Declined Work Revenue Review", M, this.y + 25, {
      size: 25,
      color: C.navy,
    });
    this.y += 46;
    this.paragraph(`Analyzed ${formatDateTime(this.input.analyzedAt)}`, {
      size: 10,
      color: C.muted,
    });
    this.paragraph(`Source report: ${this.input.fileName}`, {
      size: 10,
      color: C.muted,
    });
    if (this.input.isSample)
      this.paragraph(
        "Fictional data for a sample review. These are not real customer jobs.",
        { size: 10, color: C.muted },
      );
    this.ensure(135);
    const top = this.y + 4;
    this.rule(top, C.navy, 1);
    this.rule(top, C.amber, 2, M, M + 32);
    this.text("REPORTED DECLINED VALUE", M, top + 22, {
      size: 9,
      bold: true,
      color: C.muted,
    });
    this.text("OPPORTUNITIES TO REVIEW", M + 354, top + 22, {
      size: 9,
      bold: true,
      color: C.muted,
    });
    const total = this.money(this.a.total);
    this.text(total, M, top + 65, {
      size: this.fit(total, 328, 36, 18),
      bold: true,
      color: C.navy,
    });
    this.text(this.a.count.toLocaleString("en-US"), M + 354, top + 65, {
      size: 32,
      color: C.navy,
    });
    this.y = top + 88;
    this.paragraph(
      "Included declined work from your report. Current job status and any recovery need your review.",
    );
    this.paragraph("Reported declined value is not recovered revenue.", {
      size: 10.5,
      bold: true,
      color: C.navy,
    });
  }

  private rowLines(
    job: Opportunity,
    width: number,
    summary = false,
  ): RowLine[] {
    const service = this.wrap(
      job.service,
      width,
      11,
      true,
      summary ? 3 : undefined,
    );
    const who =
      [job.customer, job.vehicle].filter(Boolean).join(" / ") ||
      "Customer / vehicle not provided";
    const people = this.wrap(who, width, 10, false, summary ? 2 : undefined);
    return [
      ...service.map((text) => ({
        text,
        size: 11,
        bold: true,
        color: C.ink,
        leading: 14,
      })),
      ...people.map((text) => ({
        text,
        size: 10,
        color: C.muted,
        leading: 13,
      })),
      ...(job.possibleDuplicate
        ? [
            {
              text: "Possible duplicate — included in total",
              size: 9.5,
              color: C.muted,
              leading: 13,
            },
          ]
        : []),
    ];
  }

  private shortlist() {
    this.section("What deserves a second look", 75);
    this.paragraph(
      "Highest reported value first. Review the details before following up.",
      { size: 10.5, color: C.muted },
    );
    this.a.ranked.slice(0, 3).forEach((job, index) => {
      const lines = this.rowLines(job, 332, true);
      const height = Math.max(
        65,
        lines.reduce((sum, line) => sum + line.leading, 0) + 21,
      );
      this.ensure(height);
      const top = this.y;
      this.text(String(index + 1).padStart(2, "0"), M, top + 17, {
        size: 10,
        color: C.muted,
      });
      let baseline = top + 17;
      for (const line of lines) {
        this.text(line.text, M + 28, baseline, line);
        baseline += line.leading;
      }
      const value = this.money(job.amount);
      this.text(value, M + W, top + 18, {
        size: this.fit(value, 140, 13),
        bold: true,
        color: C.navy,
        align: "right",
      });
      this.text(
        job.date ? formatDate(job.date) : "Date not provided",
        M + W,
        top + 36,
        { size: 9.5, color: C.muted, align: "right" },
      );
      this.y += height;
      this.rule(this.y);
    });
    this.y += 14;
    this.paragraph(
      "The complete ranked list follows, with the source details retained for each job and the report's calculation notes.",
    );
  }

  private tableHeader() {
    const top = this.y;
    this.rule(top, C.navy, 0.8);
    const opts = { size: 8.5, bold: true, color: C.muted };
    this.text("JOB", M, top + 18, opts);
    this.text("SERVICE / CUSTOMER / VEHICLE", this.col.job, top + 18, opts);
    this.text("DECLINED", this.col.date, top + 18, opts);
    this.text("REPORTED", this.col.value, top + 12, {
      ...opts,
      align: "right",
    });
    this.text("VALUE", this.col.value, top + 23, { ...opts, align: "right" });
    this.rule(top + 31);
    this.y += 31;
  }

  private tablePage() {
    this.newPage();
    this.text("Opportunities to review — continued", M, this.y + 17, {
      size: 18,
      editorial: true,
      color: C.navy,
    });
    this.y += 32;
    this.tableHeader();
  }

  private table() {
    const first = this.a.ranked[0];
    this.section(
      "Opportunities to review",
      first
        ? Math.min(
            100,
            this.rowLines(first, this.col.jobW).reduce(
              (sum, l) => sum + l.leading,
              0,
            ) + 60,
          )
        : 60,
    );
    this.paragraph(
      `All ${this.a.count.toLocaleString("en-US")} included jobs, in the report's existing ranking. Job numbers refer to this list.`,
      { size: 10.5, color: C.muted },
    );
    this.tableHeader();
    this.a.ranked.forEach((job, index) => {
      const pending = this.rowLines(job, this.col.jobW);
      const value = this.money(job.amount);
      const valueSize = this.fit(value, this.col.valueW, 11);
      const valueLines = this.wrap(value, this.col.valueW, valueSize, true);
      const metadataHeight = Math.max(42, valueLines.length * 13 + 16);
      const height = Math.max(
        metadataHeight,
        pending.reduce((sum, line) => sum + line.leading, 0) + 16,
      );
      // Normal rows remain intact. A row taller than a whole page continues at a text-line boundary.
      if (this.y + height > BOTTOM && height <= BOTTOM - BODY_TOP - 63)
        this.tablePage();
      let continued = false;
      do {
        if (this.y + metadataHeight > BOTTOM) this.tablePage();
        const capacity = BOTTOM - this.y - 16 - (continued ? 14 : 0);
        let used = 0;
        const lines: RowLine[] = [];
        while (pending.length && used + pending[0].leading <= capacity) {
          const line = pending.shift()!;
          lines.push(line);
          used += line.leading;
        }
        const top = this.y;
        this.text(String(index + 1).padStart(2, "0"), M, top + 16, {
          size: 9.5,
          color: C.muted,
        });
        let baseline = top + 16;
        if (continued) {
          this.text("Same job — continued", this.col.job, baseline, {
            size: 9.5,
            color: C.muted,
          });
          baseline += 14;
        }
        for (const line of lines) {
          this.text(line.text, this.col.job, baseline, line);
          baseline += line.leading;
        }
        this.text(
          job.date ? formatDate(job.date) : "Not provided",
          this.col.date,
          top + 16,
          { size: 9, color: C.muted },
        );
        valueLines.forEach((line, i) => {
          this.text(line, this.col.value, top + 16 + i * 13, {
            size: valueSize,
            bold: true,
            color: C.navy,
            align: "right",
          });
        });
        this.y += Math.max(metadataHeight, used + 16 + (continued ? 14 : 0));
        this.rule(this.y);
        if (pending.length) {
          this.tablePage();
          continued = true;
        }
      } while (pending.length);
    });
    this.y += 8;
  }

  private evidence() {
    this.section("Where the numbers come from", 56);
    this.paragraph(
      "Jobs show the service and reported amount retained from each included record, with customer, vehicle and date when available. Original row numbers, raw cells and record IDs are not retained; job numbers refer to this ranked list. Compare these details with your source export.",
    );
  }

  private methodology() {
    // Preserve the supplied checks, while making browser-only and positional references explicit in print.
    const notes = this.input.notes.map((note) =>
      note
        .replace(
          /Review (it|them) in the list below\./g,
          "Review $1 in the opportunity list.",
        )
        .replace(
          'shown as "Unknown / invalid date" in the age breakdown',
          'shown as "Unknown / invalid date" in the browser report\'s age breakdown',
        ),
    );
    const checksHeight = notes.length
      ? 22 +
        notes.reduce(
          (height, note) => height + this.wrap(note, W, 10).length * 13 + 8,
          0,
        )
      : 34;
    const endingHeight =
      32 +
      this.wrap(CALCULATION_NOTE, W, 10.5).length * 13 +
      8 +
      checksHeight +
      8 +
      this.wrap(FINAL_NOTE, W, 10.5).length * 13 +
      8;
    // Keep a short calculation/closing block together instead of creating a page for only the final note.
    if (endingHeight <= BOTTOM - BODY_TOP) this.ensure(endingHeight);
    this.section("How the report was calculated", 56);
    this.paragraph(CALCULATION_NOTE);
    if (notes.length) {
      const firstNoteHeight = this.wrap(notes[0], W, 10).length * 13 + 8;
      this.ensure(22 + Math.min(firstNoteHeight, BOTTOM - BODY_TOP - 22));
      this.text("Report checks", M, this.y + 11, {
        size: 11,
        bold: true,
        color: C.navy,
      });
      this.y += 22;
      for (const [index, note] of notes.entries()) {
        const height = this.wrap(note, W, 10).length * 13 + 8;
        if (index > 0) this.ensure(Math.min(height, BOTTOM - BODY_TOP));
        this.paragraph(note, { size: 10, color: C.muted }, W, 13);
      }
    } else {
      const q = this.a.quality;
      this.paragraph(
        q.skippedRows || q.confirmedDuplicateRows || q.possibleDuplicateRows
          ? `Report checks: excluded amount rows ${q.skippedRows}; confirmed duplicates removed ${q.confirmedDuplicateRows}; extra matching rows retained ${q.possibleDuplicateRows}.`
          : "Report checks: no amount exclusions or duplicate flags.",
        { size: 10, color: C.muted },
        W,
        13,
      );
    }
  }

  private nextStep() {
    this.ensure(8 + this.wrap(FINAL_NOTE, W, 10.5).length * 13 + 8);
    this.rule(this.y + 4);
    this.y += 8;
    this.paragraph(FINAL_NOTE, { size: 10.5, color: C.navy });
  }

  private footers() {
    const total = this.doc.getNumberOfPages();
    for (let page = 1; page <= total; page++) {
      this.doc.setPage(page);
      this.rule(741);
      this.text("Reported declined value is not recovered revenue.", M, 755, {
        size: 8.5,
        color: C.muted,
      });
      this.text(`Page ${page} of ${total}`, M + W, 755, {
        size: 8.5,
        color: C.muted,
        align: "right",
      });
      this.text(`${BRAND.name} · Generated on your device.`, M, 769, {
        size: 8,
        color: C.muted,
      });
    }
  }
}
