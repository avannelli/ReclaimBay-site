import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import HeaderChooser from "../components/HeaderChooser";

test("ambiguous-header UI requires a choice and offers keeping every row", () => {
  const rows = [["Brake repair", 100], ["Transmission", 900]];
  const html = renderToStaticMarkup(<HeaderChooser
    table={{ fileName: "report.csv", headers: ["Column 1", "Column 2"], rows, pendingHeaderRows: rows }}
    onConfirm={() => undefined} onCancel={() => undefined} />);
  assert.match(html, /All 2 nonblank rows are still here/);
  assert.match(html, /No header.*keep every row/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Brake repair/);
  assert.match(html, /Rows above a chosen header/);
});
