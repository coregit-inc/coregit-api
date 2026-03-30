/**
 * Content-level 3-way merge using node-diff3.
 *
 * Automatically resolves non-overlapping changes in the same file,
 * eliminating false conflicts when both sides edit different regions.
 */

import { diff3Merge } from "node-diff3";

export interface MergeResult {
  success: boolean;
  mergedContent: string | null;
  conflictCount: number;
}

/**
 * Perform a 3-way merge of text content.
 *
 * @param base  - Common ancestor content
 * @param ours  - "Our" version (the cherry-pick / chat changes)
 * @param theirs - "Their" version (the current dev branch)
 * @returns MergeResult with merged content if successful
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  // Binary files — null bytes in first 8KB
  if (isBinary(base) || isBinary(ours) || isBinary(theirs)) {
    return { success: false, mergedContent: null, conflictCount: 1 };
  }

  // Size limit — files > 200KB skipped (safety for Workers)
  if (base.length > 200_000 || ours.length > 200_000 || theirs.length > 200_000) {
    return { success: false, mergedContent: null, conflictCount: 1 };
  }

  const oursLines = ours.split("\n");
  const baseLines = base.split("\n");
  const theirsLines = theirs.split("\n");

  const result = diff3Merge(oursLines, baseLines, theirsLines, {
    excludeFalseConflicts: true, // identical changes from both sides = not a conflict
  });

  let conflictCount = 0;
  const merged: string[] = [];

  for (const block of result) {
    if (block.ok) {
      merged.push(...block.ok);
    } else {
      conflictCount++;
    }
  }

  if (conflictCount === 0) {
    return { success: true, mergedContent: merged.join("\n"), conflictCount: 0 };
  }

  return { success: false, mergedContent: null, conflictCount };
}

function isBinary(content: string): boolean {
  const sample = content.slice(0, 8192);
  return sample.includes("\0");
}
