/**
 * Data-driven AST node type mappings for 30+ languages.
 * Each language entry maps semantic entity types to Tree-sitter AST node types.
 * Adding a new language = adding a new entry to this object.
 */

export interface LanguageSchema {
  // Entity node types
  function: string[];
  class?: string[];
  interface?: string[];
  enum?: string[];
  type?: string[];
  variable?: string[];
  decorator?: string[];

  // Relationship node types
  import: string[];
  export?: string[];
  call: string[];
  extends?: string[];
  implements?: string[];

  // Field names for extracting entity metadata
  nameField: string;
  paramsField?: string;
  returnField?: string;
  bodyField?: string;

  // Test function patterns (regex on name)
  testPatterns?: RegExp[];

  // Route/endpoint patterns (regex on name or decorator)
  routePatterns?: RegExp[];
}

// File extension → language key
export const EXTENSION_MAP: Record<string, string> = {
  // Tier 1
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  rb: "ruby", rake: "ruby",
  php: "php",
  // Tier 2
  scala: "scala", sc: "scala",
  dart: "dart",
  ex: "elixir", exs: "elixir",
  hs: "haskell", lhs: "haskell",
  lua: "lua",
  zig: "zig",
  ml: "ocaml", mli: "ocaml",
  jl: "julia",
  r: "r", R: "r",
  pl: "perl", pm: "perl",
  sh: "bash", bash: "bash", zsh: "bash",
  // Tier 3
  toml: "toml",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  tf: "hcl", hcl: "hcl",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html",
};

// Language key → Tree-sitter grammar WASM filename (stored in R2)
export const GRAMMAR_FILES: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  swift: "tree-sitter-swift.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  scala: "tree-sitter-scala.wasm",
  dart: "tree-sitter-dart.wasm",
  elixir: "tree-sitter-elixir.wasm",
  haskell: "tree-sitter-haskell.wasm",
  lua: "tree-sitter-lua.wasm",
  zig: "tree-sitter-zig.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  julia: "tree-sitter-julia.wasm",
  r: "tree-sitter-r.wasm",
  perl: "tree-sitter-perl.wasm",
  bash: "tree-sitter-bash.wasm",
  toml: "tree-sitter-toml.wasm",
  yaml: "tree-sitter-yaml.wasm",
  sql: "tree-sitter-sql.wasm",
  hcl: "tree-sitter-hcl.wasm",
  css: "tree-sitter-css.wasm",
  html: "tree-sitter-html.wasm",
};

export const LANGUAGE_SCHEMAS: Record<string, LanguageSchema> = {
  // ── Tier 1: Full extraction ──

  typescript: {
    function: ["function_declaration", "arrow_function", "method_definition", "generator_function_declaration"],
    class: ["class_declaration"],
    interface: ["interface_declaration"],
    enum: ["enum_declaration"],
    type: ["type_alias_declaration"],
    variable: ["lexical_declaration"],
    decorator: ["decorator"],
    import: ["import_statement"],
    export: ["export_statement"],
    call: ["call_expression"],
    extends: ["extends_clause"],
    implements: ["implements_clause"],
    nameField: "name",
    paramsField: "parameters",
    returnField: "return_type",
    bodyField: "body",
    testPatterns: [/^(test|it|describe|beforeEach|afterEach|beforeAll|afterAll)$/, /\.test\./, /\.spec\./],
    routePatterns: [/\.(get|post|put|patch|delete|use|all|route)\s*\(/, /app\.(get|post|put|patch|delete)/],
  },

  javascript: {
    function: ["function_declaration", "arrow_function", "method_definition", "generator_function_declaration"],
    class: ["class_declaration"],
    variable: ["lexical_declaration", "variable_declaration"],
    import: ["import_statement"],
    export: ["export_statement"],
    call: ["call_expression"],
    extends: ["extends_clause"],
    nameField: "name",
    paramsField: "parameters",
    bodyField: "body",
    testPatterns: [/^(test|it|describe|beforeEach|afterEach)$/],
    routePatterns: [/\.(get|post|put|patch|delete|use)\s*\(/],
  },

  python: {
    function: ["function_definition"],
    class: ["class_definition"],
    decorator: ["decorator"],
    variable: ["assignment", "augmented_assignment"],
    import: ["import_statement", "import_from_statement"],
    call: ["call"],
    extends: ["argument_list"], // bases in class definition
    nameField: "name",
    paramsField: "parameters",
    returnField: "return_type",
    bodyField: "body",
    testPatterns: [/^test_/, /^Test/],
    routePatterns: [/@app\.(get|post|put|patch|delete|route)/, /@router\.(get|post|put|patch|delete)/],
  },

  go: {
    function: ["function_declaration", "method_declaration"],
    class: ["type_declaration"], // structs
    interface: ["type_declaration"], // interface types
    variable: ["var_declaration", "const_declaration", "short_var_declaration"],
    import: ["import_declaration"],
    call: ["call_expression"],
    nameField: "name",
    paramsField: "parameters",
    returnField: "result",
    bodyField: "body",
    testPatterns: [/^Test/, /^Benchmark/, /^Example/],
    routePatterns: [/\.(GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(/],
  },

  rust: {
    function: ["function_item"],
    class: ["struct_item", "impl_item"],
    interface: ["trait_item"],
    enum: ["enum_item"],
    type: ["type_item"],
    variable: ["const_item", "static_item", "let_declaration"],
    decorator: ["attribute_item"],
    import: ["use_declaration"],
    call: ["call_expression"],
    extends: ["trait_bounds"],
    nameField: "name",
    paramsField: "parameters",
    returnField: "return_type",
    bodyField: "body",
    testPatterns: [/^test_/, /#\[test\]/, /#\[cfg\(test\)\]/],
    routePatterns: [/\.(get|post|put|patch|delete|route)\s*\(/],
  },

  java: {
    function: ["method_declaration", "constructor_declaration"],
    class: ["class_declaration"],
    interface: ["interface_declaration"],
    enum: ["enum_declaration"],
    variable: ["field_declaration"],
    decorator: ["annotation"],
    import: ["import_declaration"],
    call: ["method_invocation"],
    extends: ["superclass"],
    implements: ["super_interfaces"],
    nameField: "name",
    paramsField: "formal_parameters",
    returnField: "type",
    bodyField: "body",
    testPatterns: [/@Test/, /@ParameterizedTest/, /^test/],
    routePatterns: [/@(Get|Post|Put|Patch|Delete|Request)Mapping/, /@Path/],
  },

  csharp: {
    function: ["method_declaration", "constructor_declaration"],
    class: ["class_declaration", "record_declaration"],
    interface: ["interface_declaration"],
    enum: ["enum_declaration"],
    variable: ["field_declaration", "property_declaration"],
    decorator: ["attribute_list"],
    import: ["using_directive"],
    call: ["invocation_expression"],
    extends: ["base_list"],
    nameField: "name",
    paramsField: "parameter_list",
    returnField: "type",
    bodyField: "body",
    testPatterns: [/\[Test\]/, /\[Fact\]/, /\[Theory\]/, /^Test/],
    routePatterns: [/\[Http(Get|Post|Put|Patch|Delete)\]/, /\[Route\]/],
  },

  c: {
    function: ["function_definition"],
    class: ["struct_specifier"],
    enum: ["enum_specifier"],
    type: ["type_definition"],
    variable: ["declaration"],
    import: ["preproc_include"],
    call: ["call_expression"],
    nameField: "declarator",
    paramsField: "parameters",
    bodyField: "body",
  },

  cpp: {
    function: ["function_definition"],
    class: ["class_specifier", "struct_specifier"],
    enum: ["enum_specifier"],
    type: ["type_definition", "alias_declaration"],
    variable: ["declaration"],
    import: ["preproc_include", "using_declaration"],
    call: ["call_expression"],
    extends: ["base_class_clause"],
    nameField: "declarator",
    paramsField: "parameters",
    bodyField: "body",
  },

  kotlin: {
    function: ["function_declaration"],
    class: ["class_declaration", "object_declaration"],
    interface: ["class_declaration"], // interface keyword
    enum: ["class_declaration"], // enum class
    variable: ["property_declaration"],
    decorator: ["annotation"],
    import: ["import_header"],
    call: ["call_expression"],
    extends: ["delegation_specifier"],
    nameField: "simple_identifier",
    paramsField: "function_value_parameters",
    returnField: "type",
    bodyField: "function_body",
    testPatterns: [/@Test/, /^test/],
    routePatterns: [/@(Get|Post|Put|Patch|Delete)Mapping/],
  },

  swift: {
    function: ["function_declaration"],
    class: ["class_declaration"],
    interface: ["protocol_declaration"],
    enum: ["enum_declaration"],
    type: ["typealias_declaration"],
    variable: ["property_declaration"],
    decorator: ["attribute"],
    import: ["import_declaration"],
    call: ["call_expression"],
    extends: ["inheritance_clause"],
    nameField: "name",
    paramsField: "parameter_clause",
    returnField: "return_clause",
    bodyField: "body",
    testPatterns: [/^test/],
  },

  ruby: {
    function: ["method", "singleton_method"],
    class: ["class", "module"],
    variable: ["assignment"],
    import: ["call"], // require/require_relative
    call: ["call", "method_call"],
    extends: ["superclass"],
    nameField: "name",
    paramsField: "parameters",
    bodyField: "body",
    testPatterns: [/^test_/, /^it /, /^describe /, /^context /],
    routePatterns: [/\.(get|post|put|patch|delete|match)\s/],
  },

  php: {
    function: ["function_definition", "method_declaration"],
    class: ["class_declaration"],
    interface: ["interface_declaration"],
    enum: ["enum_declaration"],
    variable: ["property_declaration"],
    decorator: ["attribute_list"],
    import: ["namespace_use_declaration"],
    call: ["function_call_expression", "member_call_expression"],
    extends: ["base_clause"],
    implements: ["class_interface_clause"],
    nameField: "name",
    paramsField: "formal_parameters",
    returnField: "return_type",
    bodyField: "body",
    testPatterns: [/^test/, /@test/],
    routePatterns: [/Route::(get|post|put|patch|delete)/],
  },

  // ── Tier 2: Standard extraction ──

  scala: {
    function: ["function_definition", "val_definition"],
    class: ["class_definition", "object_definition", "trait_definition"],
    import: ["import_declaration"],
    call: ["call_expression"],
    extends: ["extends_clause"],
    nameField: "name",
    paramsField: "parameters",
    returnField: "return_type",
    bodyField: "body",
  },

  dart: {
    function: ["function_signature", "method_signature"],
    class: ["class_definition"],
    enum: ["enum_declaration"],
    import: ["import_or_export"],
    call: ["function_expression_invocation"],
    extends: ["superclass"],
    implements: ["interfaces"],
    nameField: "name",
    paramsField: "formal_parameter_list",
    returnField: "type",
    bodyField: "body",
  },

  elixir: {
    function: ["call"], // def/defp
    class: ["call"], // defmodule
    import: ["call"], // import/use/alias
    call: ["call"],
    nameField: "target",
    bodyField: "body",
  },

  haskell: {
    function: ["function_declaration"],
    class: ["type_class_declaration"],
    type: ["type_declaration", "data_declaration", "newtype_declaration"],
    import: ["import_declaration"],
    call: ["function_application"],
    nameField: "name",
  },

  lua: {
    function: ["function_declaration", "local_function_declaration"],
    variable: ["variable_declaration", "local_variable_declaration"],
    import: ["function_call"], // require
    call: ["function_call"],
    nameField: "name",
    paramsField: "parameters",
    bodyField: "body",
  },

  zig: {
    function: ["function_declaration"],
    class: ["container_declaration"],
    variable: ["variable_declaration"],
    import: ["builtin_call_expr"], // @import
    call: ["call_expression"],
    nameField: "name",
    paramsField: "parameters",
    returnField: "return_type",
    bodyField: "body",
  },

  ocaml: {
    function: ["let_binding"],
    class: ["class_definition"],
    type: ["type_definition"],
    import: ["open_statement"],
    call: ["application"],
    nameField: "name",
    bodyField: "body",
  },

  julia: {
    function: ["function_definition", "short_function_definition"],
    class: ["struct_definition"],
    type: ["abstract_definition"],
    import: ["import_statement", "using_statement"],
    call: ["call_expression"],
    nameField: "name",
    paramsField: "parameters",
    bodyField: "body",
  },

  r: {
    function: ["function_definition"],
    variable: ["left_assignment", "right_assignment"],
    import: ["call"], // library/require
    call: ["call"],
    nameField: "name",
    paramsField: "parameters",
    bodyField: "body",
  },

  perl: {
    function: ["subroutine_declaration_statement"],
    import: ["use_statement", "require_statement"],
    call: ["call_expression"],
    nameField: "name",
    paramsField: "prototype",
    bodyField: "body",
  },

  bash: {
    function: ["function_definition"],
    variable: ["variable_assignment"],
    import: ["command"], // source/.
    call: ["command"],
    nameField: "name",
    bodyField: "body",
  },

  // ── Tier 3: Basic extraction ──

  toml: {
    function: [],
    import: [],
    call: [],
    variable: ["pair"],
    nameField: "key",
  },

  yaml: {
    function: [],
    import: [],
    call: [],
    variable: ["block_mapping_pair"],
    nameField: "key",
  },

  sql: {
    function: ["create_function_statement"],
    import: [],
    call: ["function_call"],
    variable: ["create_table_statement"],
    nameField: "name",
  },

  hcl: {
    function: [],
    import: [],
    call: ["function_call"],
    variable: ["block"],
    nameField: "type",
  },

  css: {
    function: [],
    import: ["import_statement"],
    call: ["call_expression"],
    class: ["rule_set"], // selectors
    nameField: "selector",
  },

  html: {
    function: [],
    import: [],
    call: [],
    nameField: "tag_name",
  },
};

/**
 * Get language key from file extension.
 */
export function getLanguageFromPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return EXTENSION_MAP[ext] || null;
}
