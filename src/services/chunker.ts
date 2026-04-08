/**
 * Code chunking for semantic search indexing.
 * Splits files into chunks suitable for embedding with voyage-code-3.
 *
 * P1.1: CAST-style contextual prefix — language + top-level declarations.
 */

export interface CodeChunk {
  text: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  chunk_index: number;
}

const MAX_FILE_SIZE = 512 * 1024; // 512KB
const MAX_CHUNK_CHARS = 16_000;   // ~4K tokens
const TARGET_CHUNK_CHARS = 8_000; // ~2K tokens
const OVERLAP_CHARS = 800;        // ~200 tokens

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", scala: "scala",
  c: "c", cpp: "cpp", cc: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", swift: "swift", m: "objectivec",
  php: "php", r: "r", lua: "lua", dart: "dart",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  sql: "sql", graphql: "graphql", gql: "graphql",
  html: "html", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", md: "markdown", mdx: "markdown",
  vue: "vue", svelte: "svelte", astro: "astro",
  tf: "terraform", hcl: "terraform",
  proto: "protobuf", sol: "solidity",
  ex: "elixir", exs: "elixir", erl: "erlang",
  zig: "zig", nim: "nim", v: "vlang",
  dockerfile: "dockerfile",
};

const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tiff",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "wav", "ogg", "webm", "avi",
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "bin", "o", "a",
  "map", "wasm",
]);

const SKIP_FILENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "composer.lock", "Gemfile.lock", "Cargo.lock",
  "poetry.lock", "Pipfile.lock",
]);

// Regex to extract top-level declarations across languages
const DECLARATION_RE = /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|def|func|fn|pub\s+fn|pub\s+struct|struct|impl|trait|module|object)\s+(\w+)/;

function getExtension(filePath: string): string {
  const basename = filePath.split("/").pop() || "";
  // Handle dotfiles like Dockerfile
  if (basename.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = basename.lastIndexOf(".");
  return dot === -1 ? "" : basename.slice(dot + 1).toLowerCase();
}

function getLanguage(filePath: string): string {
  const ext = getExtension(filePath);
  return LANGUAGE_MAP[ext] || ext || "unknown";
}

function shouldSkipFile(filePath: string, contentLength: number): boolean {
  if (contentLength > MAX_FILE_SIZE) return true;

  const basename = filePath.split("/").pop() || "";
  if (SKIP_FILENAMES.has(basename)) return true;

  const ext = getExtension(filePath);
  if (SKIP_EXTENSIONS.has(ext)) return true;

  // Skip minified files
  if (basename.includes(".min.")) return true;

  return false;
}

function isBinaryContent(content: string): boolean {
  // Check for null bytes in the first 8KB
  const sample = content.slice(0, 8192);
  return sample.includes("\0");
}

/**
 * Build a contextual prefix for a chunk (P1.1 — CAST-style).
 * Includes file path, language, and top-level declarations from the file head.
 * Cap at ~200 chars to avoid wasting embedding tokens.
 */
function buildPrefix(filePath: string, content: string, language: string): string {
  const parts = [`// File: ${filePath}`, `// Language: ${language}`];

  // Scan first 50 lines for top-level declarations
  const headLines = content.split("\n").slice(0, 50);
  const declarations: string[] = [];
  for (const line of headLines) {
    const m = line.match(DECLARATION_RE);
    if (m && m[1]) {
      declarations.push(m[1]);
      if (declarations.length >= 5) break;
    }
  }

  if (declarations.length > 0) {
    parts.push(`// Defines: ${declarations.join(", ")}`);
  }

  const prefix = parts.join("\n") + "\n";
  // Hard cap to avoid bloating chunk text
  return prefix.length > 300 ? prefix.slice(0, 300) + "\n" : prefix;
}

/**
 * Chunk a file into pieces suitable for embedding.
 * Returns empty array for files that should be skipped.
 */
export function chunkFile(filePath: string, content: string): CodeChunk[] {
  if (shouldSkipFile(filePath, content.length)) return [];
  if (isBinaryContent(content)) return [];
  if (content.trim().length === 0) return [];

  const language = getLanguage(filePath);
  const prefix = buildPrefix(filePath, content, language);

  // Small file: single chunk
  if (content.length <= MAX_CHUNK_CHARS) {
    return [
      {
        text: prefix + content,
        file_path: filePath,
        start_line: 1,
        end_line: content.split("\n").length,
        language,
        chunk_index: 0,
      },
    ];
  }

  // Large file: split at blank-line boundaries with overlap
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  let chunkStart = 0;

  while (chunkStart < lines.length) {
    // Find end of this chunk
    let chunkEnd = chunkStart;
    let charCount = 0;

    while (chunkEnd < lines.length && charCount < TARGET_CHUNK_CHARS) {
      charCount += lines[chunkEnd].length + 1; // +1 for newline
      chunkEnd++;
    }

    // Try to extend to a blank-line boundary (within 50% more)
    const maxEnd = Math.min(lines.length, chunkStart + Math.ceil((TARGET_CHUNK_CHARS * 1.5) / 4));
    while (chunkEnd < maxEnd) {
      if (lines[chunkEnd].trim() === "") break;
      chunkEnd++;
    }

    const chunkLines = lines.slice(chunkStart, chunkEnd);
    const chunkText = prefix + chunkLines.join("\n");

    chunks.push({
      text: chunkText,
      file_path: filePath,
      start_line: chunkStart + 1,
      end_line: chunkEnd,
      language,
      chunk_index: chunks.length,
    });

    // Move start back by overlap amount
    const overlapLines = Math.max(1, Math.floor(OVERLAP_CHARS / 80)); // ~80 chars/line
    chunkStart = Math.max(chunkStart + 1, chunkEnd - overlapLines);
  }

  return chunks;
}
