import type { ParsedTable, RawCell } from "./types";

/**
 * Entirely synthetic demo data: fictional names, reserved 555-01xx phone
 * numbers and example.com emails. Dates are relative to today so the age
 * breakdowns look realistic whenever the sample is opened.
 */
const HEADERS = [
  "Customer Name",
  "Vehicle",
  "Declined Service",
  "Estimate Total",
  "Declined Date",
  "Phone",
  "Email",
];

const CUSTOMERS = [
  "Alex Morgan", "Jordan Lee", "Casey Rivera", "Taylor Brooks", "Riley Chen",
  "Morgan Diaz", "Jamie Patel", "Drew Sullivan", "Avery Nguyen", "Quinn Foster",
  "Parker Reed", "Sam Ortega", "Reese Bennett", "Cameron Hayes", "Dana Whitfield",
];

const VEHICLES = [
  "2016 Toyota Camry", "2014 Ford F-150", "2018 Honda CR-V", "2012 Chevrolet Silverado",
  "2019 Subaru Outback", "2015 Nissan Altima", "2017 Jeep Wrangler", "2013 Honda Accord",
  "2020 Hyundai Elantra", "2011 Dodge Ram 1500", "2016 Kia Sorento", "2018 Ford Escape",
];

// [service, amount]
const JOBS: [string, number][] = [
  ["Front brake pads and rotors", 612.5],
  ["Rear brake pads and rotors", 548],
  ["Brake fluid flush", 149.99],
  ["Timing belt and water pump", 1285],
  ["Serpentine belt replacement", 235],
  ["Front struts and mounts", 1140],
  ["Control arm and ball joint", 780.25],
  ["Four-wheel alignment", 129.95],
  ["Set of four tires", 864],
  ["Transmission fluid service", 289],
  ["Coolant system flush", 175],
  ["Radiator replacement", 920],
  ["A/C compressor replacement", 1495],
  ["A/C recharge and leak test", 210],
  ["Alternator replacement", 655],
  ["Battery replacement", 219.99],
  ["Catalytic converter replacement", 2140],
  ["Oil pan gasket leak repair", 485],
  ["Spark plugs and ignition coils", 398],
  ["Fuel injector cleaning service", 189],
  ["Wheel bearing replacement", 540],
  ["Check engine light diagnostic", 135],
  ["Cabin air filter and wipers", 89.5],
  ["Power steering rack replacement", 1385],
  ["Exhaust muffler replacement", 445],
];

// Ages in days, spread across the reporting buckets.
const AGES = [3, 8, 14, 21, 27, 35, 44, 52, 61, 73, 85, 97, 118, 140, 166, 192, 231, 275, 318, 352, 401, 470];

export function buildSampleTable(now: Date = new Date()): ParsedTable {
  const rows: RawCell[][] = [];
  for (let i = 0; i < 38; i++) {
    const [service, amount] = JOBS[(i * 7) % JOBS.length];
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - AGES[(i * 5) % AGES.length] - (i % 3));
    rows.push([
      CUSTOMERS[i % CUSTOMERS.length],
      VEHICLES[(i * 5) % VEHICLES.length],
      service,
      `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      date.toLocaleDateString("en-US"),
      `555-01${String(10 + (i % 90)).padStart(2, "0")}`,
      `customer${i + 1}@example.com`,
    ]);
  }
  return {
    fileName: "Sample report (synthetic data)",
    headers: HEADERS,
    rows,
  };
}
