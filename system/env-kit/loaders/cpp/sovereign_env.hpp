/*
 * sovereign_env.hpp — Header-only C++23 loader & redacted SecretString for C:\aphrody\.env
 */
#ifndef SOVEREIGN_ENV_HPP
#define SOVEREIGN_ENV_HPP

#include "sovereign_env.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <ostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace sovereign_env {

class SecretString {
public:
    SecretString() = default;
    explicit SecretString(std::string value) : inner_(std::move(value)) {}

    [[nodiscard]] std::string_view expose_secret() const noexcept { return inner_; }
    [[nodiscard]] std::size_t size() const noexcept { return inner_.size(); }
    [[nodiscard]] bool empty() const noexcept { return inner_.empty(); }

    friend std::ostream &operator<<(std::ostream &os, const SecretString &) {
        return os << "[REDACTED]";
    }

private:
    std::string inner_;
};

struct LoadOptions {
    std::filesystem::path env_path{};
    std::string service{"default"};
    std::vector<std::string> required{};
    bool override_existing{false};
    bool inject_process_env{true};
};

[[nodiscard]] inline std::filesystem::path resolve_monorepo_env_path(
    std::filesystem::path start_dir = std::filesystem::current_path()) {
    auto cur = std::filesystem::absolute(start_dir);
    while (true) {
        auto candidate = cur / ".env";
        if (std::filesystem::is_regular_file(candidate)) {
            return candidate;
        }
        auto parent = cur.parent_path();
        if (parent == cur || parent.empty()) {
            break;
        }
        cur = parent;
    }
    return std::filesystem::path{SOVEREIGN_DEFAULT_ENV_PATH};
}

[[nodiscard]] inline std::map<std::string, SecretString> load(const LoadOptions &opts = {}) {
    const auto target = opts.env_path.empty() ? resolve_monorepo_env_path() : opts.env_path;
    if (opts.inject_process_env && std::filesystem::is_regular_file(target)) {
        sovereign_env_load_file(target.string().c_str(), opts.override_existing ? 1 : 0);
    }

    std::map<std::string, SecretString> parsed;
    if (std::filesystem::is_regular_file(target)) {
        std::ifstream in(target);
        std::string line;
        while (std::getline(in, line)) {
            auto pos = line.find_first_not_of(" \t\r\n");
            if (pos == std::string::npos || line[pos] == '#') continue;
            std::string_view view(line.data() + pos, line.size() - pos);
            if (view.starts_with("export ")) {
                view.remove_prefix(7);
            }
            auto eq = view.find('=');
            if (eq == std::string_view::npos || eq == 0) continue;
            std::string key(view.substr(0, eq));
            while (!key.empty() && std::isspace(static_cast<unsigned char>(key.back()))) {
                key.pop_back();
            }
            const char *proc = std::getenv(key.c_str());
            if (proc && proc[0] != '\0') {
                parsed.emplace(std::move(key), SecretString(proc));
            }
        }
    }

    std::vector<std::string> missing;
    for (const auto &req : opts.required) {
        const char *val = std::getenv(req.c_str());
        if ((!val || val[0] == '\0') && (!parsed.contains(req) || parsed[req].empty())) {
            missing.push_back(req);
        }
    }
    if (!missing.empty()) {
        std::string joined;
        for (std::size_t i = 0; i < missing.size(); ++i) {
            if (i > 0) joined += ", ";
            joined += missing[i];
        }
        throw std::runtime_error("[service=" + opts.service + "] Missing required env keys: " + joined);
    }

    return parsed;
}

} // namespace sovereign_env

#endif /* SOVEREIGN_ENV_HPP */
