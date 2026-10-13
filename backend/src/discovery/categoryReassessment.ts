// Reviewed October 12, 2026. Only these 33 stale name exclusions may be reassessed.
// This allowlist is inert until an admin batch or the armed worker applies a freshly checked plan.
import { nameCategory } from "./categories.js";
export const AUDITED_CATEGORY_CORRECTIONS = [
  {
    "id": "00b83fce-b4f1-4648-b7fc-351f84a39dcf",
    "name": "Barber's Machine Shop",
    "reason": "The name indicates a machine shop, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "0631ea43-55ee-481d-9000-f51d00128006",
    "name": "Cool Customs Body Shop",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "1414c65c-619b-4830-aff3-e6b4270938e2",
    "name": "C & S RV Service Center",
    "reason": "The name indicates RV repair, outside general automotive repair."
  },
  {
    "id": "144c5f72-747f-4f50-88e0-7644aa20cfb8",
    "name": "Paint By Kevin",
    "reason": "The name indicates paint, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "1ca730f9-1f2a-4005-a6e9-cac7012e62f4",
    "name": "Executive Paintworks",
    "reason": "The name indicates paint, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "1fc05b90-0f57-4192-a728-dcc4bc8a0b14",
    "name": "Auto Collision Center",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "21f77d59-c955-449e-ae05-73715616e76f",
    "name": "Buena Vista Collision",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "23da4082-9695-4eff-8e7e-d8a1718425b0",
    "name": "Pacific Carburetor Co",
    "reason": "The name indicates carburetors, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "2c6878e0-beb5-430d-ab24-24f4700ee5c6",
    "name": "Santa Paula Automotive Machine Shop",
    "reason": "The name indicates a machine shop, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "40c43f01-47c6-49a2-a39a-af8baf28d946",
    "name": "Vista Collision Center",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "43c76cad-6a4b-438f-aed2-c79277acb5af",
    "name": "Blue Kollar Auto Body and restoration",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "51d9b988-000d-4f2f-85e0-4ca2419a96d9",
    "name": "Autocraft Body & Paint",
    "reason": "The name indicates body work and paint, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "5341ffbb-0d56-4806-94fa-d089e6eb6f1e",
    "name": "Auto Body Unlimited",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "5b181468-7300-4820-a1c2-4b7e8a2c0de8",
    "name": "Royal Auto Collision Llc",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "6fd56b48-927d-4021-87ee-5bd3a298f255",
    "name": "Caliber Collision",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "6fd830cd-6613-4402-931e-1bc3092c1bf3",
    "name": "Zavala Carburetors",
    "reason": "The name indicates carburetors, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "7ec1e890-cb02-4cec-a66e-bdd523c934fd",
    "name": "Caliber Collision",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "7f7d546c-0bdf-40f9-836d-08fb7469ea75",
    "name": "H & H Rv Repair & Storage",
    "reason": "The name indicates RV repair, outside general automotive repair."
  },
  {
    "id": "8968cf2a-29af-42a3-90fb-30b65d5720a3",
    "name": "Tesla Collision Camarillo",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "91ffef26-1d88-4c99-9758-7384c8bc0267",
    "name": "A & G auto body",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "92bc5801-8cf7-4ad2-b12f-48bd3987e636",
    "name": "Superior Collision Center",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "94730c73-e93a-43d0-b006-1afcb5312737",
    "name": "E & I Paint & Body",
    "reason": "The name indicates body work and paint, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "9632994e-fc9e-4d33-91e2-7b85081bac80",
    "name": "Mission Oaks Auto Body",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "b9288887-bf76-40f3-bcf7-77b0391eb9b3",
    "name": "Jc's Body Shop",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "c42e817f-4fb4-4981-b362-7d1956f28571",
    "name": "Quality Rv Repair",
    "reason": "The name indicates RV repair, outside general automotive repair."
  },
  {
    "id": "c44d4fa9-8d50-49ee-b3f7-d12b432c3544",
    "name": "Esmir Auto Body & Paint Llc",
    "reason": "The name indicates body work and paint, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "c9c79174-5f84-46da-9c66-7b153453ee86",
    "name": "HH Autobody",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "cfd7eac7-ddb1-4658-86a6-4dd9a8eed65a",
    "name": "Mario's Auto Body",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "d58cba99-f3fd-435d-909a-ae286fa661cb",
    "name": "Tesla Collision Thousand Oaks",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "e2ed0b37-63de-4da3-8a81-ec9d4951e702",
    "name": "Star Auto Body",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "ee4183d9-34cd-4d59-8582-bf4da1d56b41",
    "name": "Quick Fix Auto Dent",
    "reason": "The name indicates body work, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "f81a33e2-335c-4c4a-bdac-6076a574ccb4",
    "name": "CNC Precision Machining",
    "reason": "The name indicates a machine shop, outside general automotive repair, and names no in-scope service."
  },
  {
    "id": "f8858625-7376-420d-ac94-1c02851d246f",
    "name": "Angie's Collision Center",
    "reason": "The name indicates collision repair, outside general automotive repair, and names no in-scope service."
  }
] as const;
export function auditedCategoryCorrection(c: { id: string; businessName: string; status: string; categoryVerdict: string | null; categorySource: string | null; categoryRules: string | null; categoryReason: string | null; providerCategory: string | null; categoryTier: string | null }) {
  const audited = AUDITED_CATEGORY_CORRECTIONS.find(a => a.id === c.id);
  if (!audited || c.businessName !== audited.name || c.status !== "discovered" || c.categoryVerdict !== "wrong_category" || c.categorySource !== "name" || c.categoryRules !== "automotive@c1" || c.categoryReason !== audited.reason) return null;
  const next = nameCategory({ businessName: c.businessName, category: c.providerCategory, categoryTier: c.categoryTier });
  return next.verdict === "unclear" ? next : null;
}
