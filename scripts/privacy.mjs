import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const UNIT_SEPARATOR = "\x1f";
const BUILD_HOME = "C:\\build\\home";
const BUILD_PROJECT = "C:\\build\\project";
const GENERIC_PROFILE_PATHS = ["C:\\Users\\", "C:/Users/"];
const PUBLIC_SEGMENT = /^Public(?:[\\/]|$|\0)/i;

function normalizePath(value) {
  if (!value) return null;
  return resolve(String(value)).replaceAll("/", "\\").replace(/\\+$/, "");
}

function isUnder(child, parent) {
  return child.toLowerCase().startsWith(`${parent.toLowerCase()}\\`);
}

export function privatePathMappings(env = process.env, root = process.cwd()) {
  const home = normalizePath(env.USERPROFILE || homedir());
  const mappings = [];
  const add = (from, to) => {
    const path = normalizePath(from);
    if (!path) return;
    if (mappings.some(([existing]) => existing.toLowerCase() === path.toLowerCase())) return;
    mappings.push([path, to]);
    const slashPath = path.replaceAll("\\", "/");
    if (slashPath !== path) mappings.push([slashPath, to.replaceAll("\\", "/")]);
  };

  add(root, BUILD_PROJECT);
  for (const [name, target] of [
    ["CARGO_HOME", "cargo"],
    ["RUSTUP_HOME", "rustup"],
    ["TEMP", "temp"],
    ["TMP", "temp"],
  ]) {
    const path = normalizePath(env[name]);
    if (!path) continue;
    if (home && (path.toLowerCase() === home.toLowerCase() || isUnder(path, home))) continue;
    add(path, `${BUILD_HOME}\\${target}`);
  }
  add(home, BUILD_HOME);
  return mappings;
}

export function applyPrivateBuildEnv(env = process.env, root = process.cwd()) {
  const next = { ...env };
  const mappings = privatePathMappings(env, root);
  const rustFlags = mappings.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  const existing = next.CARGO_ENCODED_RUSTFLAGS
    ? next.CARGO_ENCODED_RUSTFLAGS.split(UNIT_SEPARATOR).filter(Boolean)
    : next.RUSTFLAGS
      ? next.RUSTFLAGS.split(/\s+/).filter(Boolean)
      : [];
  next.CARGO_ENCODED_RUSTFLAGS = [...existing, ...rustFlags].join(UNIT_SEPARATOR);
  delete next.RUSTFLAGS;

  if (process.platform === "win32") {
    const cFlags = [
      "/experimental:deterministic",
      ...mappings
        .filter(([from]) => !from.includes("/"))
        .map(([from, to]) => `/pathmap:${from}=${to}`),
    ].join(" ");
    next.CFLAGS = [next.CFLAGS, cFlags].filter(Boolean).join(" ");
    next.CXXFLAGS = [next.CXXFLAGS, cFlags].filter(Boolean).join(" ");
  }
  return next;
}

function addMarker(markers, label, value) {
  if (!value) return;
  const text = String(value).trim();
  if (text.length < 3) return;
  const variants = new Set([text, text.replaceAll("\\", "/"), text.replaceAll("/", "\\")]);
  for (const variant of variants) {
    if (!markers.some((marker) => marker.label === label && marker.value === variant)) {
      markers.push({ label, value: variant });
    }
  }
}

export function privateDataMarkers(env = process.env, root = process.cwd()) {
  const markers = [];
  const home = env.USERPROFILE || homedir();
  addMarker(markers, "Windows account name", env.USERNAME);
  addMarker(markers, "computer name", env.COMPUTERNAME);
  addMarker(markers, "Windows user profile path", home);
  addMarker(markers, "Windows user profile path", `${env.HOMEDRIVE || ""}${env.HOMEPATH || ""}`);
  addMarker(markers, "project path", root);
  for (const name of ["CARGO_HOME", "RUSTUP_HOME", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
    addMarker(markers, "build environment path", env[name]);
  }
  return markers;
}

function findGenericProfilePath(buffer, findings) {
  for (const pattern of GENERIC_PROFILE_PATHS) {
    for (const encoding of ["utf8", "utf16le"]) {
      const needle = Buffer.from(pattern, encoding);
      let index = buffer.indexOf(needle);
      while (index !== -1) {
        const width = encoding === "utf16le" ? 64 : 32;
        const following = buffer
          .subarray(index + needle.length, index + needle.length + width)
          .toString(encoding);
        if (!PUBLIC_SEGMENT.test(following)) {
          findings.add("another Windows user-profile path");
          return;
        }
        index = buffer.indexOf(needle, index + needle.length);
      }
    }
  }
}

export function scanBufferForPrivateData(buffer, markers) {
  const findings = new Set();
  for (const { label, value } of markers) {
    for (const encoding of ["utf8", "utf16le"]) {
      if (buffer.indexOf(Buffer.from(value, encoding)) !== -1) {
        findings.add(label);
      }
    }
  }
  findGenericProfilePath(buffer, findings);
  return [...findings];
}

function collectFiles(path) {
  const stats = lstatSync(path);
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export function scanPaths(paths, options = {}) {
  const markers =
    options.markers ??
    privateDataMarkers(options.env ?? process.env, options.root ?? process.cwd());
  const findings = [];
  for (const path of paths) {
    for (const file of collectFiles(path)) {
      const labels = scanBufferForPrivateData(readFileSync(file), markers);
      for (const label of labels) findings.push({ file, label });
    }
  }
  return findings;
}
