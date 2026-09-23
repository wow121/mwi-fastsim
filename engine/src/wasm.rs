//! Plain C-ABI exports for the browser (no wasm-bindgen): the host copies UTF-8 JSON into memory
//! from `alloc`, calls `load_gamedata` / `run`, and reads the reply from `out_ptr` / `out_len`.
//! One engine per Web Worker; panics abort the instance (the host recreates it).
use crate::{data, sim};
use serde_json::{json, Value};
use std::cell::RefCell;

thread_local! {
    static GD: RefCell<Option<&'static data::GameData>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_out(s: String) -> i32 {
    OUT.with(|o| *o.borrow_mut() = s.into_bytes());
    0
}

fn input(ptr: *mut u8, len: usize) -> String {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
    String::from_utf8(bytes).unwrap_or_default()
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// Game data JSON (the exporter's format); the input buffer is consumed. Returns 0 or 1 (error
/// text in out).
#[no_mangle]
pub extern "C" fn load_gamedata(ptr: *mut u8, len: usize) -> i32 {
    let text = input(ptr, len);
    let parsed = serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()).and_then(|v| data::GameData::from_json(&v));
    match parsed {
        Ok(gd) => {
            // leaked on purpose: a worker loads game data once or twice in its life
            GD.with(|g| *g.borrow_mut() = Some(Box::leak(Box::new(gd))));
            set_out(String::new())
        }
        Err(e) => {
            set_out(e);
            1
        }
    }
}

/// Runs a compiled scenario JSON; out = `{"events":N,"result":{..}}` (result last) or
/// `{"error":".."}`. The input buffer is consumed.
#[no_mangle]
pub extern "C" fn run(ptr: *mut u8, len: usize, attacks: i32) -> i32 {
    let text = input(ptr, len);
    let gd = match GD.with(|g| *g.borrow()) {
        Some(g) => g,
        None => return set_out(json!({"error": "game data not loaded"}).to_string()),
    };
    let out = (|| {
        let sc: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let limit = sc.get("simulationTimeLimit").map(data::to_num).unwrap_or(0.0);
        let mut s = sim::Sim::new(gd, &sc, attacks != 0)?;
        s.simulate(limit)?;
        Ok::<_, String>((s.result_json(), s.events_processed))
    })();
    set_out(match out {
        Ok((res, events)) => format!("{{\"events\":{},\"result\":{}}}", events, serde_json::to_string(&res).unwrap()),
        Err(e) => json!({"error": e}).to_string(),
    })
}
