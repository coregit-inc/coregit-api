import { unzipSync } from "fflate";
import { validateFilePath } from "../git/validation";

export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB decompressed limit

function stripRoot(fullPath: string): string {
  const parts = fullPath.split("/");
  return parts.slice(1).join("/");
}

export function extractZipArchive(buffer: Uint8Array): ArchiveFile[] {
  const extracted: ArchiveFile[] = [];
  const archive = unzipSync(buffer);
  let totalBytes = 0;
  for (const [name, contents] of Object.entries(archive)) {
    if (name.endsWith("/")) continue;
    totalBytes += contents.byteLength;
    if (totalBytes > MAX_DECOMPRESSED_BYTES) {
      throw new Error(`Decompressed archive exceeds ${MAX_DECOMPRESSED_BYTES / 1024 / 1024} MB limit`);
    }
    const normalized = stripRoot(name);
    if (!normalized || normalized.startsWith(".git")) continue;
    if (validateFilePath(normalized)) continue; // skip invalid/traversal paths
    extracted.push({ path: normalized, data: contents });
  }
  return extracted;
}
