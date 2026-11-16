-- sovereign_env.lua — Zero-dependency Lua 5.1+ / LuaJIT loader for C:\aphrody\.env
-- Returns a metatable-protected table with masked `__tostring` so print(env) never leaks secrets.

local M = {}

local is_windows = package.config:sub(1, 1) == "\\"
M.DEFAULT_MONOREPO_ENV_PATH = is_windows and "C:\\aphrody\\.env" or "/src/.env"

local SECRET_PATTERNS = {
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "API_KEY",
  "PRIVATE_KEY",
  "AUTH",
  "CREDENTIAL",
  "DATABASE_URL",
  "NUGET_API_KEY",
}

local SECRET_PREFIXES = {
  "^sk%-",
  "^AIza",
  "^figd_",
  "^gh[pousr]_",
  "^github_pat_",
  "^npm_",
  "^pypi%-",
  "^ctx7sk%-",
}

function M.is_secret_key(key, value)
  local upper = tostring(key or ""):upper()
  local val = tostring(value or "")
  local has_prefix = false
  for _, pref in ipairs(SECRET_PREFIXES) do
    if val:find(pref) then
      has_prefix = true
      break
    end
  end
  if (upper:sub(-4) == "_DIR" or upper:sub(-5) == "_PATH" or upper:sub(-5) == "_HOME") and not has_prefix then
    return false
  end
  if upper:sub(-4) == "_URL" and not upper:find("DATABASE_URL", 1, true) and not has_prefix then
    return false
  end
  if has_prefix then
    return true
  end
  for _, pat in ipairs(SECRET_PATTERNS) do
    if upper:find(pat, 1, true) then
      return true
    end
  end
  return false
end

function M.mask_value(key, value)
  if value == nil or value == "" then
    return "UNSET"
  end
  if M.is_secret_key(key, value) then
    return string.format("SET [len=%d]", #value)
  end
  return value
end

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

function M.parse_dotenv(content)
  local out = {}
  for raw_line in (content .. "\n"):gmatch("(.-)\r?\n") do
    local line = trim(raw_line)
    if line ~= "" and line:sub(1, 1) ~= "#" then
      if line:sub(1, 7) == "export " then
        line = trim(line:sub(8))
      end
      local eq = line:find("=", 1, true)
      if eq and eq > 1 then
        local key = trim(line:sub(1, eq - 1))
        if key:match("^[A-Za-z_][A-Za-z0-9_]*$") then
          local raw_val = trim(line:sub(eq + 1))
          local first = raw_val:sub(1, 1)
          local parsed = ""
          if first == '"' then
            local buf = {}
            local i = 2
            local escaped = false
            while i <= #raw_val do
              local ch = raw_val:sub(i, i)
              if escaped then
                if ch == "n" then table.insert(buf, "\n")
                elseif ch == "r" then table.insert(buf, "\r")
                elseif ch == "t" then table.insert(buf, "\t")
                else table.insert(buf, ch) end
                escaped = false
              elseif ch == "\\" then
                escaped = true
              elseif ch == '"' then
                break
              else
                table.insert(buf, ch)
              end
              i = i + 1
            end
            parsed = table.concat(buf)
          elseif first == "'" then
            local close_q = raw_val:find("'", 2, true)
            parsed = close_q and raw_val:sub(2, close_q - 1) or raw_val:sub(2)
          else
            local comment_pos = raw_val:find("%s+#")
            if comment_pos then
              raw_val = raw_val:sub(1, comment_pos - 1)
            end
            parsed = trim(raw_val)
          end
          out[key] = parsed
        end
      end
    end
  end
  return out
end

function M.load(opts)
  opts = opts or {}
  local env_path = opts.env_path or M.DEFAULT_MONOREPO_ENV_PATH
  local override = opts.override == true
  local required = opts.required or {}
  local service = opts.service or "default"

  local parsed = {}
  local fh = io.open(env_path, "rb")
  if fh then
    local text = fh:read("*a")
    fh:close()
    parsed = M.parse_dotenv(text or "")
  end

  local store = {}
  for k, v in pairs(parsed) do
    local proc = os.getenv(k)
    if not override and proc and proc ~= "" then
      store[k] = proc
    else
      store[k] = v
    end
  end

  local missing = {}
  for _, req in ipairs(required) do
    local val = store[req] or os.getenv(req)
    if not val or val == "" then
      table.insert(missing, req)
    end
  end
  if #missing > 0 then
    error(string.format("[service=%s] Missing required environment keys (%s) after checking %s",
      service, table.concat(missing, ", "), env_path))
  end

  local proxy = {}
  local mt = {
    __index = function(_, key)
      if key == "redacted" then
        return function()
          local r = {}
          for k, v in pairs(store) do
            r[k] = M.mask_value(k, v)
          end
          return r
        end
      end
      local v = store[key]
      if v ~= nil and v ~= "" then
        return v
      end
      return os.getenv(key)
    end,
    __newindex = function()
      error("sovereign_env table is read-only", 2)
    end,
    __tostring = function()
      local keys = {}
      for k in pairs(store) do
        table.insert(keys, k)
      end
      table.sort(keys)
      local parts = {}
      for _, k in ipairs(keys) do
        table.insert(parts, string.format("%s=%s", k, M.mask_value(k, store[k])))
      end
      return string.format("sovereign_env(%s) { %s }", env_path, table.concat(parts, ", "))
    end,
    __metatable = "sovereign_env_protected",
  }

  return setmetatable(proxy, mt)
end

return M
