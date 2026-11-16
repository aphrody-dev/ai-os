; Block structure of CommonMark (tree-sitter-md block grammar). Capture @heading carries the whole heading; the
; level is the marker run (atx) or the underline (setext). Parents are reported by the engine (field `k`).
(minus_metadata) @frontmatter
(atx_heading) @heading
(setext_heading) @heading
(paragraph) @paragraph
(fenced_code_block) @code
(html_block) @html
(pipe_table) @table
(list_item) @item
