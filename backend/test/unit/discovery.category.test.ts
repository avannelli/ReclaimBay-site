import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { AUTOMOTIVE_CATEGORY_RULES, nameCategory } from "../../src/discovery/categories.js";
import {
  automatedMayReplace,
  categoryFields,
  checkName,
  checkWebsite,
  isOutsideTarget,
  type CategoryRules,
  type CategoryVerdict,
} from "../../src/discovery/categoryCheck.js";

const verdict = (name: string) => nameCategory({ businessName: name, category: "automotive_repair", categoryTier: "core" }).verdict;

describe("category check: ReclaimBay names (automotive@c1)", () => {
  const cases: [CategoryVerdict, string[]][] = [
    [
      "wrong_category",
      [
        "Able Auto Glass",
        "Mario's Auto Body",
        "Streamline Garage Doors",
        "URO Parts",
        "Larry Dudley Yacht Sales",
        "Intoxalock Ignition Interlock",
        "Wrap Labs",
        "Caliber Collision",
      ],
    ],
    ["in_target", ["Bill Hahn's Automotive", "Pops One Stop Repair Shop", "Brakes & Wheels - Complete Auto Service", "Clean Planet Smog Check and Auto Repairs"]],
    ["unclear", ["Auto Body & Repair", "German Tech Auto Repair and Sales"]],
  ];
  for (const [expected, names] of cases) {
    for (const name of names) test(`${name} → ${expected}`, () => assert.equal(verdict(name), expected));
  }

  test("'Cummins Sales and Service' is not wrong: sales, but also service", () => assert.equal(verdict("Cummins Sales and Service"), "unclear"));

  test("policy v1: tires, RV, trucks, smog, mobile mechanics", () => {
    // Tire-only names can't prove tire-only: unclear, never wrong on the name alone.
    assert.equal(verdict("Saticoy Tires & Wheels"), "unclear");
    assert.equal(verdict("Hi-Tech Auto & Tire Center"), "unclear", "a real, verified repair shop: never wrong from its name");
    assert.equal(verdict("Avenue Tire & Service"), "in_target");
    assert.equal(verdict("Valley Tire & Auto Repair"), "in_target");
    assert.equal(verdict("H & H Rv Repair & Storage"), "wrong_category", "RV repair is out, even with 'repair'");
    assert.equal(verdict("Quality Rv Repair"), "wrong_category");
    assert.equal(verdict("Whitney's Auto & Rv Care Center"), "unclear", "autos and RVs: may serve both, so a person looks");
    assert.equal(verdict("Heavy Duty Truck & Auto Repair"), "in_target", "it names auto repair: it also serves cars");
    assert.equal(verdict("Specialty Marine"), "wrong_category");
    assert.equal(verdict("Auto & Marine Repair"), "in_target");
    assert.equal(verdict("Ventura Heavy Duty Truck Repair"), "wrong_category");
    assert.equal(verdict("Coast Semi Truck Service"), "wrong_category");
    assert.equal(verdict("Santos Truck & Auto Repair"), "in_target", "light-duty truck repair is in");
    assert.equal(verdict("Simi Test Only Smog Center"), "wrong_category");
    assert.equal(verdict("Americar (Smog Check: Test Only)"), "wrong_category");
    assert.equal(verdict("Ventura Smog Test & Auto Repair"), "in_target");
    assert.equal(verdict("Oxnard Mobile Mechanic"), "in_target");
    assert.equal(verdict("David's Mobile Auto Glass"), "wrong_category", "mobile is neutral; the glass decides");
  });

  test("Spanish repair names are in scope", () => {
    assert.equal(verdict("Taller Mecánico Ortiz"), "in_target");
    assert.equal(verdict("Reparación de Autos Lopez"), "in_target");
  });

  test("'auto' alone is not repair evidence, and plain names keep the provider's category", () => {
    assert.equal(verdict("Mario's Auto Body"), "wrong_category");
    const r = nameCategory({ businessName: "Bill Hahn's Automotive", category: "automotive_repair", categoryTier: "core" });
    assert.deepEqual([r.verdict, r.source], ["in_target", "provider"]);
    assert.match(r.reason, /provider lists it as automotive_repair \(core\)/);
    const manual = nameCategory({ businessName: "Bill Hahn's Automotive" });
    assert.deepEqual([manual.verdict, manual.source], ["in_target", "name"], "a hand-added candidate has no provider category");
  });

  test("results carry the rule set and a quotable reason", () => {
    const r = nameCategory({ businessName: "Able Auto Glass" });
    assert.equal(r.rules, "automotive@c1");
    assert.equal(r.source, "name");
    assert.equal(r.sourceUrl, null);
    assert.match(r.reason, /auto glass, outside general automotive repair/);
  });
});

describe("category check: websites (automotive@c1)", () => {
  const POPS = [
    { url: "http://popsonestoprepairshop.com/", text: "HOME SHOE REPAIR BOOT REPAIR VACUUM REPAIR LAMP REPAIR SHARPENING SERVICE Pop's Camarillo 805 388 - 0700 Pop's Floorcare 805 504 - 9565" },
    { url: "http://popsonestoprepairshop.com/LUGGAGE_REPAIR.html", text: "Luggage repair: zippers, wheels and handles. Sewing machine service." },
  ];

  test("Pops One Stop Repair Shop: other trades and no automotive vocabulary → wrong category, quoting the evidence", () => {
    const r = checkWebsite(AUTOMOTIVE_CATEGORY_RULES, POPS, null)!;
    assert.equal(r.verdict, "wrong_category");
    assert.equal(r.source, "website");
    assert.equal(r.sourceUrl, "http://popsonestoprepairshop.com/");
    assert.match(r.reason, /^Website describes shoe repair, boot repair, vacuum repair, lamp repair, sharpening, luggage repair and sewing machines; no automotive services or vocabulary on the 2 pages read\.$/);
  });

  test("absence of automotive words alone is never wrong", () => {
    assert.equal(checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://gp.example/", text: "" }], null), null, "script-rendered page: nothing readable");
    assert.equal(checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://x.example/", text: "Welcome. Call us today." }], null), null, "too little to say anything");
    const sparse = checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://x.example/", text: "Welcome to our family business. ".repeat(30) }], null)!;
    assert.equal(sparse.verdict, "unclear", "readable, but names neither the target nor another trade");
    assert.equal(checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://x.example/", text: "We sharpen knives. ".repeat(40) }], null)!.verdict, "unclear", "one other trade is not enough");
  });

  test("Spanish automotive vocabulary counts as automotive", () => {
    const r = checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://taller.example/", text: "Taller mecánico. Reparamos frenos, motores y transmisiones de su vehículo. Afilado de cuchillos y reparación de zapatos y botas también." }], null);
    assert.notEqual(r?.verdict, "wrong_category");
  });

  test("automotive specialties (glass only) say nothing new about the category", () => {
    assert.equal(checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://glass.example/", text: "Auto glass and windshield replacement for every car and truck. ".repeat(10) }], null), null);
  });

  test("confirmed general repair is in target, with its source", () => {
    const r = checkWebsite(AUTOMOTIVE_CATEGORY_RULES, POPS, { url: "https://shop.example/services", what: "general repair services (brakes, engine diagnostics)" })!;
    assert.deepEqual([r.verdict, r.sourceUrl], ["in_target", "https://shop.example/services"]);
  });

  test("other trades alongside automotive work: unclear, not wrong", () => {
    const r = checkWebsite(AUTOMOTIVE_CATEGORY_RULES, [{ url: "https://mix.example/", text: "Car repair, brakes, and also lawn mower, boat and solar panel service." }], null)!;
    assert.equal(r.verdict, "unclear");
  });
});

describe("category check: what an automated result may replace", () => {
  const name = (v: CategoryVerdict) => ({ verdict: v, source: "name" as const, reason: "", sourceUrl: null, rules: "x@1" });
  const site = (v: CategoryVerdict) => ({ ...name(v), source: "website" as const });
  test("never a person's decision", () => {
    assert.equal(automatedMayReplace({ verdict: "in_target", source: "manual" }, site("wrong_category")), false);
    assert.equal(automatedMayReplace({ verdict: "wrong_category", source: "manual" }, name("in_target")), false);
  });
  test("name evidence never replaces website evidence; website evidence replaces name evidence", () => {
    assert.equal(automatedMayReplace({ verdict: "wrong_category", source: "website" }, name("in_target")), false);
    assert.equal(automatedMayReplace({ verdict: "in_target", source: "name" }, site("wrong_category")), true);
    assert.equal(automatedMayReplace({ verdict: "wrong_category", source: "name" }, site("in_target")), true, "confirmed repair beats a name");
    assert.equal(automatedMayReplace({ verdict: null, source: null }, name("unclear")), true);
  });
  test("a website 'unclear' never clears positive name evidence of wrong category", () => {
    assert.equal(automatedMayReplace({ verdict: "wrong_category", source: "name" }, site("unclear")), false);
    assert.equal(automatedMayReplace({ verdict: "in_target", source: "provider" }, site("unclear")), true);
  });
  test("stored fields: a person's decision has no rule set", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    assert.equal(categoryFields({ ...name("unclear"), source: "manual" }, at).categoryRules, null);
    assert.equal(categoryFields(name("unclear"), at).categoryRules, "x@1");
    assert.equal(isOutsideTarget({ categoryVerdict: "wrong_category" }), true);
    assert.equal(isOutsideTarget({ categoryVerdict: "unclear" }), false);
    assert.equal(isOutsideTarget({ categoryVerdict: null }), false, "not checked yet is not gated");
  });
});

describe("category check: the engine has no industry built in", () => {
  // A second vertical (veterinary clinics), entirely from its own rules.
  const VET: CategoryRules = {
    id: "veterinary@t1",
    target: "veterinary care",
    name: {
      inScope: [{ label: "veterinary care", pattern: /\bvet(?:erinary)?\b|\banimal hospital\b/ }],
      outOfScope: [
        { label: "grooming", pattern: /\bgroom\w*/, strength: "strong" },
        { label: "a pet store", pattern: /\bpet (?:store|supply|supplies)\b/, strength: "exclusive" },
        { label: "boarding", pattern: /\bboarding\b|\bkennels?\b/, strength: "weak" },
      ],
    },
    website: {
      targetNoun: "veterinary",
      vocabulary: [{ label: "veterinary", pattern: /\bvet\w*|\bvaccin\w*|\bspay\b|\bneuter\b/ }],
      otherTrades: [
        { label: "dog grooming", pattern: /\bgroom\w*/ },
        { label: "pet food", pattern: /\bpet food\b/ },
      ],
      minOtherTrades: 2,
      minReadableChars: 50,
    },
  };
  test("its own terms decide, with its own wording", () => {
    assert.equal(checkName(VET, { name: "Happy Paws Grooming" }).verdict, "wrong_category");
    assert.equal(checkName(VET, { name: "Grooming & Vet Clinic" }).verdict, "unclear");
    assert.equal(checkName(VET, { name: "Bark Pet Supply" }).verdict, "wrong_category");
    assert.equal(checkName(VET, { name: "Coastal Kennels" }).verdict, "unclear");
    assert.equal(checkName(VET, { name: "Oak Animal Hospital" }).verdict, "in_target");
    assert.match(checkName(VET, { name: "Happy Paws Grooming" }).reason, /outside veterinary care/);
    const w = checkWebsite(VET, [{ url: "https://paws.example/", text: "Dog grooming and premium pet food delivered." }], null)!;
    assert.equal(w.verdict, "wrong_category");
    assert.match(w.reason, /no veterinary services or vocabulary/);
    // An automotive shop name means nothing to this vertical.
    assert.equal(checkName(VET, { name: "Able Auto Glass" }).verdict, "in_target");
  });

  test("categoryCheck.ts contains no industry words", () => {
    const src = readFileSync(new URL("../../src/discovery/categoryCheck.ts", import.meta.url), "utf8").toLowerCase();
    for (const word of [/\bauto\b/, /automotive/, /\brepair/, /\bcars?\b/, /vehicle/, /brake/, /\btires?\b/, /glass/, /reclaimbay/]) {
      assert.ok(!word.test(src), `the engine mentions ${word}`);
    }
  });
});
