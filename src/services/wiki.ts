/**
 * Wiki service — frontmatter parsing, llms.txt generation,
 * knowledge graph builder, log parser.
 *
 * All functions are CF Workers compatible (no Node.js fs/path).
 */

// ── Frontmatter parser (regex-based, no npm deps) ──

export interface WikiFrontmatter {
  title: string;
  summary: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  related: string[];
  type: string;              // entity | concept | source-summary | comparison | analysis
  [key: string]: unknown;    // allow extra fields
}

export interface ParsedPage {
  frontmatter: Partial<WikiFrontmatter>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML frontmatter from markdown.
 * Supports: strings, arrays (inline `[a, b]` and multiline `- a`), booleans, dates.
 * Does NOT support nested objects — wiki pages don't need them.
 */
export function parseFrontmatter(raw: string): ParsedPage {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  const lines = yamlBlock.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Multiline array item: "  - value"
    if (currentKey && currentArray && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      currentArray.push(stripQuotes(val));
      continue;
    }

    // If we were collecting a multiline array, flush it
    if (currentKey && currentArray) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // Key: value line
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    // Empty value — might be start of multiline array
    if (!rawValue) {
      currentKey = key;
      currentArray = [];
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      if (inner.trim() === "") {
        frontmatter[key] = [];
      } else {
        frontmatter[key] = inner.split(",").map((s) => stripQuotes(s.trim()));
      }
      continue;
    }

    // Boolean
    if (rawValue === "true") { frontmatter[key] = true; continue; }
    if (rawValue === "false") { frontmatter[key] = false; continue; }

    // String (strip quotes)
    frontmatter[key] = stripQuotes(rawValue);
  }

  // Flush trailing multiline array
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter: frontmatter as Partial<WikiFrontmatter>, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ── Serialize page ──

export function serializePage(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}: [${value.map((v) => JSON.stringify(String(v))).join(", ")}]`);
      }
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: "${String(value)}"`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}

// ── Validate frontmatter ──

export interface ValidationError {
  field: string;
  message: string;
}

export function validateFrontmatter(fm: Partial<WikiFrontmatter>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!fm.title || typeof fm.title !== "string") {
    errors.push({ field: "title", message: "title is required and must be a string" });
  }
  if (!fm.summary || typeof fm.summary !== "string") {
    errors.push({ field: "summary", message: "summary is required and must be a string" });
  }
  if (fm.tags !== undefined && !Array.isArray(fm.tags)) {
    errors.push({ field: "tags", message: "tags must be an array" });
  }
  if (fm.sources !== undefined && !Array.isArray(fm.sources)) {
    errors.push({ field: "sources", message: "sources must be an array" });
  }
  if (fm.related !== undefined && !Array.isArray(fm.related)) {
    errors.push({ field: "related", message: "related must be an array" });
  }
  const validTypes = ["entity", "concept", "source-summary", "comparison", "analysis"];
  if (fm.type !== undefined && !validTypes.includes(fm.type)) {
    errors.push({ field: "type", message: `type must be one of: ${validTypes.join(", ")}` });
  }
  return errors;
}

// ── Wiki config ──

export interface WikiConfig {
  version: number;
  title: string;
  description?: string;
  llms_txt?: {
    include_sources?: boolean;
    max_pages?: number;
    sort?: "updated" | "created" | "title";
  };
}

// ── llms.txt generation ──

export interface PageSummary {
  path: string;
  frontmatter: Partial<WikiFrontmatter>;
  body: string;
  word_count: number;
}

export interface SourceInfo {
  path: string;
  size: number;
  word_count?: number;
}

export function generateLlmsTxt(
  pages: PageSummary[],
  sources: SourceInfo[],
  config: WikiConfig,
  format: "compact" | "full" = "compact",
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${config.title}`);
  if (config.description) {
    lines.push(`> ${config.description}`);
  }
  lines.push("");

  // Sort pages
  const sortField = config.llms_txt?.sort || "updated";
  const sorted = [...pages].sort((a, b) => {
    const aVal = String(a.frontmatter[sortField] || "");
    const bVal = String(b.frontmatter[sortField] || "");
    return bVal.localeCompare(aVal); // descending
  });

  // Limit
  const maxPages = config.llms_txt?.max_pages || 500;
  const limited = sorted.slice(0, maxPages);

  // Pages section
  lines.push("## Pages");
  for (const page of limited) {
    const title = page.frontmatter.title || page.path;
    const summary = page.frontmatter.summary || "";
    lines.push(`- [${title}](${page.path}): ${summary}`);
  }
  lines.push("");

  // Sources section
  if (sources.length > 0 && config.llms_txt?.include_sources !== false) {
    lines.push("## Sources");
    for (const src of sources) {
      const wordInfo = src.word_count ? ` (${src.word_count.toLocaleString()} words)` : ` (${src.size.toLocaleString()} bytes)`;
      lines.push(`- ${src.path}${wordInfo}`);
    }
    lines.push("");
  }

  // Full content (only in "full" format)
  if (format === "full") {
    lines.push("## Full Content");
    lines.push("");
    for (const page of limited) {
      const title = page.frontmatter.title || page.path;
      lines.push(`### ${title}`);
      if (page.frontmatter.type) {
        const parts: string[] = [`Type: ${page.frontmatter.type}`];
        if (page.frontmatter.tags?.length) parts.push(`Tags: ${page.frontmatter.tags.join(", ")}`);
        if (page.frontmatter.sources?.length) parts.push(`Sources: ${page.frontmatter.sources.join(", ")}`);
        if (page.frontmatter.updated) parts.push(`Updated: ${page.frontmatter.updated}`);
        lines.push(parts.join(" | "));
      }
      lines.push("");
      lines.push(page.body.trim());
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Knowledge graph builder ──

export interface GraphNode {
  path: string;
  title: string;
  tags: string[];
  type: string;       // "wiki-page" | "source" | specific page type
  word_count: number;
}

export interface GraphEdge {
  source: string;     // path
  target: string;     // path
  type: "related" | "source-ref" | "shared-tag";
  tag?: string;       // only for shared-tag
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  tag_clusters: Record<string, string[]>;
  stats: {
    pages: number;
    sources: number;
    links: number;
    orphans: number;
  };
}

const SHARED_TAG_MAX_PAGES = 20; // cap shared-tag edges to avoid O(n^2) explosion

export function buildKnowledgeGraph(pages: PageSummary[], sources: SourceInfo[]): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const tagMap = new Map<string, string[]>();          // tag → paths

  // Wiki page nodes
  for (const page of pages) {
    nodes.push({
      path: page.path,
      title: page.frontmatter.title || page.path,
      tags: page.frontmatter.tags || [],
      type: page.frontmatter.type || "wiki-page",
      word_count: page.word_count,
    });

    // Track tags
    for (const tag of (page.frontmatter.tags || [])) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(page.path);
    }

    // Explicit "related" edges
    for (const rel of (page.frontmatter.related || [])) {
      edges.push({ source: page.path, target: rel, type: "related" });
    }

    // "sources" reference edges
    for (const src of (page.frontmatter.sources || [])) {
      edges.push({ source: page.path, target: src, type: "source-ref" });
    }
  }

  // Source nodes
  for (const src of sources) {
    nodes.push({
      path: src.path,
      title: src.path.split("/").pop() || src.path,
      tags: [],
      type: "source",
      word_count: src.word_count || 0,
    });
  }

  // Shared-tag edges — only for tags with <= SHARED_TAG_MAX_PAGES pages to avoid explosion
  for (const [tag, paths] of tagMap) {
    if (paths.length > SHARED_TAG_MAX_PAGES) continue;
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        edges.push({ source: paths[i], target: paths[j], type: "shared-tag", tag });
      }
    }
  }

  // Compute orphans (wiki pages with no inbound related/source-ref edges)
  const allWikiPaths = new Set(pages.map((p) => p.path));
  const pagesWithInbound = new Set<string>();
  for (const edge of edges) {
    if (edge.type !== "shared-tag" && allWikiPaths.has(edge.target)) {
      pagesWithInbound.add(edge.target);
    }
  }
  const orphanCount = pages.filter((p) => !pagesWithInbound.has(p.path)).length;

  return {
    nodes,
    edges,
    tag_clusters: Object.fromEntries(tagMap),
    stats: {
      pages: pages.length,
      sources: sources.length,
      links: edges.filter((e) => e.type !== "shared-tag").length,
      orphans: orphanCount,
    },
  };
}

// ── Log parser ──

export interface LogEntry {
  date: string;
  operation: string;
  title: string;
  body: string;
}

const LOG_ENTRY_RE = /^##\s+\[([^\]]+)\]\s+(\w+)\s*\|\s*(.*)$/;

export function parseLogEntries(logContent: string, limit = 20, offset = 0): { entries: LogEntry[]; total: number } {
  const lines = logContent.split("\n");
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      entries.push(current);
      bodyLines = [];
    }
  };

  for (const line of lines) {
    const match = line.match(LOG_ENTRY_RE);
    if (match) {
      flush();
      current = {
        date: match[1],
        operation: match[2],
        title: match[3].trim(),
        body: "",
      };
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  // Reverse so newest first
  entries.reverse();

  return {
    entries: entries.slice(offset, offset + limit),
    total: entries.length,
  };
}

// ── Path validation ──

export function validateNotePath(path: string): string | null {
  // Must be under wiki/ or inbox/
  if (!path.startsWith("wiki/") && !path.startsWith("inbox/")) {
    return "Path must be under wiki/ or inbox/";
  }
  // Must end with .md
  if (!path.endsWith(".md")) {
    return "Path must end with .md";
  }
  // No traversal
  if (path.includes("..") || path.includes("//")) {
    return "Path must not contain .. or //";
  }
  // No leading/trailing slashes in segments
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "") continue;
    if (seg.startsWith(".") && seg !== ".gitkeep") {
      return "Path segments must not start with .";
    }
  }
  return null;
}

// ── Word count helper ──

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
