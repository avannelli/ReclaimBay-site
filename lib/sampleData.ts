import type { ParsedTable, RawCell } from "./types";

/**
 * The "See an example" report: one fictional shop's declined-work export.
 * Entirely synthetic: made-up names, reserved 555-01xx phone numbers and
 * example.com emails. Dates are relative to today, so the follow-up groups
 * always demonstrate correctly. The rows deliberately cover what a real
 * export contains: several jobs on one vehicle, one customer with two
 * vehicles, email-only and no-contact customers, an old decline, an undated
 * line and a line without a customer name.
 */
export const SAMPLE_FILE_NAME = "Juniper Auto Care — sample declined work (fictional).csv";

const HEADERS = [
  "Customer Name",
  "Vehicle",
  "Declined Service",
  "Estimate Total",
  "Declined Date",
  "Phone",
  "Email",
];

// [customer, vehicle, service, amount, days ago (null = no date), phone, email]
type Row = [string, string, string, number, number | null, string, string];
const ROWS: Row[] = [
  ["Riley Chen", "2014 Ford F-150", "Timing belt and water pump", 1285, 12, "555-0110", ""],
  ["Riley Chen", "2014 Ford F-150", "Serpentine belt replacement", 235, 12, "555-0110", ""],
  ["Morgan Diaz", "2012 Chevrolet Silverado", "Front struts and mounts", 1140, 25, "555-0111", "morgan.diaz@example.com"],
  ["Morgan Diaz", "2012 Chevrolet Silverado", "Four-wheel alignment", 129.95, 25, "555-0111", "morgan.diaz@example.com"],
  ["Casey Rivera", "2016 Toyota Camry", "Front brake pads and rotors", 612.5, 8, "", "casey.rivera@example.com"],
  ["Casey Rivera", "2016 Toyota Camry", "Brake fluid flush", 149.99, 8, "", "casey.rivera@example.com"],
  ["Casey Rivera", "2019 Subaru Outback", "Battery replacement", 219.99, 61, "", "casey.rivera@example.com"],
  ["Quinn Foster", "2016 Kia Sorento", "Oil pan gasket leak repair", 485, 15, "555-0114", ""],
  ["Quinn Foster", "2016 Kia Sorento", "Spark plugs and ignition coils", 398, 15, "555-0114", ""],
  ["Sam Ortega", "2018 Ford Escape", "Set of four tires", 864, 33, "555-0115", "sam.ortega@example.com"],
  ["Drew Sullivan", "2020 Hyundai Elantra", "Wheel bearing replacement", 540, 70, "555-0116", ""],
  ["Reese Bennett", "", "Check engine light diagnostic", 135, 5, "555-0117", ""],
  ["Jordan Patel", "2013 Honda Accord", "Radiator replacement", 920, 112, "555-0118", ""],
  ["Taylor Brooks", "2018 Honda CR-V", "A/C compressor replacement", 1495, 140, "555-0119", "taylor.brooks@example.com"],
  ["Taylor Brooks", "2018 Honda CR-V", "A/C recharge and leak test", 210, 140, "555-0119", "taylor.brooks@example.com"],
  ["Avery Nguyen", "2011 Dodge Ram 1500", "Power steering rack replacement", 1385, 205, "", "avery.nguyen@example.com"],
  ["Jamie Ellis", "2017 Jeep Wrangler", "Control arm and ball joint", 780.25, 44, "", ""],
  ["Alex Morgan", "2015 Nissan Altima", "Catalytic converter replacement", 2140, 420, "555-0122", ""],
  ["Dana Whitfield", "2019 Toyota RAV4", "Transmission fluid service", 289, null, "555-0123", ""],
  ["", "2010 Honda Odyssey", "Exhaust muffler replacement", 445, 96, "", ""],
];

export function buildSampleTable(now: Date = new Date()): ParsedTable {
  const rows: RawCell[][] = ROWS.map(([customer, vehicle, service, amount, ago, phone, email]) => {
    let date = "";
    if (ago !== null) {
      const d = new Date(now);
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - ago);
      date = d.toLocaleDateString("en-US");
    }
    return [
      customer,
      vehicle,
      service,
      `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      date,
      phone,
      email,
    ];
  });
  return { fileName: SAMPLE_FILE_NAME, headers: HEADERS, rows };
}
