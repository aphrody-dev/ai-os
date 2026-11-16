; Facts over JavaScript, TypeScript and TSX (node types shared by the three grammars).
; Capture vocabulary (every facts query uses it): @comment @string @import.source @import.name @call.
(comment) @comment
(string) @string
(template_string) @string
(import_statement
  (import_clause
    [(identifier) @import.name
     (named_imports (import_specifier name: (_) @import.name))
     (namespace_import (identifier) @import.name)])?
  source: (string) @import.source)
(export_statement source: (string) @import.source)
(call_expression function: (import) arguments: (arguments . (string) @import.source))
((call_expression function: (identifier) @_fn arguments: (arguments . (string) @import.source))
  (#eq? @_fn "require"))
(call_expression function: (identifier) @call)
(call_expression function: (member_expression) @call)
