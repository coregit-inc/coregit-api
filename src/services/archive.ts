import { unzipSync } from "fflate";

export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

function stripRoot(fullPath: string): string {
  const parts = fullPath.split("/");
  return parts.slice(1).join("/");
}

export function extractZipArchive(buffer: Uint8Array): ArchiveFile[] {
  const extracted: ArchiveFile[] = [];
  const archive = unzipSync(buffer);
  for (const [name, contents] of Object.entries(archive)) {
    if (name.endsWith("/")) continue;
    const normalized = stripRoot(name);
    if (!normalized || normalized.startsWith(".git")) continue;
    extracted.push({ path: normalized, data: contents });
  }
  return extracted;
}
