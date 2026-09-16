// The country resources table. A country row must be complete before readers from that country enter;
// the session refuses with 451 otherwise. Numbers are the reader's own country's, shown on every screen.
// Rows here are the ones verified so far; add a row only after the number has been checked by hand.

export interface Resource { country: string; name: string; number: string; hours: string; note?: string }

export const RESOURCES: Record<string, Resource> = {
  EG: { country: "EG", name: "الخط الساخن للصحة النفسية", number: "08008880700", hours: "24/7", note: "تابع للأمانة العامة للصحة النفسية" },
  GB: { country: "GB", name: "Samaritans", number: "116 123", hours: "24/7" },
};

// Timezone to country, for the zones we expect first. Unknown zones are refused until their country row exists.
const TZ: Record<string, string> = {
  "Africa/Cairo": "EG",
  "Europe/London": "GB",
};

export function countryOf(timezone: string): string | null {
  return TZ[timezone] ?? null;
}
