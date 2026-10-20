import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import contractsJson from "./contracts.json" with { type: "json" };
import { licenseFailure, PROPRIETARY_LICENSE } from "./licenses.mjs";

export const contracts = contractsJson;
export const manifestSchemaId = "counterpunch-plugin-manifest:v2";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_RATIO = 100;
const MAX_COMPRESSED = 20 * 1024 * 1024;
const DIST_INFO_CAP = 1024 * 1024;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function versionSortKey(version) {
  return version.split(".").map((part) => part.padStart(6, "0")).join(".");
}

function readCentralDirectory(bytes) {
  if (bytes.length > MAX_COMPRESSED) {
    return { error: "compressed wheel exceeds 20 MB" };
  }
  let eocd = -1;
  const start = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { error: "zip central directory not found" };
  const count = bytes.readUInt16LE(eocd + 10);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) return { error: "zip has too many entries" };
  const entries = [];
  let cursor = offset;
  let uncompressed = 0;
  for (let n = 0; n < count; n += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) return { error: "bad central directory entry" };
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compSize = bytes.readUInt32LE(cursor + 20);
    const uncompSize = bytes.readUInt32LE(cursor + 24);
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      return { error: `unsafe path ${name}` };
    }
    const madeBy = bytes.readUInt16LE(cursor + 4) >> 8;
    const external = bytes.readUInt32LE(cursor + 38);
    const unixMode = madeBy === 3 ? external >> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) return { error: `symlink ${name}` };
    uncompressed += uncompSize;
    entries.push({ name, method, compSize, uncompSize, localOffset, flags });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (uncompressed > MAX_UNCOMPRESSED) return { error: "uncompressed wheel exceeds 100 MB" };
  if (bytes.length > 0 && uncompressed / bytes.length > MAX_RATIO) {
    return { error: "zip expansion ratio too high" };
  }
  return { entries };
}

function inflateEntry(bytes, entry) {
  if (entry.uncompSize > DIST_INFO_CAP) return { error: `${entry.name} exceeds 1 MB` };
  const nameLen = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLen = bytes.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const slice = bytes.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return { text: slice.toString("utf8") };
  if (entry.method === 8) return { text: inflateRawSync(slice).toString("utf8") };
  return { error: `unsupported zip method ${entry.method}` };
}

function parseMetadata(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(" ")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!fields[key]) fields[key] = [];
    fields[key].push(value);
  }
  return fields;
}

function parseEntryPoints(text) {
  const groups = {};
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      groups[current] = groups[current] || [];
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    groups[current].push({
      name: line.slice(0, eq).trim(),
      target: line.slice(eq + 1).trim(),
    });
  }
  return groups;
}

function topModules(entries) {
  const modules = new Set();
  for (const entry of entries) {
    if (entry.name.endsWith(".dist-info/top_level.txt")) continue;
    const part = entry.name.split("/")[0];
    if (!part || part.endsWith(".dist-info")) continue;
    modules.add(part);
  }
  return [...modules];
}

export function inspectWheel(bytes, filename, options = {}) {
  const failures = [];
  const directory = readCentralDirectory(bytes);
  if (directory.error) return { failures: [directory.error] };
  const tag = filename.split("-").slice(-3).join("-").replace(/\.whl$/, "");
  const tags = tag.split("-");
  const wheelTag = tags.length >= 3 ? `${tags[tags.length - 3]}-${tags[tags.length - 2]}-${tags[tags.length - 1]}` : "";
  if (!contracts.wheelTags.includes(wheelTag) && wheelTag !== "py3-none-any") {
    failures.push(`wheel tag ${wheelTag} is not accepted`);
  }
  const distInfo = directory.entries.find((entry) => entry.name.endsWith(".dist-info/METADATA"));
  if (!distInfo) return { failures: [...failures, "METADATA missing"] };
  const metadataFile = inflateEntry(bytes, distInfo);
  if (metadataFile.error) return { failures: [...failures, metadataFile.error] };
  const metadata = parseMetadata(metadataFile.text);
  const name = (metadata.Name || [""])[0];
  const version = (metadata.Version || [""])[0];
  if (!VERSION_RE.test(version)) failures.push(`version ${version} is not X.Y.Z`);
  const normalized = filename.replaceAll("_", "-").toLowerCase();
  if (!normalized.startsWith(name.replaceAll("_", "-").toLowerCase() + "-")) {
    failures.push("filename does not start with distribution name");
  }
  if (!normalized.includes(`-${version}-`)) failures.push("filename version does not match METADATA");
  for (const requirement of metadata["Requires-Dist"] || []) {
    const dep = requirement.split(/[;<]/)[0].trim().toLowerCase().replaceAll("_", "-");
    if (!contracts.allowedDependencies.map((item) => item.toLowerCase()).includes(dep)) {
      failures.push(`dependency ${dep} is not allowed`);
    }
  }
  for (const entry of directory.entries) {
    if (entry.name.endsWith(".so") || entry.name.endsWith(".pyd") || entry.name.endsWith(".dylib")) {
      failures.push(`native module ${entry.name}`);
    }
  }
  const epEntry = directory.entries.find((entry) => entry.name.endsWith(".dist-info/entry_points.txt"));
  let groups = {};
  if (epEntry) {
    const ep = inflateEntry(bytes, epEntry);
    if (ep.error) failures.push(ep.error);
    else groups = parseEntryPoints(ep.text);
  }
  const known = new Set(contracts.types.map((type) => type.group));
  for (const group of Object.keys(groups)) {
    if (group.startsWith("counterpunch_") && !known.has(group)) {
      failures.push(`unknown entry point group ${group}`);
    }
  }
  if (options.manifest) {
    const declared = new Map();
    for (const plugin of options.manifest.plugins || []) {
      const spec = contracts.types.find((type) => type.type === plugin.type);
      if (!spec) {
        failures.push(`unknown plugin type ${plugin.type}`);
        continue;
      }
      const token = `${spec.type}:v${spec.contract}`;
      const supported = spec.editorSupports.map((n) => `${spec.type}:v${n}`);
      if (!supported.includes(plugin.contract)) {
        failures.push(`${plugin.pluginId} contract ${plugin.contract} is not supported`);
      } else if (plugin.contract !== token && !supported.includes(plugin.contract)) {
        failures.push(`${plugin.pluginId} contract mismatch`);
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){2,}$/.test(String(plugin.pluginId || ""))) {
        failures.push(`plugin id ${plugin.pluginId} must be a reverse-domain name with at least three parts`);
      }
      if (String(plugin.pluginId).startsWith("space.counterpunch.")) {
        failures.push(`reserved plugin id ${plugin.pluginId}`);
      }
      const list = groups[spec.group] || [];
      if (!list.some((item) => item.name === plugin.entryPoint)) {
        failures.push(`entry point ${spec.group}:${plugin.entryPoint} missing`);
      }
      declared.set(`${spec.group}:${plugin.entryPoint}`, true);
    }
    for (const spec of contracts.types) {
      for (const item of groups[spec.group] || []) {
        if (!declared.has(`${spec.group}:${item.name}`)) {
          failures.push(`undeclared entry point ${spec.group}:${item.name}`);
        }
      }
    }
    const ids = (options.manifest.plugins || []).map((plugin) => plugin.pluginId);
    if (new Set(ids).size !== ids.length) failures.push("duplicate plugin ids");
    if (options.manifest.package && name.replaceAll("_", "-") !== options.manifest.package.replaceAll("_", "-")) {
      failures.push("manifest package does not match METADATA Name");
    }
    const declaredLicense = String(options.manifest.license || "").trim();
    const licenseError = licenseFailure(declaredLicense, options.listingKind);
    if (licenseError) failures.push(licenseError);
    const expression = (metadata["License-Expression"] || [""])[0];
    if (expression !== declaredLicense) {
      failures.push(
        `License-Expression ${expression || "(missing)"} does not match manifest license ${declaredLicense || "(missing)"}`,
      );
    }
    if (declaredLicense === PROPRIETARY_LICENSE) {
      const packaged = packagedProprietaryLicense(directory, bytes, metadata);
      if (packaged.error) failures.push(packaged.error);
      else if (typeof options.proprietaryLicenseText !== "string" || options.proprietaryLicenseText.length === 0) {
        failures.push("proprietary license text was not provided");
      } else if (packaged.text !== options.proprietaryLicenseText) {
        failures.push("packaged proprietary license does not match the Counterpunch proprietary plugin license");
      }
    }
  }
  if (options.reservedNames?.some((reserved) => reserved.replaceAll("_", "-").toLowerCase() === name.replaceAll("_", "-").toLowerCase())) {
    failures.push(`distribution name ${name} collides with a reserved package`);
  }
  const modules = topModules(directory.entries);
  if (options.reservedModules) {
    for (const mod of modules) {
      if (options.reservedModules.has(mod)) failures.push(`top-level module ${mod} collides`);
    }
  }
  if (options.highestVersion && VERSION_RE.test(version) && compareVersions(version, options.highestVersion) <= 0) {
    failures.push(`version ${version} is not higher than ${options.highestVersion}`);
  }
  return {
    failures,
    name,
    version,
    modules,
    groups,
    sha256: sha256(bytes),
  };
}

function packagedProprietaryLicense(directory, bytes, metadata) {
  const names = metadata["License-File"] || [];
  if (!names.includes("LICENSE")) return { error: "License-File LICENSE missing" };
  const entry = directory.entries.find(
    (item) => item.name.endsWith(".dist-info/licenses/LICENSE") || item.name.endsWith(".dist-info/LICENSE"),
  );
  if (!entry) return { error: "License-File LICENSE is not in the wheel" };
  const file = inflateEntry(bytes, entry);
  if (file.error) return { error: file.error };
  return { text: file.text };
}

export function validateManifest(manifest) {
  const failures = [];
  if (!manifest || manifest.schema !== manifestSchemaId) failures.push("manifest schema must be v2");
  if (!manifest?.package) failures.push("manifest package is required");
  const licenseError = licenseFailure(manifest?.license);
  if (licenseError) failures.push(licenseError);
  if (!Array.isArray(manifest?.plugins) || manifest.plugins.length === 0) {
    failures.push("manifest plugins must be a non-empty array");
  }
  return failures;
}
