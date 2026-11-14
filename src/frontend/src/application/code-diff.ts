export type DiffLine = { kind: "added" | "removed" | "same"; text: string };
/** Bounded line diff for on-screen human review; no code execution. */
export function lineDiff(before: string | null, after: string): DiffLine[] {
  const left = (before ?? "").split("\n"), right = after.split("\n");
  if (left.length > 350 || right.length > 350) {
    return [
      { kind: "removed", text: "(File too large for line diff: inspect full old/new content)" },
      ...left.slice(0, 30).map(text => ({ kind: "removed" as const, text })),
      ...right.slice(0, 30).map(text => ({ kind: "added" as const, text })),
    ];
  }
  const table: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      out.push({ kind: "same", text: left[i++] }); j++;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      out.push({ kind: "added", text: right[j++] });
    } else out.push({ kind: "removed", text: left[i++] });
  }
  return out;
}
