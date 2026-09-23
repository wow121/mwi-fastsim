//! Rust port of the combat-sim site's engine. Used by the native `mwi-fastsim` binary (JSON-lines
//! server) and, compiled to wasm32, by the browser build (see `wasm`).
pub mod data;
pub mod js;
pub mod prof;
pub mod queue;
pub mod result;
pub mod sim;
pub mod stats;
pub mod unit;

#[cfg(target_arch = "wasm32")]
mod wasm;
