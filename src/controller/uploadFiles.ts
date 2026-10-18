// Validation of browse_act `upload` files. Runs in the controller BEFORE the
// page is touched, so a refusal here leaves no trace in the checkpoint journal.
import { UPLOAD_SAMPLES, textToBase64, type UploadSampleKind } from "./uploadSamples.js";

export const UPLOAD_MAX_FILES = 5;
/** Total decoded size of one upload call. */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_NAME_MAX = 100;

/** A file ready for the page script: always base64. */
export interface UploadPayloadFile {
  name: string;
  mimeType: string;
  base64: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function validateUploadFiles(
  raw: unknown,
): { ok: true; files: UploadPayloadFile[]; totalBytes: number } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'browse_act "upload" requires a non-empty "files" array.' };
  }
  if (raw.length > UPLOAD_MAX_FILES) {
    return { ok: false, error: `browse_act "upload" takes at most ${UPLOAD_MAX_FILES} files (got ${raw.length}).` };
  }
  const files: UploadPayloadFile[] = [];
  let totalBytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isRecord(entry)) return { ok: false, error: `browse_act "upload": files[${i}] must be an object.` };
    const name = entry.name;
    if (typeof name !== "string" || name.length < 1 || name.length > UPLOAD_NAME_MAX) {
      return { ok: false, error: `browse_act "upload": files[${i}].name must be 1 to ${UPLOAD_NAME_MAX} characters.` };
    }
    if (name.includes("/") || name.includes("\\")) {
      return { ok: false, error: `browse_act "upload": files[${i}].name must not contain / or \\.` };
    }
    const sources = (["text", "base64", "sample"] as const).filter((k) => entry[k] !== undefined && entry[k] !== null);
    if (sources.length !== 1) {
      return { ok: false, error: `browse_act "upload": files[${i}] needs exactly one of "text", "base64" or "sample".` };
    }
    const explicitMime = typeof entry.mimeType === "string" && entry.mimeType !== "" ? entry.mimeType : undefined;
    let base64: string;
    let mimeType: string;
    if (sources[0] === "text") {
      if (typeof entry.text !== "string") return { ok: false, error: `browse_act "upload": files[${i}].text must be a string.` };
      base64 = textToBase64(entry.text);
      mimeType = explicitMime ?? mimeFromName(name);
    } else if (sources[0] === "base64") {
      if (typeof entry.base64 !== "string") {
        return { ok: false, error: `browse_act "upload": files[${i}].base64 must be a string.` };
      }
      base64 = entry.base64.replace(/\s+/g, "");
      if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
        return { ok: false, error: `browse_act "upload": files[${i}].base64 is not valid base64.` };
      }
      mimeType = explicitMime ?? mimeFromName(name);
    } else {
      const sample = typeof entry.sample === "string" ? UPLOAD_SAMPLES[entry.sample as UploadSampleKind] : undefined;
      if (!Object.hasOwn(UPLOAD_SAMPLES, String(entry.sample)) || !sample) {
        return { ok: false, error: `browse_act "upload": files[${i}].sample must be png, jpg, pdf, txt or csv.` };
      }
      base64 = sample.base64;
      mimeType = explicitMime ?? sample.mimeType;
    }
    totalBytes += decodedLength(base64);
    if (totalBytes > UPLOAD_MAX_BYTES) {
      return { ok: false, error: `browse_act "upload": the files are larger than ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB in total.` };
    }
    files.push({ name, mimeType, base64 });
  }
  return { ok: true, files, totalBytes };
}
