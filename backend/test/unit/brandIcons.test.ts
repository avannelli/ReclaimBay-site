import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { appPage, loginPage } from "../../src/admin/views.js";
import { ICON_LINKS } from "../../src/routes/brandIcons.js";

/*
 * The admin's browser-tab icon is the public site's own: the same approved
 * files, byte for byte, and the same three icons. One source of truth.
 */

const site = (f: string) => readFileSync(new URL(`../../../app/${f}`, import.meta.url));
const backend = (f: string) => readFileSync(new URL(`../../assets/brand/${f}`, import.meta.url));

describe("the ReclaimBay tab icon in the admin", () => {
  test("the backend's icon files are the site's approved icons, unchanged", () => {
    for (const f of ["favicon.ico", "icon.svg", "apple-icon.png"]) assert.ok(backend(f).equals(site(f)), `${f}: copy app/${f} to backend/assets/brand/${f}`);
    assert.doesNotMatch(backend("icon.svg").toString("utf8"), /<script|\son[a-z]+\s*=|javascript:|href="http/i, "the SVG is a picture only");
  });

  test("every admin page, signed in or not, links the same three icons, from this service only", () => {
    assert.match(ICON_LINKS, /^<link rel="icon" href="\/favicon\.ico\?v=[0-9a-f]{12}" sizes="48x48" type="image\/x-icon"><link rel="icon" href="\/icon\.svg\?v=[0-9a-f]{12}" sizes="any" type="image\/svg\+xml"><link rel="apple-touch-icon" href="\/apple-touch-icon\.png\?v=[0-9a-f]{12}" sizes="180x180" type="image\/png">$/);
    for (const html of [appPage("Outreach · ReclaimBay admin", "outreach", "<p>x</p>"), appPage("Funnel", "funnel", ""), loginPage()]) {
      assert.equal(html.split(ICON_LINKS).length, 2, "exactly once, in the head");
      assert.ok(html.indexOf(ICON_LINKS) < html.indexOf("</head>"));
    }
  });
});
