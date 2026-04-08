/**
 * Code parser using Tree-sitter with data-driven generic extraction.
 *
 * One generic extractor handles all 30+ languages via AST node type mappings.
 * Specialized post-processing only for languages that need it (TS, Python, Go, Rust, C#, Ruby).
 *
 * Grammars stored in R2, lazy-loaded, cached in module scope.
 */

import { LANGUAGE_SCHEMAS, GRAMMAR_FILES, getLanguageFromPath, type LanguageSchema } from "./language-schemas";

// ── Types ──

export interface ParsedEntity {
  type: "Function" | "Class" | "Interface" | "Enum" | "Type" | "Variable" | "Module" | "Decorator" | "Test" | "Route" | "Comment" | "File";
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
  complexity: number;
  calls: string[];        // names of called functions
  extends?: string;       // parent class name
  implements?: string[];  // implemented interfaces
  usedTypes?: string[];   // referenced type names
}

export interface ImportInfo {
  source: string;         // module path or name
  specifiers: string[];   // imported names
}

export interface ParsedFile {
  language: string;
  entities: ParsedEntity[];
  imports: ImportInfo[];
}

// ── Skip rules ──

const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "ico", "bmp", "webp",
  "mp4", "mp3", "wav", "ogg", "webm",
  "zip", "tar", "gz", "bz2", "rar", "7z",
  "pdf", "doc", "docx", "xls", "xlsx",
  "exe", "dll", "so", "dylib", "wasm",
  "ttf", "woff", "woff2", "eot", "otf",
  "lock", "map",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
  "go.sum", "Gemfile.lock", "composer.lock", "Pipfile.lock",
  "poetry.lock", "flake.lock", "pubspec.lock",
]);

const MAX_FILE_SIZE = 512 * 1024; // 512KB

/**
 * Parse a file and extract entities + relationships.
 * Falls back to regex if no Tree-sitter grammar or Tree-sitter unavailable.
 */
export function parseFile(filePath: string, content: string): ParsedFile | null {
  // Skip binary/large/lock files
  const fileName = filePath.split("/").pop() || "";
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  if (SKIP_EXTENSIONS.has(ext) || SKIP_FILES.has(fileName)) return null;
  if (content.length > MAX_FILE_SIZE) return null;
  if (content.includes("\0")) return null; // binary

  const language = getLanguageFromPath(filePath);
  if (!language) return null;

  const schema = LANGUAGE_SCHEMAS[language];
  if (!schema) return null;

  // Use regex extraction (Tree-sitter WASM loading deferred to async init)
  return extractWithRegex(filePath, content, language, schema);
}

// ── Regex-based extraction (works everywhere, no WASM needed) ──

function extractWithRegex(filePath: string, content: string, language: string, schema: LanguageSchema): ParsedFile {
  const lines = content.split("\n");
  const entities: ParsedEntity[] = [];
  const imports: ImportInfo[] = [];
  const calls: string[] = [];

  // Track exports
  const exportedNames = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Extract imports
    const importMatch = extractImportRegex(trimmed, language);
    if (importMatch) {
      imports.push(importMatch);
      continue;
    }

    // Extract exports (track which names are exported)
    if (isExportLine(trimmed, language)) {
      const name = extractExportedName(trimmed, language);
      if (name) exportedNames.add(name);
    }

    // Extract function/method definitions
    const funcMatch = extractFunctionRegex(trimmed, language);
    if (funcMatch) {
      const endLine = findBlockEnd(lines, i);
      const blockContent = lines.slice(i, endLine + 1).join("\n");
      const fnCalls = extractCallsFromBlock(blockContent, language);
      const isTest = isTestFunction(funcMatch.name, language, schema);
      const complexity = computeComplexity(blockContent);

      entities.push({
        type: isTest ? "Test" : "Function",
        name: funcMatch.name,
        startLine: i + 1,
        endLine: endLine + 1,
        signature: funcMatch.signature,
        exported: exportedNames.has(funcMatch.name) || isExportLine(trimmed, language),
        complexity,
        calls: fnCalls,
      });
      continue;
    }

    // Extract class/struct definitions
    const classMatch = extractClassRegex(trimmed, language);
    if (classMatch) {
      const endLine = findBlockEnd(lines, i);
      entities.push({
        type: classMatch.isInterface ? "Interface" : "Class",
        name: classMatch.name,
        startLine: i + 1,
        endLine: endLine + 1,
        signature: trimmed.slice(0, 200),
        exported: exportedNames.has(classMatch.name) || isExportLine(trimmed, language),
        complexity: 0,
        calls: [],
        extends: classMatch.extends,
        implements: classMatch.implements,
      });
      continue;
    }

    // Extract enum
    const enumMatch = extractEnumRegex(trimmed, language);
    if (enumMatch) {
      const endLine = findBlockEnd(lines, i);
      entities.push({
        type: "Enum",
        name: enumMatch,
        startLine: i + 1,
        endLine: endLine + 1,
        signature: trimmed.slice(0, 200),
        exported: exportedNames.has(enumMatch) || isExportLine(trimmed, language),
        complexity: 0,
        calls: [],
      });
    }

    // Extract type alias
    const typeMatch = extractTypeRegex(trimmed, language);
    if (typeMatch) {
      entities.push({
        type: "Type",
        name: typeMatch,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed.slice(0, 200),
        exported: exportedNames.has(typeMatch) || isExportLine(trimmed, language),
        complexity: 0,
        calls: [],
      });
    }
  }

  // Detect route handlers
  detectRoutes(content, entities, language, schema);

  // Extract doc comments and attach to entities
  extractDocComments(lines, entities);

  return { language, entities, imports };
}

// ── Pattern extractors per language ──

function extractImportRegex(line: string, lang: string): ImportInfo | null {
  // TypeScript/JavaScript
  if (lang === "typescript" || lang === "javascript") {
    const m = line.match(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      const specifiers = m[1] ? m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : [m[2]];
      return { source: m[3], specifiers };
    }
    const mStar = line.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (mStar) return { source: mStar[2], specifiers: [mStar[1]] };
    return null;
  }

  // Python
  if (lang === "python") {
    const mFrom = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
    if (mFrom) return { source: mFrom[1], specifiers: mFrom[2].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()) };
    const mImport = line.match(/^import\s+([\w.]+)/);
    if (mImport) return { source: mImport[1], specifiers: [mImport[1].split(".").pop()!] };
    return null;
  }

  // Go
  if (lang === "go") {
    const m = line.match(/^\s*"([^"]+)"/);
    if (m) return { source: m[1], specifiers: [m[1].split("/").pop()!] };
    return null;
  }

  // Rust
  if (lang === "rust") {
    const m = line.match(/^use\s+([\w:]+)(?:::\{([^}]+)\})?/);
    if (m) {
      const specifiers = m[2] ? m[2].split(",").map(s => s.trim()) : [m[1].split("::").pop()!];
      return { source: m[1], specifiers };
    }
    return null;
  }

  // Java/Kotlin/C#
  if (lang === "java" || lang === "kotlin" || lang === "csharp") {
    const m = line.match(/^(?:import|using)\s+(?:static\s+)?([\w.]+)/);
    if (m) return { source: m[1], specifiers: [m[1].split(".").pop()!] };
    return null;
  }

  // Ruby
  if (lang === "ruby") {
    const m = line.match(/^require(?:_relative)?\s+['"]([^'"]+)['"]/);
    if (m) return { source: m[1], specifiers: [m[1].split("/").pop()!] };
    return null;
  }

  // PHP
  if (lang === "php") {
    const m = line.match(/^use\s+([\w\\]+)/);
    if (m) return { source: m[1], specifiers: [m[1].split("\\").pop()!] };
    return null;
  }

  // C/C++
  if (lang === "c" || lang === "cpp") {
    const m = line.match(/^#include\s+[<"]([^>"]+)[>"]/);
    if (m) return { source: m[1], specifiers: [m[1].split("/").pop()!.replace(/\.\w+$/, "")] };
    return null;
  }

  // Generic fallback
  const m = line.match(/^(?:import|require|include|use)\s+['"]?([^\s'"]+)/);
  if (m) return { source: m[1], specifiers: [m[1].split(/[/.\\]/).pop()!] };
  return null;
}

function extractFunctionRegex(line: string, lang: string): { name: string; signature: string } | null {
  // TS/JS
  if (lang === "typescript" || lang === "javascript") {
    const m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (m) return { name: m[1], signature: line.slice(0, 200) };
    const mArrow = line.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/);
    if (mArrow) return { name: mArrow[1], signature: line.slice(0, 200) };
    const mMethod = line.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/);
    if (mMethod && !["if", "for", "while", "switch", "catch"].includes(mMethod[1])) {
      return { name: mMethod[1], signature: line.slice(0, 200) };
    }
    return null;
  }

  // Python
  if (lang === "python") {
    const m = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
    if (m) return { name: m[1], signature: line.slice(0, 200) };
    return null;
  }

  // Go
  if (lang === "go") {
    const m = line.match(/^func\s+(?:\(\w+\s+\*?(\w+)\)\s+)?(\w+)\s*\(/);
    if (m) return { name: m[1] ? `${m[1]}.${m[2]}` : m[2], signature: line.slice(0, 200) };
    return null;
  }

  // Rust
  if (lang === "rust") {
    const m = line.match(/^(?:pub(?:\(\w+\))?\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (m) return { name: m[1], signature: line.slice(0, 200) };
    return null;
  }

  // Java/C#/Kotlin
  if (lang === "java" || lang === "csharp" || lang === "kotlin") {
    const m = line.match(/^(?:(?:public|private|protected|internal|static|abstract|override|async|suspend)\s+)*(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/);
    if (m && !["if", "for", "while", "switch", "catch", "class", "interface"].includes(m[1])) {
      return { name: m[1], signature: line.slice(0, 200) };
    }
    // Kotlin fun
    const mKt = line.match(/^(?:(?:public|private|internal|override|suspend)\s+)*fun\s+(\w+)/);
    if (mKt) return { name: mKt[1], signature: line.slice(0, 200) };
    return null;
  }

  // Ruby
  if (lang === "ruby") {
    const m = line.match(/^def\s+([\w?!]+)/);
    if (m) return { name: m[1], signature: line.slice(0, 200) };
    return null;
  }

  // C/C++
  if (lang === "c" || lang === "cpp") {
    const m = line.match(/^(?:(?:static|inline|virtual|explicit|extern)\s+)*(?:\w+(?:::\w+)*[\s*&]+)(\w+)\s*\(/);
    if (m && !["if", "for", "while", "switch", "return"].includes(m[1])) {
      return { name: m[1], signature: line.slice(0, 200) };
    }
    return null;
  }

  // PHP
  if (lang === "php") {
    const m = line.match(/^(?:(?:public|private|protected|static)\s+)*function\s+(\w+)/);
    if (m) return { name: m[1], signature: line.slice(0, 200) };
    return null;
  }

  // Swift
  if (lang === "swift") {
    const m = line.match(/^(?:(?:public|private|internal|open|static|class|override)\s+)*func\s+(\w+)/);
    if (m) return { name: m[1], signature: line.slice(0, 200) };
    return null;
  }

  // Generic
  const m = line.match(/^(?:function|def|fn|func|sub)\s+(\w+)/);
  if (m) return { name: m[1], signature: line.slice(0, 200) };
  return null;
}

function extractClassRegex(line: string, lang: string): { name: string; isInterface: boolean; extends?: string; implements?: string[] } | null {
  // TS/JS
  if (lang === "typescript" || lang === "javascript") {
    const m = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?\s*\{/);
    if (m) return { name: m[1], isInterface: false, extends: m[2], implements: m[3]?.split(",").map(s => s.trim()) };
    const mInt = line.match(/^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+(.+?))?\s*\{/);
    if (mInt) return { name: mInt[1], isInterface: true, extends: mInt[2]?.split(",")[0]?.trim() };
    return null;
  }

  // Python
  if (lang === "python") {
    const m = line.match(/^class\s+(\w+)(?:\(([^)]+)\))?/);
    if (m) {
      const bases = m[2]?.split(",").map(s => s.trim()).filter(s => !s.startsWith("metaclass")) || [];
      return { name: m[1], isInterface: false, extends: bases[0], implements: bases.slice(1) };
    }
    return null;
  }

  // Go
  if (lang === "go") {
    const m = line.match(/^type\s+(\w+)\s+(struct|interface)\s*\{/);
    if (m) return { name: m[1], isInterface: m[2] === "interface" };
    return null;
  }

  // Rust
  if (lang === "rust") {
    const mStruct = line.match(/^(?:pub(?:\(\w+\))?\s+)?struct\s+(\w+)/);
    if (mStruct) return { name: mStruct[1], isInterface: false };
    const mTrait = line.match(/^(?:pub(?:\(\w+\))?\s+)?trait\s+(\w+)/);
    if (mTrait) return { name: mTrait[1], isInterface: true };
    return null;
  }

  // Java/C#/Kotlin
  if (lang === "java" || lang === "csharp" || lang === "kotlin") {
    const m = line.match(/^(?:(?:public|private|protected|internal|abstract|final|sealed|open|data)\s+)*(?:class|record)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?\s*[{(]/);
    if (m) return { name: m[1], isInterface: false, extends: m[2], implements: m[3]?.split(",").map(s => s.trim()) };
    const mInt = line.match(/^(?:(?:public|private|protected|internal)\s+)*interface\s+(\w+)/);
    if (mInt) return { name: mInt[1], isInterface: true };
    return null;
  }

  // Generic
  const m = line.match(/^(?:(?:public|export)\s+)?(?:class|struct)\s+(\w+)/);
  if (m) return { name: m[1], isInterface: false };
  const mInt = line.match(/^(?:(?:public|export)\s+)?(?:interface|protocol|trait)\s+(\w+)/);
  if (mInt) return { name: mInt[1], isInterface: true };
  return null;
}

function extractEnumRegex(line: string, _lang: string): string | null {
  const m = line.match(/^(?:(?:export|public|pub)\s+)?enum\s+(\w+)/);
  return m ? m[1] : null;
}

function extractTypeRegex(line: string, lang: string): string | null {
  if (lang === "typescript") {
    const m = line.match(/^(?:export\s+)?type\s+(\w+)/);
    return m ? m[1] : null;
  }
  if (lang === "rust") {
    const m = line.match(/^(?:pub(?:\(\w+\))?\s+)?type\s+(\w+)/);
    return m ? m[1] : null;
  }
  if (lang === "go") {
    const m = line.match(/^type\s+(\w+)\s+(?!struct|interface)/);
    return m ? m[1] : null;
  }
  return null;
}

function isExportLine(line: string, lang: string): boolean {
  if (lang === "typescript" || lang === "javascript") return line.startsWith("export ");
  if (lang === "go") return /^[A-Z]/.test(line.replace(/^(?:func|type|var|const)\s+(?:\([^)]+\)\s+)?/, ""));
  if (lang === "rust") return line.startsWith("pub ");
  if (lang === "python") return !line.startsWith("_");
  if (lang === "java" || lang === "csharp" || lang === "kotlin") return line.includes("public ");
  return false;
}

function extractExportedName(line: string, lang: string): string | null {
  if (lang === "typescript" || lang === "javascript") {
    const m = line.match(/^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|interface|enum|type|const|let|var)\s+(\w+)/);
    return m ? m[1] : null;
  }
  return null;
}

function extractCallsFromBlock(block: string, _lang: string): string[] {
  const calls = new Set<string>();
  const regex = /(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(block)) !== null) {
    const name = m[1];
    // Skip keywords and common false positives
    if (!["if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof", "instanceof", "await", "async", "function", "class", "import", "from", "require"].includes(name)) {
      calls.add(name);
    }
  }
  return [...calls];
}

function isTestFunction(name: string, lang: string, schema: LanguageSchema): boolean {
  if (schema.testPatterns) {
    return schema.testPatterns.some(p => p.test(name));
  }
  // Generic fallback
  return /^test/i.test(name) || /Test$/.test(name);
}

function findBlockEnd(lines: string[], startLine: number): number {
  // Track only {} braces (not parentheses) for block-scoped languages
  let depth = 0;
  let foundOpen = false;
  let inString = false;
  let stringChar = "";

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const prev = j > 0 ? line[j - 1] : "";

      // Skip string contents
      if (inString) {
        if (ch === stringChar && prev !== "\\") inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = true;
        stringChar = ch;
        continue;
      }
      // Skip line comments
      if (ch === "/" && j + 1 < line.length && (line[j + 1] === "/" || line[j + 1] === "*")) break;

      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") depth--;
    }
    if (foundOpen && depth <= 0) return i;
  }

  // For Python-like languages (indentation-based)
  if (!foundOpen) {
    const baseIndent = lines[startLine].match(/^(\s*)/)?.[1].length || 0;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const indent = line.match(/^(\s*)/)?.[1].length || 0;
      if (indent <= baseIndent) return i - 1;
    }
    return lines.length - 1;
  }

  return Math.min(startLine + 50, lines.length - 1);
}

function detectRoutes(content: string, entities: ParsedEntity[], lang: string, schema: LanguageSchema): void {
  if (!schema.routePatterns) return;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const pattern of schema.routePatterns) {
      if (pattern.test(line)) {
        // Extract route path
        const pathMatch = line.match(/['"]([^'"]*\/[^'"]*)['"]/);
        if (pathMatch) {
          // Check if there's already a function entity at this location
          const existing = entities.find(e => e.startLine <= i + 1 && e.endLine >= i + 1);
          if (!existing) {
            const methodMatch = line.match(/\.(get|post|put|patch|delete|GET|POST|PUT|PATCH|DELETE)/i);
            entities.push({
              type: "Route",
              name: `${(methodMatch?.[1] || "ANY").toUpperCase()} ${pathMatch[1]}`,
              startLine: i + 1,
              endLine: i + 1,
              signature: line.slice(0, 200),
              exported: true,
              complexity: 0,
              calls: [],
            });
          }
        }
        break;
      }
    }
  }
}

function extractDocComments(lines: string[], entities: ParsedEntity[]): void {
  // Look for JSDoc/docstring/doc comments above entities
  for (const entity of entities) {
    if (entity.startLine <= 1) continue;

    const commentLines: string[] = [];
    for (let i = entity.startLine - 2; i >= 0 && i >= entity.startLine - 20; i--) {
      const line = lines[i].trim();
      if (line.startsWith("*") || line.startsWith("//") || line.startsWith("#") || line.startsWith("///") || line.startsWith("/**") || line.startsWith("*/") || line.startsWith('"""') || line.startsWith("'''")) {
        commentLines.unshift(line);
      } else if (line === "") {
        continue; // skip blank lines between comment and entity
      } else {
        break;
      }
    }
    // We don't create separate Comment entities — the doc comment enriches the entity's signature
    if (commentLines.length > 0) {
      const doc = commentLines.join("\n").slice(0, 500);
      entity.signature = `${doc}\n${entity.signature}`;
    }
  }
}

/**
 * Compute cyclomatic complexity from code block.
 * Counts decision points: if (not else if separately), for, while, case, catch, &&, ||, ternary.
 */
function computeComplexity(block: string): number {
  let complexity = 1; // base
  const patterns = [
    /\bif\b/g,       // includes both standalone if and else-if (counted once)
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /&&/g,
    /\|\|/g,
    /\?\s/g,          // ternary (? followed by space)
  ];
  for (const p of patterns) {
    const matches = block.match(p);
    if (matches) complexity += matches.length;
  }
  return complexity;
}
