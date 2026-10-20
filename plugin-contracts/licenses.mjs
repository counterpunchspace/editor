export const FREE_SOFTWARE_LICENSES = [
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Apache-2.0",
  "MPL-2.0",
];

export const PROPRIETARY_LICENSE = "LicenseRef-Counterpunch-Proprietary";

export const KNOWN_LICENSES = [...FREE_SOFTWARE_LICENSES, PROPRIETARY_LICENSE];

export function licenseFailure(license, kind) {
  const value = String(license || "").trim();
  if (!KNOWN_LICENSES.includes(value)) {
    return `license ${value || "(missing)"} is not accepted`;
  }
  if (kind === "free" && value === PROPRIETARY_LICENSE) {
    return "a free listing must use a free-software license";
  }
  if (kind && kind !== "free" && kind !== "commercial") {
    return `listing ${kind} is not accepted`;
  }
  return "";
}
