/**
 * Unified diff generator (Myers algorithm).
 *
 * Produces standard unified diff output compatible with `git diff`.
 * Operates on string arrays (lines) — no external dependencies.
 */

interface Edit {
  type: "equal" | "insert" | "delete";
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

/**
 * Compute shortest edit script (Myers algorithm) between two line arrays.
 * Returns edits grouped into hunks.
 */
function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;

  if (max === 0) return [];

  // For very large files, bail out to avoid CPU exhaustion
  if (max > 20_000) {
    return [{
      type: "delete",
      oldStart: 0,
      newStart: 0,
      oldLines,
      newLines: [],
    }, {
      type: "insert",
      oldStart: n,
      newStart: 0,
      oldLines: [],
      newLines,
    }];
  }

  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  const trace: Int32Array[] = [];

  // Forward pass: find shortest edit path
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + max;
      let x: number;
      if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
        x = v[kIdx + 1]; // move down (insert)
      } else {
        x = v[kIdx - 1] + 1; // move right (delete)
      }
      let y = x - k;
      // Diagonal (equal)
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[kIdx] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, oldLines, newLines, n, m, max);
      }
    }
  }

  return [];
}

function backtrack(
  trace: Int32Array[],
  oldLines: string[],
  newLines: string[],
  n: number,
  m: number,
  max: number
): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const kIdx = k + max;

    let prevK: number;
    if (k === -d || (k !== d && prev[kIdx - 1] < prev[kIdx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = prev[prevK + max];
    const prevY = prevX - prevK;

    // Diagonal (equal lines)
    while (x > prevX + (prevK < k ? 1 : 0) && y > prevY + (prevK < k ? 0 : 1)) {
      x--;
      y--;
      edits.unshift({ type: "equal", oldStart: x, newStart: y, oldLines: [oldLines[x]], newLines: [newLines[y]] });
    }

    if (d > 0) {
      if (prevK < k) {
        // Delete
        x--;
        edits.unshift({ type: "delete", oldStart: x, newStart: y, oldLines: [oldLines[x]], newLines: [] });
      } else {
        // Insert
        y--;
        edits.unshift({ type: "insert", oldStart: x, newStart: y, oldLines: [], newLines: [newLines[y]] });
      }
    }
  }

  // Handle remaining diagonal at the start
  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.unshift({ type: "equal", oldStart: x, newStart: y, oldLines: [oldLines[x]], newLines: [newLines[y]] });
  }

  return edits;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Group edits into unified diff hunks with context lines.
 */
function createHunks(edits: Edit[], contextLines: number = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let lastChangeIdx = -1;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.type !== "equal") {
      if (!currentHunk) {
        // Start new hunk with preceding context
        const contextStart = Math.max(0, i - contextLines);
        currentHunk = {
          oldStart: 0,
          oldCount: 0,
          newStart: 0,
          newCount: 0,
          lines: [],
        };
        // Set hunk start from context
        let oldPos = edit.oldStart;
        let newPos = edit.newStart;
        for (let j = contextStart; j < i; j++) {
          oldPos--;
          newPos--;
        }
        currentHunk.oldStart = Math.max(0, oldPos);
        currentHunk.newStart = Math.max(0, newPos);

        // Add context lines before
        for (let j = contextStart; j < i; j++) {
          if (edits[j].type === "equal") {
            currentHunk.lines.push(` ${edits[j].oldLines[0]}`);
            currentHunk.oldCount++;
            currentHunk.newCount++;
          }
        }
      }

      if (edit.type === "delete") {
        currentHunk.lines.push(`-${edit.oldLines[0]}`);
        currentHunk.oldCount++;
      } else if (edit.type === "insert") {
        currentHunk.lines.push(`+${edit.newLines[0]}`);
        currentHunk.newCount++;
      }
      lastChangeIdx = i;
    } else if (currentHunk) {
      const distFromLastChange = i - lastChangeIdx;
      if (distFromLastChange <= contextLines * 2) {
        // Within context range — continue hunk
        currentHunk.lines.push(` ${edit.oldLines[0]}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
      } else if (distFromLastChange <= contextLines * 2 + 1) {
        // Trailing context
        currentHunk.lines.push(` ${edit.oldLines[0]}`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
      } else {
        // End hunk
        hunks.push(currentHunk);
        currentHunk = null;
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Generate unified diff string for a single file.
 */
export function unifiedFileDiff(
  oldPath: string,
  newPath: string,
  oldContent: string | null,
  newContent: string | null,
  contextLines: number = 3
): string {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];

  // Remove trailing empty line from split (if content ends with \n)
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === "") newLines.pop();

  const edits = myersDiff(oldLines, newLines);
  const hunks = createHunks(edits, contextLines);

  if (hunks.length === 0) return "";

  const header = [
    `--- a/${oldPath}`,
    `+++ b/${newPath}`,
  ];

  const hunkStrings = hunks.map((h) => {
    const oldStart = h.oldStart + 1; // 1-indexed
    const newStart = h.newStart + 1;
    return `@@ -${oldStart},${h.oldCount} +${newStart},${h.newCount} @@\n${h.lines.join("\n")}`;
  });

  return header.join("\n") + "\n" + hunkStrings.join("\n");
}

/**
 * Check if content is likely binary (has null bytes in first 8KB).
 */
export function isBinaryString(content: Uint8Array): boolean {
  const len = Math.min(content.length, 8192);
  for (let i = 0; i < len; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}
