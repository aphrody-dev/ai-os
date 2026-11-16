cmake_minimum_required(VERSION 3.25)
project(aphrody_env_kit_loader LANGUAGES CXX)

# Header-only loader and redaction guard for the monorepo .env.
add_library(sovereign_env INTERFACE)
target_include_directories(sovereign_env INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(sovereign_env INTERFACE cxx_std_23)
