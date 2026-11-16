(comment) @comment
(string) @string
(import_statement name: (dotted_name) @import.source)
(import_statement name: (aliased_import name: (dotted_name) @import.source))
(import_from_statement module_name: (_) @import.source)
(call function: (identifier) @call)
(call function: (attribute) @call)
