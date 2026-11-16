import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Reflection bridge: line-delimited JSON-RPC over stdin/stdout, any public class/method of the JVM
 * (Ghidra included) callable by name with handle ids (jpype equivalent, pure JDK, no dependency).
 * Launch: java -cp Utility.jar:<this dir> ghidra.Ghidra GhidraBridge  (or plain `java Bridge` for JDK-only use).
 * Request:  {"id":N,"op":"new|call|static|field|setfield|list|str|class|instanceof|release|batch|ping", ...}
 * Value encoding: null,bool,string,number; {"$h":id,"c":cls} handle; {"$long":"n"}; {"$bytes":"b64"}; {"$class":"name"};
 * {"$arr":"elemType","v":[...]}.
 */
public final class Bridge {
  static final Map<Integer, Object> handles = new HashMap<>();
  static final IdentityHashMap<Object, Integer> ids = new IdentityHashMap<>();
  static int next = 1;
  static ClassLoader loader;
  /** GhidraApplicationLayout handed over by GhidraBridge (null for plain `java Bridge`); op `layout` returns it. */
  static Object launchLayout;

  public static void main(String[] args) throws Exception {
    PrintStream proto = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
    System.setOut(System.err); // Ghidra/log noise must never corrupt the protocol stream
    loader = Thread.currentThread().getContextClassLoader();
    if (loader == null) loader = ClassLoader.getSystemClassLoader();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isBlank()) continue;
      StringBuilder sb = new StringBuilder();
      try {
        Object req = new Json(line).parse();
        sb.append(handle((Map<String, Object>) req));
      } catch (Throwable t) {
        sb.append(err(null, t));
      }
      proto.print(sb.append('\n'));
      proto.flush();
    }
    System.exit(0); // stdin closed: do not let non-daemon Ghidra threads keep the JVM alive
  }

  static String idJson(Object id) {
    if (id == null) return "null";
    if (id instanceof Number) return id.toString();
    return Json.str(String.valueOf(id));
  }

  static String err(Object id, Throwable t) {
    while (t instanceof InvocationTargetException && t.getCause() != null) t = t.getCause();
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    String tr = sw.toString();
    if (tr.length() > 4000) tr = tr.substring(0, 4000);
    return "{\"id\":" + idJson(id) + ",\"error\":{\"type\":"
        + Json.str(t.getClass().getName()) + ",\"message\":" + Json.str(String.valueOf(t.getMessage())) + ",\"trace\":"
        + Json.str(tr) + "}}";
  }

  static String handle(Map<String, Object> r) {
    Object id = r.get("id");
    try {
      StringBuilder sb = new StringBuilder();
      sb.append("{\"id\":").append(idJson(id)).append(",\"result\":");
      enc(exec(r), sb);
      return sb.append('}').toString();
    } catch (Throwable t) {
      return err(id, t);
    }
  }

  /** The object behind request field `h`; a stale handle is an error, never a silent null. */
  static Object reqHandle(Map<String, Object> r) {
    Object o = handles.get(((Number) r.get("h")).intValue());
    if (o == null) throw new IllegalStateException("stale handle " + r.get("h"));
    return o;
  }

  @SuppressWarnings("unchecked")
  static Object exec(Map<String, Object> r) throws Throwable {
    String op = (String) r.get("op");
    List<Object> a = (List<Object>) r.getOrDefault("a", new ArrayList<>());
    switch (op) {
      case "ping": return "pong";
      case "layout": return launchLayout;
      case "batch": {
        List<Object> out = new InlineList();
        for (Object o : (List<Object>) r.get("reqs")) {
          try { out.add(new Raw(handle2((Map<String, Object>) o))); } catch (Throwable t) { out.add(new Raw(err(null, t))); }
        }
        return out;
      }
      case "new": {
        Class<?> c = cls((String) r.get("c"));
        return invokeBest(c.getConstructors(), null, a, c.getName());
      }
      case "call": {
        Object target = reqHandle(r);
        return callMethod(target.getClass(), target, (String) r.get("m"), a);
      }
      case "static": {
        Class<?> c = cls((String) r.get("c"));
        return callMethod(c, null, (String) r.get("m"), a);
      }
      case "field": {
        Object t = r.containsKey("h") ? reqHandle(r) : null;
        Class<?> c = t != null ? t.getClass() : cls((String) r.get("c"));
        Field f = findField(c, (String) r.get("f"));
        return f.get(t);
      }
      case "setfield": {
        Object t = r.containsKey("h") ? reqHandle(r) : null;
        Class<?> c = t != null ? t.getClass() : cls((String) r.get("c"));
        Field f = findField(c, (String) r.get("f"));
        f.set(t, conv(a.get(0), f.getType()));
        return null;
      }
      case "list": return listOf(reqHandle(r));
      case "str": return String.valueOf(reqHandle(r));
      case "class": return cls((String) r.get("c"));
      case "instanceof": return cls((String) r.get("c")).isInstance(reqHandle(r));
      case "release": {
        for (Object o : (List<Object>) r.get("hs")) {
          Object v = handles.remove(((Number) o).intValue());
          if (v != null) ids.remove(v);
        }
        return null;
      }
      default: throw new IllegalArgumentException("unknown op " + op);
    }
  }

  @SuppressWarnings("unchecked")
  static String handle2(Map<String, Object> r) { return handle(r); }

  static final class Raw { final String s; Raw(String s) { this.s = s; } }

  static Class<?> cls(String n) throws ClassNotFoundException {
    if (n.endsWith("[]")) return cls(n.substring(0, n.length() - 2)).arrayType();
    switch (n) {
      case "void": return void.class;
      case "int": return int.class; case "long": return long.class; case "boolean": return boolean.class;
      case "double": return double.class; case "float": return float.class; case "short": return short.class;
      case "byte": return byte.class; case "char": return char.class;
    }
    try { return Class.forName(n, true, loader); } catch (ClassNotFoundException e) { return Class.forName(n); }
  }

  static Field findField(Class<?> c, String n) throws NoSuchFieldException {
    for (Class<?> k = c; k != null; k = k.getSuperclass()) {
      try { Field f = k.getDeclaredField(n); if (f.trySetAccessible() || Modifier.isPublic(f.getModifiers())) return f; }
      catch (NoSuchFieldException e) { /* next */ }
    }
    return c.getField(n);
  }

  static List<Object> listOf(Object o) {
    List<Object> out = new InlineList();
    if (o == null) return out;
    if (o.getClass().isArray()) { for (int i = 0, n = Array.getLength(o); i < n; i++) out.add(Array.get(o, i)); }
    else if (o instanceof Map) { out.addAll(((Map<?, ?>) o).entrySet()); }
    else if (o instanceof Iterable) { for (Object x : (Iterable<?>) o) out.add(x); }
    else if (o instanceof Iterator) { Iterator<?> it = (Iterator<?>) o; while (it.hasNext()) out.add(it.next()); }
    else if (o instanceof java.util.stream.BaseStream) { ((java.util.stream.BaseStream<?, ?>) o).iterator().forEachRemaining(out::add); }
    else throw new IllegalArgumentException("not iterable: " + o.getClass().getName());
    return out;
  }

  static Object callMethod(Class<?> c, Object target, String name, List<Object> a) throws Throwable {
    List<Method> ms = new ArrayList<>();
    for (Method m : c.getMethods()) if (m.getName().equals(name) && (target != null || Modifier.isStatic(m.getModifiers()))) ms.add(m);
    if (ms.isEmpty()) throw new NoSuchMethodException(c.getName() + "." + name);
    return invokeBest(ms.toArray(new Executable[0]), target, a, name);
  }

  static Object invokeBest(Executable[] cands, Object target, List<Object> a, String what) throws Throwable {
    Executable best = null; Object[] bestArgs = null; int bestCost = Integer.MAX_VALUE;
    for (Executable e : cands) {
      Object[] cv = new Object[1];
      int cost = tryConv(e, a, cv);
      if (cost >= 0 && (cost < bestCost || (cost == bestCost && moreSpecific(e, best)))) { best = e; bestArgs = (Object[]) cv[0]; bestCost = cost; }
    }
    if (best == null) {
      StringBuilder sb = new StringBuilder("no overload of " + what + " for " + a.size() + " args; candidates:");
      for (Executable e : cands) sb.append(' ').append(e.toGenericString());
      throw new NoSuchMethodException(sb.toString());
    }
    if (best instanceof Constructor) {
      Constructor<?> k = (Constructor<?>) best;
      if (!Modifier.isPublic(k.getDeclaringClass().getModifiers())) k.trySetAccessible();
      return k.newInstance(bestArgs);
    }
    Method m = (Method) best;
    m = publicMethod(m);
    if (!m.trySetAccessible() && !Modifier.isPublic(m.getDeclaringClass().getModifiers()))
      throw new IllegalAccessException("method " + m + " is not accessible (module does not open its package)");
    return m.invoke(target, bestArgs);
  }

  /** True when every parameter of `a` is the same as or narrower than the one of `b`, and at least one is narrower. */
  static boolean moreSpecific(Executable a, Executable b) {
    if (b == null) return true;
    Class<?>[] x = a.getParameterTypes(), y = b.getParameterTypes();
    if (x.length != y.length) return false;
    boolean narrower = false;
    for (int i = 0; i < x.length; i++) {
      if (x[i] == y[i]) continue;
      if (!y[i].isAssignableFrom(x[i])) return false;
      narrower = true;
    }
    return narrower;
  }

  static Method publicMethod(Method m) {
    if (Modifier.isPublic(m.getDeclaringClass().getModifiers())) return m;
    for (Class<?> k = m.getDeclaringClass(); k != null; k = k.getSuperclass()) {
      for (Class<?> i : allIfaces(k)) {
        try { Method mm = i.getMethod(m.getName(), m.getParameterTypes()); if (Modifier.isPublic(mm.getDeclaringClass().getModifiers())) return mm; } catch (NoSuchMethodException e) { /* next */ }
      }
      if (Modifier.isPublic(k.getModifiers())) {
        try { return k.getMethod(m.getName(), m.getParameterTypes()); } catch (NoSuchMethodException e) { /* next */ }
      }
    }
    return m;
  }

  static List<Class<?>> allIfaces(Class<?> k) {
    List<Class<?>> out = new ArrayList<>();
    for (Class<?> i : k.getInterfaces()) { out.add(i); out.addAll(allIfaces(i)); }
    return out;
  }

  /** Returns cost (>=0) when args convert, -1 otherwise; converted args in out[0]. */
  static int tryConv(Executable e, List<Object> a, Object[] out) {
    Class<?>[] pt = e.getParameterTypes();
    boolean va = e.isVarArgs();
    int cost = 0;
    Object[] res = new Object[pt.length];
    try {
      if (!va && pt.length != a.size()) return -1;
      if (va && a.size() < pt.length - 1) return -1;
      int fixed = va ? pt.length - 1 : pt.length;
      for (int i = 0; i < fixed; i++) { int[] c = new int[1]; res[i] = convCost(a.get(i), pt[i], c); cost += c[0]; }
      if (va) {
        Class<?> vt = pt[pt.length - 1];
        if (a.size() == pt.length) { // try passing array directly
          try { int[] c = new int[1]; res[pt.length - 1] = convCost(a.get(pt.length - 1), vt, c); cost += c[0]; out[0] = res; return cost; } catch (NoConv ex) { /* spread */ }
        }
        int n = a.size() - fixed;
        Object arr = Array.newInstance(vt.getComponentType(), n);
        for (int i = 0; i < n; i++) { int[] c = new int[1]; Array.set(arr, i, convCost(a.get(fixed + i), vt.getComponentType(), c)); cost += c[0] + 3; }
        res[pt.length - 1] = arr;
      }
      out[0] = res;
      return cost;
    } catch (NoConv ex) { return -1; }
  }

  static final class NoConv extends RuntimeException { NoConv() { super(null, null, false, false); } }

  static Object conv(Object v, Class<?> t) { return convCost(v, t, new int[1]); }

  @SuppressWarnings({"unchecked", "rawtypes"})
  static Object convCost(Object v, Class<?> t, int[] cost) {
    if (v == null) { if (t.isPrimitive()) throw new NoConv(); return null; }
    if (v instanceof Map) {
      Map<String, Object> m = (Map<String, Object>) v;
      if (m.containsKey("$h")) {
        Object o = handles.get(((Number) m.get("$h")).intValue());
        if (o == null) throw new IllegalStateException("stale handle " + m.get("$h"));
        if (t.isInstance(o)) { cost[0] += (t == Object.class ? 1 : 0); return o; }
        if (t.isPrimitive() && box(t).isInstance(o)) return o;
        throw new NoConv();
      }
      if (m.containsKey("$long")) {
        java.math.BigInteger bi = new java.math.BigInteger((String) m.get("$long"));
        if (t == java.math.BigInteger.class || (t == Object.class && bi.bitLength() > 63)) return bi;
        if (bi.bitLength() > 63) throw new NoConv();
        return numTo(bi.longValue(), t, cost);
      }
      if (m.containsKey("$bytes")) {
        if (t == byte[].class || t == Object.class) return Base64.getDecoder().decode((String) m.get("$bytes"));
        throw new NoConv();
      }
      if (m.containsKey("$class")) {
        if (t == Class.class || t == Object.class) { try { return cls((String) m.get("$class")); } catch (ClassNotFoundException x) { throw new NoConv(); } }
        throw new NoConv();
      }
      if (m.containsKey("$arr")) {
        Class<?> et; try { et = cls((String) m.get("$arr")); } catch (ClassNotFoundException x) { throw new NoConv(); }
        List<Object> l = (List<Object>) m.get("v");
        Object arr = Array.newInstance(et, l.size());
        for (int i = 0; i < l.size(); i++) Array.set(arr, i, convCost(l.get(i), et, cost));
        if (t.isInstance(arr)) return arr;
        throw new NoConv();
      }
      throw new NoConv();
    }
    if (v instanceof Boolean) {
      if (t == boolean.class || t == Boolean.class) return v;
      if (t == Object.class) { cost[0] += 2; return v; }
      throw new NoConv();
    }
    if (v instanceof Number) return numTo((Number) v, t, cost);
    if (v instanceof String) {
      String s = (String) v;
      if (t == String.class || t == CharSequence.class) return s;
      if (t == Object.class) { cost[0] += 2; return s; }
      if ((t == char.class || t == Character.class) && s.length() == 1) { cost[0] += 1; return s.charAt(0); }
      if (t.isEnum()) { cost[0] += 1; for (Object c : t.getEnumConstants()) if (((Enum) c).name().equals(s)) return c; throw new NoConv(); }
      if (t == File.class) { cost[0] += 2; return new File(s); }
      if (t == java.nio.file.Path.class) { cost[0] += 2; return java.nio.file.Path.of(s); }
      throw new NoConv();
    }
    if (v instanceof List) {
      List<Object> l = (List<Object>) v;
      if (t.isArray()) {
        Class<?> et = t.getComponentType();
        Object arr = Array.newInstance(et, l.size());
        for (int i = 0; i < l.size(); i++) Array.set(arr, i, convCost(l.get(i), et, cost));
        cost[0] += 1;
        return arr;
      }
      if (t == List.class || t == Collection.class || t == Iterable.class || t == Object.class) {
        List<Object> o = new ArrayList<>();
        for (Object x : l) o.add(convCost(x, Object.class, cost));
        cost[0] += 2;
        return o;
      }
      throw new NoConv();
    }
    throw new NoConv();
  }

  static Class<?> box(Class<?> p) {
    if (p == int.class) return Integer.class; if (p == long.class) return Long.class; if (p == boolean.class) return Boolean.class;
    if (p == double.class) return Double.class; if (p == float.class) return Float.class; if (p == short.class) return Short.class;
    if (p == byte.class) return Byte.class; if (p == char.class) return Character.class; return p;
  }

  static Object numTo(Number n, Class<?> t, int[] cost) {
    boolean integral = n instanceof Long || n instanceof Integer || (n.doubleValue() == Math.rint(n.doubleValue()) && Math.abs(n.doubleValue()) <= 9007199254740992.0);
    if (t == int.class || t == Integer.class) { if (!integral || n.longValue() != (int) n.longValue()) throw new NoConv(); return n.intValue(); }
    if (t == long.class || t == Long.class) { if (!integral) throw new NoConv(); cost[0] += 1; return n.longValue(); }
    if (t == short.class || t == Short.class) { if (!integral || n.longValue() != (short) n.longValue()) throw new NoConv(); cost[0] += 2; return n.shortValue(); }
    if (t == byte.class || t == Byte.class) { if (!integral || n.longValue() != (byte) n.longValue()) throw new NoConv(); cost[0] += 2; return n.byteValue(); }
    if (t == double.class || t == Double.class) { cost[0] += integral ? 3 : 0; return n.doubleValue(); }
    if (t == float.class || t == Float.class) { cost[0] += integral ? 3 : 1; return n.floatValue(); }
    if (t == Object.class) { cost[0] += 2; return integral ? (Object) n.longValue() : (Object) n.doubleValue(); }
    throw new NoConv();
  }

  static void enc(Object v, StringBuilder sb) {
    if (v == null) { sb.append("null"); return; }
    if (v instanceof Raw) { sb.append(((Raw) v).s); return; }
    if (v instanceof Boolean) { sb.append(v); return; }
    if (v instanceof String) { sb.append(Json.str((String) v)); return; }
    if (v instanceof Character) { sb.append(Json.str(String.valueOf(v))); return; }
    if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("{\"$double\":\"").append(d).append("\"}");
      else if (v instanceof Float) sb.append(((Float) v).floatValue());
      else sb.append(d);
      return;
    }
    if (v instanceof Long) {
      long l = (Long) v;
      if ((l > -(1L << 53) && l < (1L << 53))) sb.append(l); else sb.append("{\"$long\":\"").append(l).append("\"}");
      return;
    }
    if (v instanceof java.math.BigInteger) { sb.append("{\"$long\":\"").append(v).append("\"}"); return; }
    if (v instanceof Number && (v instanceof Integer || v instanceof Short || v instanceof Byte)) { sb.append(((Number) v).longValue()); return; }
    if (v instanceof byte[]) { sb.append("{\"$bytes\":\"").append(Base64.getEncoder().encodeToString((byte[]) v)).append("\"}"); return; }
    if (v instanceof InlineList) {
      sb.append('[');
      boolean first = true;
      for (Object o : (List<?>) v) { if (!first) sb.append(','); first = false; enc(o, sb); }
      sb.append(']');
      return;
    }
    Integer id = ids.get(v);
    if (id == null) { id = next++; ids.put(v, id); handles.put(id, v); }
    sb.append("{\"$h\":").append(id).append(",\"c\":").append(Json.str(v.getClass().getName())).append('}');
  }

  /** only InlineList (op list/batch results) is inlined by value; any other list becomes a handle */
  static final class InlineList extends ArrayList<Object> {}

  /** Minimal JSON reader/writer helper. */
  static final class Json {
    final String s; int i = 0;
    Json(String s) { this.s = s; }
    Object parse() { ws(); Object v = val(); ws(); if (i != s.length()) throw new IllegalArgumentException("bad JSON: trailing text at " + i); return v; }
    void expect(char c) { if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("bad JSON: expected '" + c + "' at " + i); i++; }
    boolean lit(String w) { if (!s.startsWith(w, i)) return false; int e = i + w.length(); if (e < s.length() && Character.isLetterOrDigit(s.charAt(e))) throw new IllegalArgumentException("bad JSON literal at " + i); i = e; return true; }
    void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    Object val() {
      if (i >= s.length()) throw new IllegalArgumentException("bad JSON: unexpected end");
      char c = s.charAt(i);
      if (c == '{') {
        i++; Map<String, Object> m = new LinkedHashMap<>(); ws();
        if (s.charAt(i) == '}') { i++; return m; }
        while (true) { ws(); String k = (String) val(); ws(); expect(':'); ws(); m.put(k, val()); ws(); if (i >= s.length()) throw new IllegalArgumentException("bad JSON: unexpected end"); char d = s.charAt(i++); if (d == '}') return m; if (d != ',') throw new IllegalArgumentException("bad JSON: expected , or } at " + (i - 1)); }
      }
      if (c == '[') {
        i++; List<Object> l = new ArrayList<>(); ws();
        if (s.charAt(i) == ']') { i++; return l; }
        while (true) { ws(); l.add(val()); ws(); if (i >= s.length()) throw new IllegalArgumentException("bad JSON: unexpected end"); char d = s.charAt(i++); if (d == ']') return l; if (d != ',') throw new IllegalArgumentException("bad JSON: expected , or ] at " + (i - 1)); }
      }
      if (c == '"') return strv();
      if (lit("true")) return Boolean.TRUE;
      if (lit("false")) return Boolean.FALSE;
      if (lit("null")) return null;
      int st = i;
      while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
      String n = s.substring(st, i);
      if (n.isEmpty()) throw new IllegalArgumentException("bad JSON at " + st);
      if (n.indexOf('.') < 0 && n.indexOf('e') < 0 && n.indexOf('E') < 0) return Long.parseLong(n);
      return Double.parseDouble(n);
    }
    String strv() {
      StringBuilder sb = new StringBuilder(); i++;
      while (true) {
        if (i >= s.length()) throw new IllegalArgumentException("bad JSON: unterminated string");
        char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c == '\\') {
          if (i >= s.length()) throw new IllegalArgumentException("bad JSON: unterminated escape");
          char e = s.charAt(i++);
          switch (e) {
            case 'n': sb.append('\n'); break; case 't': sb.append('\t'); break; case 'r': sb.append('\r'); break;
            case 'b': sb.append('\b'); break; case 'f': sb.append('\f'); break;
            case 'u': if (i + 4 > s.length()) throw new IllegalArgumentException("bad JSON: truncated \\u escape"); sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
            default: sb.append(e);
          }
        } else sb.append(c);
      }
    }
    static String str(String v) {
      StringBuilder sb = new StringBuilder("\"");
      for (int k = 0; k < v.length(); k++) {
        char c = v.charAt(k);
        switch (c) {
          case '"': sb.append("\\\""); break; case '\\': sb.append("\\\\"); break; case '\n': sb.append("\\n"); break;
          case '\r': sb.append("\\r"); break; case '\t': sb.append("\\t"); break;
          default: if (c < 0x20) sb.append(String.format("\\u%04x", (int) c)); else sb.append(c);
        }
      }
      return sb.append('"').toString();
    }
  }
}
