/** Ordered rules: the first matching category wins, so specific ones come first. */
const RULES: { category: string; pattern: RegExp }[] = [
  { category: "Brakes", pattern: /brake|rotor|caliper|pads?\b|abs\b/i },
  { category: "Tires & Wheels", pattern: /tire|wheel|alignment|balanc|tpms|rotation/i },
  { category: "Suspension & Steering", pattern: /suspens|strut|shock|control arm|ball joint|tie rod|steering|bushing|sway|wheel bearing|cv (axle|joint)|rack/i },
  { category: "Cooling System", pattern: /coolant|radiator|thermostat|water pump|cooling|overheat|antifreeze/i },
  { category: "A/C & Heating", pattern: /\ba\/?c\b|air ?con|compressor|refrigerant|freon|heater|blower|condenser/i },
  { category: "Transmission & Drivetrain", pattern: /transmission|trans\b|clutch|differential|transfer case|drive ?shaft|axle|drivetrain/i },
  { category: "Exhaust & Emissions", pattern: /exhaust|muffler|catalytic|converter|o2|oxygen sensor|egr|emission/i },
  { category: "Electrical & Battery", pattern: /battery|alternator|starter|electrical|wiring|fuse|light|bulb|headlamp|sensor|module|window|switch/i },
  { category: "Engine & Performance", pattern: /engine|timing|belt|spark|ignition|coil|valve|gasket|head|misfire|fuel|injector|throttle|motor mount|serpentine|hose|leak|turbo/i },
  { category: "Maintenance & Fluids", pattern: /oil|filter|flush|fluid|tune ?up|service|inspection|maintenance|wiper|cabin/i },
  { category: "Diagnostics", pattern: /diagnos|check engine|scan|testing|inspect/i },
];

export const OTHER_CATEGORY = "Other";

export function categorize(service: string): string {
  return RULES.find((r) => r.pattern.test(service))?.category ?? OTHER_CATEGORY;
}
