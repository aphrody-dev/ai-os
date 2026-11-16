#define MWG_BUILD_SHARED 1
#include "../include/aphrody_mwg.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} mwg_buf_t;

static int buf_reserve(mwg_buf_t *b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) {
    return 1;
  }
  size_t next = b->cap == 0 ? 512 : b->cap;
  while (next < b->len + extra + 1) {
    next *= 2;
  }
  char *p = (char *)realloc(b->data, next);
  if (p == nullptr) {
    return 0;
  }
  b->data = p;
  b->cap = next;
  return 1;
}

static void buf_append_n(mwg_buf_t *b, const char *s, size_t n) {
  if (s == nullptr || n == 0) {
    return;
  }
  if (!buf_reserve(b, n)) {
    return;
  }
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = '\0';
}

static void buf_append(mwg_buf_t *b, const char *s) {
  if (s != nullptr) {
    buf_append_n(b, s, strlen(s));
  }
}

static void buf_append_json_str(mwg_buf_t *b, const char *s, size_t n) {
  buf_append(b, "\"");
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"': buf_append(b, "\\\""); break;
      case '\\': buf_append(b, "\\\\"); break;
      case '\b': buf_append(b, "\\b"); break;
      case '\f': buf_append(b, "\\f"); break;
      case '\n': buf_append(b, "\\n"); break;
      case '\r': buf_append(b, "\\r"); break;
      case '\t': buf_append(b, "\\t"); break;
      default:
        if (c < 0x20) {
          char esc[8];
          snprintf(esc, sizeof(esc), "\\u%04x", (unsigned int)c);
          buf_append(b, esc);
        } else {
          buf_append_n(b, (const char *)&c, 1);
        }
        break;
    }
  }
  buf_append(b, "\"");
}

static char *buf_finish(mwg_buf_t *b) {
  if (b->data == nullptr) {
    char *empty = (char *)malloc(3);
    if (empty != nullptr) {
      memcpy(empty, "{}", 3);
    }
    return empty;
  }
  return b->data;
}

static const char *str_find_ci(const char *haystack, const char *needle) {
  if (haystack == nullptr || needle == nullptr || *needle == '\0') {
    return nullptr;
  }
  size_t nlen = strlen(needle);
  for (const char *p = haystack; *p != '\0'; ++p) {
    size_t i = 0;
    while (i < nlen && p[i] != '\0' &&
           tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i])) {
      ++i;
    }
    if (i == nlen) {
      return p;
    }
  }
  return nullptr;
}

static int str_contains_ci(const char *haystack, const char *needle) {
  return str_find_ci(haystack, needle) != nullptr;
}

static char *mwg_strdup_err(const char *msg) {
  mwg_buf_t b = {nullptr, 0, 0};
  buf_append(&b, "{\"error\":");
  buf_append_json_str(&b, msg, strlen(msg));
  buf_append(&b, "}");
  return buf_finish(&b);
}

uint32_t mwg_abi_version(void) {
  return APHRODY_MWG_ABI_VERSION;
}

void mwg_free(char *p) {
  free(p);
}

uint64_t mwg_hash64(const uint8_t *data, size_t len) {
  uint64_t h = 14695981039346656037ULL;
  if (data == nullptr) {
    return h;
  }
  for (size_t i = 0; i < len; ++i) {
    h ^= (uint64_t)data[i];
    h *= 1099511628211ULL;
  }
  return h;
}

char *mwg_audit_html_json(const char *html) {
  if (html == nullptr) {
    return mwg_strdup_err("null html input");
  }
  int has_doctype = str_contains_ci(html, "<!doctype html");
  int has_lang = str_contains_ci(html, "<html") && str_contains_ci(html, "lang=");
  int has_viewport = str_contains_ci(html, "name=\"viewport\"") ||
                     str_contains_ci(html, "name='viewport'");
  int user_scalable_no = str_contains_ci(html, "user-scalable=no") ||
                         str_contains_ci(html, "user-scalable=0");
  int has_color_scheme = str_contains_ci(html, "color-scheme");
  int has_title = str_contains_ci(html, "<title>") && str_contains_ci(html, "</title>");
  int has_main = str_contains_ci(html, "<main");
  int has_deprecated = str_contains_ci(html, "<marquee") ||
                       str_contains_ci(html, "<blink") ||
                       str_contains_ci(html, "<center") ||
                       str_contains_ci(html, "<font");

  int img_count = 0;
  int img_missing_alt = 0;
  int img_missing_dims = 0;
  const char *cur = html;
  while ((cur = str_find_ci(cur, "<img")) != nullptr) {
    ++img_count;
    const char *end = strchr(cur, '>');
    if (end == nullptr) {
      break;
    }
    size_t tag_len = (size_t)(end - cur);
    char *tag = (char *)malloc(tag_len + 1);
    if (tag != nullptr) {
      memcpy(tag, cur, tag_len);
      tag[tag_len] = '\0';
      if (!str_contains_ci(tag, "alt=")) {
        ++img_missing_alt;
      }
      if (!str_contains_ci(tag, "width=") || !str_contains_ci(tag, "height=")) {
        ++img_missing_dims;
      }
      free(tag);
    }
    cur = end + 1;
  }

  int score = 100;
  if (!has_doctype) score -= 15;
  if (!has_lang) score -= 10;
  if (!has_viewport) score -= 15;
  if (user_scalable_no) score -= 20;
  if (!has_title) score -= 15;
  if (!has_main) score -= 10;
  if (has_deprecated) score -= 15;
  if (img_missing_alt > 0) score -= 10;
  if (img_missing_dims > 0) score -= 10;
  if (score < 0) score = 0;

  mwg_buf_t b = {nullptr, 0, 0};
  char num[64];
  buf_append(&b, "{\"engine\":\"mwg-c23\",");
  snprintf(num, sizeof(num), "\"score\":%d,", score);
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasDoctype\":%s,", has_doctype ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasLang\":%s,", has_lang ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasViewport\":%s,", has_viewport ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"userScalableNo\":%s,", user_scalable_no ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasColorScheme\":%s,", has_color_scheme ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasTitle\":%s,", has_title ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasMainLandmark\":%s,", has_main ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasDeprecatedTags\":%s,", has_deprecated ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"imgCount\":%d,\"imgMissingAlt\":%d,\"imgMissingDimensions\":%d}",
           img_count, img_missing_alt, img_missing_dims);
  buf_append(&b, num);
  return buf_finish(&b);
}

char *mwg_audit_css_json(const char *css) {
  if (css == nullptr) {
    return mwg_strdup_err("null css input");
  }
  int has_focus_visible = str_contains_ci(css, ":focus-visible");
  int has_reduced_motion = str_contains_ci(css, "prefers-reduced-motion");
  int has_color_scheme = str_contains_ci(css, "color-scheme") || str_contains_ci(css, "light-dark(");
  int has_modern_sizing = str_contains_ci(css, "interpolate-size") ||
                          str_contains_ci(css, "calc-size(") ||
                          str_contains_ci(css, "field-sizing");
  int has_anchor = str_contains_ci(css, "anchor-name") || str_contains_ci(css, "position-anchor");
  int has_outline_none = str_contains_ci(css, "outline: none") ||
                         str_contains_ci(css, "outline:none") ||
                         str_contains_ci(css, "outline: 0");

  int layout_thrash = 0;
  const char *kf = str_find_ci(css, "@keyframes");
  if (kf != nullptr) {
    if (str_contains_ci(kf, "top:") || str_contains_ci(kf, "left:") ||
        str_contains_ci(kf, "width:") || str_contains_ci(kf, "height:")) {
      layout_thrash = 1;
    }
  }

  int score = 100;
  if (!has_focus_visible) score -= 15;
  if (!has_reduced_motion) score -= 15;
  if (has_outline_none && !has_focus_visible) score -= 20;
  if (layout_thrash) score -= 25;
  if (score < 0) score = 0;

  mwg_buf_t b = {nullptr, 0, 0};
  char num[64];
  buf_append(&b, "{\"engine\":\"mwg-c23\",");
  snprintf(num, sizeof(num), "\"score\":%d,", score);
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasFocusVisible\":%s,", has_focus_visible ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasReducedMotion\":%s,", has_reduced_motion ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasColorScheme\":%s,", has_color_scheme ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasModernSizing\":%s,", has_modern_sizing ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"hasAnchorPositioning\":%s,", has_anchor ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"outlineNoneWithoutFocusVisible\":%s,",
           (has_outline_none && !has_focus_visible) ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"layoutThrashingKeyframes\":%s}", layout_thrash ? "true" : "false");
  buf_append(&b, num);
  return buf_finish(&b);
}

char *mwg_audit_js_json(const char *js) {
  if (js == nullptr) {
    return mwg_strdup_err("null js input");
  }
  int uses_eval = str_contains_ci(js, "eval(") || str_contains_ci(js, "new Function(");
  int uses_doc_write = str_contains_ci(js, "document.write(");
  int uses_inner_html = str_contains_ci(js, ".innerHTML");
  int uses_var = strstr(js, "var ") != nullptr;
  int uses_sync_xhr = str_contains_ci(js, "XMLHttpRequest") && str_contains_ci(js, ", false)");

  int score = 100;
  if (uses_eval) score -= 35;
  if (uses_doc_write) score -= 25;
  if (uses_inner_html) score -= 15;
  if (uses_var) score -= 5;
  if (uses_sync_xhr) score -= 20;
  if (score < 0) score = 0;

  mwg_buf_t b = {nullptr, 0, 0};
  char num[64];
  buf_append(&b, "{\"engine\":\"mwg-c23\",");
  snprintf(num, sizeof(num), "\"score\":%d,", score);
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"usesEval\":%s,", uses_eval ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"usesDocumentWrite\":%s,", uses_doc_write ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"usesInnerHtml\":%s,", uses_inner_html ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"usesVar\":%s,", uses_var ? "true" : "false");
  buf_append(&b, num);
  snprintf(num, sizeof(num), "\"usesSyncXhr\":%s}", uses_sync_xhr ? "true" : "false");
  buf_append(&b, num);
  return buf_finish(&b);
}

char *mwg_parse_mdx_json(const char *mdx) {
  if (mdx == nullptr) {
    return mwg_strdup_err("null mdx input");
  }
  mwg_buf_t b = {nullptr, 0, 0};
  buf_append(&b, "{\"frontmatter\":{");

  const char *body = mdx;
  int fm_count = 0;
  if (strncmp(mdx, "---", 3) == 0 && (mdx[3] == '\n' || (mdx[3] == '\r' && mdx[4] == '\n'))) {
    const char *p = mdx + (mdx[3] == '\r' ? 5 : 4);
    const char *end = strstr(p, "\n---");
    if (end != nullptr) {
      const char *line = p;
      while (line < end) {
        const char *nl = strchr(line, '\n');
        if (nl == nullptr || nl > end) {
          nl = end;
        }
        size_t llen = (size_t)(nl - line);
        if (llen > 0 && line[llen - 1] == '\r') {
          --llen;
        }
        const char *colon = (const char *)memchr(line, ':', llen);
        if (colon != nullptr && colon > line) {
          size_t klen = (size_t)(colon - line);
          const char *val = colon + 1;
          size_t vlen = llen - klen - 1;
          while (vlen > 0 && (*val == ' ' || *val == '\t')) {
            ++val;
            --vlen;
          }
          if (vlen >= 2 && ((*val == '"' && val[vlen - 1] == '"') ||
                            (*val == '\'' && val[vlen - 1] == '\''))) {
            ++val;
            vlen -= 2;
          }
          if (fm_count > 0) {
            buf_append(&b, ",");
          }
          buf_append_json_str(&b, line, klen);
          buf_append(&b, ":");
          buf_append_json_str(&b, val, vlen);
          ++fm_count;
        }
        line = nl + 1;
      }
      body = end + 4;
      if (*body == '\r') ++body;
      if (*body == '\n') ++body;
    }
  }

  buf_append(&b, "},\"headings\":[");
  int heading_count = 0;
  int code_blocks = 0;
  int word_count = 0;
  int in_code = 0;

  const char *p = body;
  while (*p != '\0') {
    const char *nl = strchr(p, '\n');
    size_t llen = nl != nullptr ? (size_t)(nl - p) : strlen(p);
    if (llen > 0 && p[llen - 1] == '\r') {
      --llen;
    }
    if (llen >= 3 && strncmp(p, "```", 3) == 0) {
      if (!in_code) {
        ++code_blocks;
      }
      in_code = !in_code;
    } else if (!in_code && llen > 1 && p[0] == '#') {
      size_t level = 0;
      while (level < llen && level < 6 && p[level] == '#') {
        ++level;
      }
      if (level < llen && p[level] == ' ') {
        const char *text = p + level + 1;
        size_t tlen = llen - level - 1;
        if (heading_count > 0) {
          buf_append(&b, ",");
        }
        char hbuf[32];
        snprintf(hbuf, sizeof(hbuf), "{\"level\":%zu,\"text\":", level);
        buf_append(&b, hbuf);
        buf_append_json_str(&b, text, tlen);
        buf_append(&b, "}");
        ++heading_count;
      }
    }
    if (!in_code) {
      int in_word = 0;
      for (size_t i = 0; i < llen; ++i) {
        int is_sp = isspace((unsigned char)p[i]);
        if (!is_sp && !in_word) {
          ++word_count;
          in_word = 1;
        } else if (is_sp) {
          in_word = 0;
        }
      }
    }
    if (nl == nullptr) {
      break;
    }
    p = nl + 1;
  }

  char tail[128];
  snprintf(tail, sizeof(tail), "],\"wordCount\":%d,\"codeBlocks\":%d,\"bodyOffset\":%zu}",
           word_count, code_blocks, (size_t)(body - mdx));
  buf_append(&b, tail);
  return buf_finish(&b);
}

typedef struct {
  const char *id;
  size_t id_len;
  double score;
} mwg_rank_t;

static int cmp_rank_desc(const void *a, const void *b) {
  const mwg_rank_t *ra = (const mwg_rank_t *)a;
  const mwg_rank_t *rb = (const mwg_rank_t *)b;
  if (rb->score > ra->score) return 1;
  if (rb->score < ra->score) return -1;
  return 0;
}

char *mwg_search_guidance_json(const char *query, const char *corpus_json, uint32_t top_k) {
  if (query == nullptr || corpus_json == nullptr) {
    return mwg_strdup_err("null query or corpus_json");
  }
  if (top_k == 0) {
    top_k = 10;
  }

  /* Extract lowercase query tokens (up to 32 tokens). */
  char qtoks[32][64];
  size_t qcount = 0;
  const char *qp = query;
  while (*qp != '\0' && qcount < 32) {
    while (*qp != '\0' && !isalnum((unsigned char)*qp)) ++qp;
    if (*qp == '\0') break;
    size_t tlen = 0;
    while (*qp != '\0' && (isalnum((unsigned char)*qp) || *qp == '-') && tlen < 63) {
      qtoks[qcount][tlen++] = (char)tolower((unsigned char)*qp);
      ++qp;
    }
    qtoks[qcount][tlen] = '\0';
    if (tlen >= 2) {
      ++qcount;
    }
  }

  size_t cap = 64;
  size_t count = 0;
  mwg_rank_t *ranks = (mwg_rank_t *)malloc(cap * sizeof(mwg_rank_t));
  if (ranks == nullptr) {
    return mwg_strdup_err("oom");
  }

  /* Scan JSON array objects for "id":"..." and score against object slice. */
  const char *p = corpus_json;
  while ((p = strstr(p, "\"id\"")) != nullptr) {
    const char *obj_start = p;
    while (obj_start > corpus_json && *obj_start != '{') --obj_start;
    const char *obj_end = strchr(p, '}');
    if (obj_end == nullptr) break;

    const char *colon = strchr(p + 4, ':');
    if (colon == nullptr || colon > obj_end) {
      p = obj_end + 1;
      continue;
    }
    const char *q1 = strchr(colon, '"');
    if (q1 == nullptr || q1 > obj_end) {
      p = obj_end + 1;
      continue;
    }
    const char *q2 = strchr(q1 + 1, '"');
    if (q2 == nullptr || q2 > obj_end) {
      p = obj_end + 1;
      continue;
    }

    size_t slice_len = (size_t)(obj_end - obj_start + 1);
    char *slice = (char *)malloc(slice_len + 1);
    if (slice == nullptr) break;
    memcpy(slice, obj_start, slice_len);
    slice[slice_len] = '\0';

    double score = 0.0;
    for (size_t i = 0; i < qcount; ++i) {
      const char *m = slice;
      int hits = 0;
      while ((m = str_find_ci(m, qtoks[i])) != nullptr) {
        ++hits;
        m += strlen(qtoks[i]);
      }
      if (hits > 0) {
        double tf = (double)hits;
        score += (tf * 2.2) / (tf + 1.2);
      }
    }
    free(slice);

    if (score > 0.0) {
      if (count == cap) {
        cap *= 2;
        mwg_rank_t *nr = (mwg_rank_t *)realloc(ranks, cap * sizeof(mwg_rank_t));
        if (nr == nullptr) break;
        ranks = nr;
      }
      ranks[count].id = q1 + 1;
      ranks[count].id_len = (size_t)(q2 - (q1 + 1));
      ranks[count].score = score;
      ++count;
    }
    p = obj_end + 1;
  }

  if (count > 1) {
    qsort(ranks, count, sizeof(mwg_rank_t), cmp_rank_desc);
  }

  mwg_buf_t b = {nullptr, 0, 0};
  buf_append(&b, "[");
  size_t emit = count < (size_t)top_k ? count : (size_t)top_k;
  for (size_t i = 0; i < emit; ++i) {
    if (i > 0) buf_append(&b, ",");
    buf_append(&b, "{\"id\":");
    buf_append_json_str(&b, ranks[i].id, ranks[i].id_len);
    char sbuf[48];
    snprintf(sbuf, sizeof(sbuf), ",\"score\":%.4f}", ranks[i].score);
    buf_append(&b, sbuf);
  }
  buf_append(&b, "]");
  free(ranks);
  return buf_finish(&b);
}

typedef struct {
  const char *id;
  const char *baseline;
  const char *category;
  const char *guidance;
} mwg_feature_entry_t;

static const mwg_feature_entry_t MWG_KNOWN_FEATURES[] = {
  {"popover", "newly", "html", "Use native popover attribute and Invoker Commands instead of custom JS modal/tooltip positioning."},
  {"anchor-positioning", "limited", "css", "Use CSS anchor-name and position-anchor for tethered popovers/tooltips with @position-try fallbacks."},
  {"light-dark", "newly", "css", "Use color-scheme: light dark and light-dark(lightVal, darkVal) instead of duplicated media queries."},
  {"color-scheme", "widely", "css", "Declare color-scheme: light dark on :root and <meta name=\"color-scheme\"> for native form controls."},
  {"accent-color", "widely", "css", "Use accent-color on form controls to match brand tokens without custom checkbox markup."},
  {"scrollbar-color", "newly", "css", "Use standard scrollbar-color and scrollbar-width instead of ::-webkit-scrollbar hacks."},
  {"transition-behavior", "newly", "css", "Use transition-behavior: allow-discrete and @starting-style to animate display: none / top-layer."},
  {"interpolate-size", "limited", "css", "Use interpolate-size: allow-keywords or calc-size() to animate height: auto without JS."},
  {"field-sizing", "limited", "forms", "Use field-sizing: content on textarea/input for auto-growing form fields without JS."},
  {"customizable-select", "limited", "forms", "Use appearance: base-select for customizable native <select> menus."},
  {"user-pseudos", "newly", "forms", "Use :user-valid and :user-invalid for post-interaction form validation styling."},
  {"temporal", "limited", "js", "Use Temporal API for timezone-safe date/time math instead of legacy Date mutations."},
  {"arianotify", "limited", "accessibility", "Use element.ariaNotify() for polite/assertive screen reader announcements without live-region DOM hacks."},
  {"focusgroup", "limited", "accessibility", "Use focusgroup for roving tabindex keyboard navigation in toolbars/menus."},
  {"view-transitions", "newly", "css", "Use document.startViewTransition() and ::view-transition-* for smooth state transitions."},
};

char *mwg_feature_lookup_json(const char *feature_id) {
  if (feature_id == nullptr) {
    return mwg_strdup_err("null feature_id");
  }
  size_t n = sizeof(MWG_KNOWN_FEATURES) / sizeof(MWG_KNOWN_FEATURES[0]);
  for (size_t i = 0; i < n; ++i) {
    if (strcmp(MWG_KNOWN_FEATURES[i].id, feature_id) == 0) {
      mwg_buf_t b = {nullptr, 0, 0};
      buf_append(&b, "{\"found\":true,\"id\":");
      buf_append_json_str(&b, MWG_KNOWN_FEATURES[i].id, strlen(MWG_KNOWN_FEATURES[i].id));
      buf_append(&b, ",\"baseline\":");
      buf_append_json_str(&b, MWG_KNOWN_FEATURES[i].baseline, strlen(MWG_KNOWN_FEATURES[i].baseline));
      buf_append(&b, ",\"category\":");
      buf_append_json_str(&b, MWG_KNOWN_FEATURES[i].category, strlen(MWG_KNOWN_FEATURES[i].category));
      buf_append(&b, ",\"guidance\":");
      buf_append_json_str(&b, MWG_KNOWN_FEATURES[i].guidance, strlen(MWG_KNOWN_FEATURES[i].guidance));
      buf_append(&b, "}");
      return buf_finish(&b);
    }
  }
  mwg_buf_t b = {nullptr, 0, 0};
  buf_append(&b, "{\"found\":false,\"id\":");
  buf_append_json_str(&b, feature_id, strlen(feature_id));
  buf_append(&b, ",\"baseline\":\"unknown\"}");
  return buf_finish(&b);
}
