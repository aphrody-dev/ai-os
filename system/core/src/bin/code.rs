use clap::Parser;

fn main() {
    std::process::exit(aphrody_core::cli::run(aphrody_core::cli::Cli::parse().cmd));
}
