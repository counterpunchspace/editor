use std::str::FromStr;

use babelfont::filters::FontFilter;
use clap::Parser;

#[derive(Parser)]
struct Cli {
    #[command(flatten)]
    pub verbosity: clap_verbosity_flag::Verbosity,

    #[clap(long)]
    filter: Vec<String>,

    /// Path to the input file to convert
    font_path: std::path::PathBuf,

    /// Path to the output file
    output: std::path::PathBuf,
}

const SUPPORTED_EXTENSIONS: &[&str; 6] = &[
    "ufo",
    "designspace",
    "glyphs",
    "glyphspackage",
    "babelfont",
    "ttf",
];

// Convert filters to FontFilter trait objects
fn convert_filters(filter: &[String]) -> Vec<Box<dyn FontFilter>> {
    let mut result: Vec<Box<dyn FontFilter>> = Vec::new();
    for f in filter {
        let parts: Vec<&str> = f.splitn(2, '=').collect();
        match parts[0] {
            "retainglyphs" => {
                if parts.len() != 2 {
                    log::error!(
                        "retainglyphs filter requires a comma-separated list of glyph names"
                    );
                    continue;
                }
                let glyph_names: Vec<String> = parts[1].split(',').map(|s| s.to_string()).collect();
                result.push(Box::new(babelfont::filters::RetainGlyphs::new(glyph_names)));
            }
            "scaleupem" => {
                if parts.len() != 2 {
                    log::error!("scaleupem filter requires a new upem value");
                    continue;
                }
                let new_upem: u16 = match parts[1].parse() {
                    Ok(v) => v,
                    Err(_) => {
                        log::error!("Invalid upem value for scaleupem filter: {}", parts[1]);
                        continue;
                    }
                };
                result.push(Box::new(babelfont::filters::ScaleUpem::new(new_upem)));
            }
            "dropaxis" => {
                if parts.len() != 2 {
                    log::error!("dropaxis filter requires an axis tag");
                    continue;
                }
                let axis_tag =
                    fontdrasil::types::Tag::from_str(&parts[1]).expect("Invalid axis tag");
                result.push(Box::new(babelfont::filters::DropAxis::new(axis_tag)));
            }
            "dropfeatures" => {
                result.push(Box::new(babelfont::filters::DropFeatures::new()));
            }
            "dropkerning" => {
                result.push(Box::new(babelfont::filters::DropKerning::new()));
            }
            "dropguides" => {
                result.push(Box::new(babelfont::filters::DropGuides::new()));
            }
            "dropinstances" => {
                result.push(Box::new(babelfont::filters::DropInstances::new()));
            }
            _ => {
                log::warn!("Unknown filter: {}", parts[0]);
            }
        }
    }
    result
}

fn main() {
    let args = Cli::parse();
    env_logger::Builder::new()
        .filter_level(args.verbosity.into())
        .init();
    if !SUPPORTED_EXTENSIONS.contains(&args.font_path.extension().unwrap().to_str().unwrap()) {
        log::error!(
            "Input extension {:?} is not in the list of supported extensions: {:?}",
            args.font_path.extension().unwrap(),
            SUPPORTED_EXTENSIONS
        );
        std::process::exit(1);
    }
    if !SUPPORTED_EXTENSIONS.contains(&args.output.extension().unwrap().to_str().unwrap()) {
        log::error!(
            "Output extension {:?} is not in the list of supported extensions: {:?}",
            args.output.extension().unwrap(),
            SUPPORTED_EXTENSIONS
        );
        std::process::exit(1);
    }

    let filters = convert_filters(&args.filter);
    log::info!("Loading {}", args.font_path.display());

    let mut input = babelfont::load(args.font_path).expect("Failed to load font");
    if !filters.is_empty() {
        log::info!("Applying filters...");
        for filter in filters {
            filter
                .apply(&mut input)
                .expect("Failed to apply font filter");
        }
    }
    log::info!("Saving {}", args.output.display());
    input.save(args.output).expect("Failed to save font");
}
