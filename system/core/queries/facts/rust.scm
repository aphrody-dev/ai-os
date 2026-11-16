(line_comment) @comment
(block_comment) @comment
(string_literal) @string
(raw_string_literal) @string
(use_declaration argument: (_) @import.source)
(call_expression function: (identifier) @call)
(call_expression function: (scoped_identifier) @call)
(call_expression function: (field_expression) @call)
