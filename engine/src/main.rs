use mwi_engine::{data, js, prof, sim};

use serde_json::{json, Value};
use std::io::{BufRead, BufWriter, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

/// Result line: `{"id":..,"ms":..,"events":..,"result":{..}}` with `result` last, so the Node
/// side can forward the raw text without re-parsing it.
fn run_job_line(gd: &data::GameData, job: &Value) -> String {
    let v = run_job(gd, job);
    match v.get("result") {
        Some(r) => format!(
            "{{\"id\":{},\"ms\":{},\"events\":{},\"result\":{}}}",
            v["id"], v["ms"], v["events"], serde_json::to_string(r).unwrap()
        ),
        None => v.to_string(),
    }
}

fn run_job(gd: &data::GameData, job: &Value) -> Value {
    let id = job.get("id").cloned().unwrap_or(Value::Null);
    let scenario = match job.get("scenario") {
        Some(s) => s,
        None => return json!({"id": id, "error": "job without scenario"}),
    };
    let limit = scenario
        .get("simulationTimeLimit")
        .map(data::to_num)
        .unwrap_or(0.0);
    let attacks = job.get("attacks").and_then(|a| a.as_bool()).unwrap_or(true);
    let t0 = Instant::now();
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut s = {
            let _g = prof::start("Sim::new");
            sim::Sim::new(gd, scenario, attacks)?
        };
        {
            let _g = prof::start("simulate(total)");
            s.simulate(limit)?;
        }
        let j = {
            let _g = prof::start("to_json");
            s.result_json()
        };
        prof::dump();
        Ok::<_, String>((j, s.events_processed))
    }));
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    match out {
        Ok(Ok((res, events))) => json!({"id": id, "result": res, "ms": ms, "events": events}),
        Ok(Err(e)) => json!({"id": id, "error": e}),
        Err(p) => {
            let msg = p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".into());
            json!({"id": id, "error": format!("panic: {}", msg)})
        }
    }
}

fn load_gamedata(path: &str) -> data::GameData {
    let text = std::fs::read_to_string(path).expect("read gamedata");
    let v: Value = serde_json::from_str(&text).expect("parse gamedata");
    data::GameData::from_json(&v).expect("gamedata")
}

/// `serve <gamedata.json> [threads]`: JSON-lines jobs on stdin, results on stdout
/// (unordered, matched by id). A line `{"gamedata": "<path>"}` reloads the game data.
fn serve(path: &str, threads: usize) {
    let gd = Arc::new(Mutex::new(Arc::new(load_gamedata(path))));
    let (tx, rx) = mpsc::channel::<(Arc<data::GameData>, Value)>();
    let rx = Arc::new(Mutex::new(rx));
    let out = Arc::new(Mutex::new(BufWriter::new(std::io::stdout())));
    let mut handles = Vec::new();
    for _ in 0..threads {
        let rx = rx.clone();
        let out = out.clone();
        handles.push(std::thread::spawn(move || loop {
            let msg = { rx.lock().unwrap().recv() };
            let (g, job) = match msg {
                Ok(m) => m,
                Err(_) => break,
            };
            let r = run_job_line(&g, &job);
            let mut o = out.lock().unwrap();
            o.write_all(r.as_bytes()).unwrap();
            o.write_all(b"\n").unwrap();
            o.flush().unwrap();
        }));
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let mut o = out.lock().unwrap();
                writeln!(o, "{}", json!({"error": format!("bad json: {}", e)})).unwrap();
                o.flush().unwrap();
                continue;
            }
        };
        if let Some(p) = v.get("gamedata").and_then(|p| p.as_str()) {
            *gd.lock().unwrap() = Arc::new(load_gamedata(p));
            let mut o = out.lock().unwrap();
            writeln!(o, "{}", json!({"gamedataLoaded": p})).unwrap();
            o.flush().unwrap();
            continue;
        }
        let g = gd.lock().unwrap().clone();
        tx.send((g, v)).unwrap();
    }
    drop(tx);
    for h in handles {
        h.join().unwrap();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("serve") => {
            let threads = args
                .get(3)
                .and_then(|t| t.parse().ok())
                .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
            serve(&args[2], threads);
        }
        Some("powstd") => {
            let stdin = std::io::stdin();
            let mut out = BufWriter::new(std::io::stdout());
            for line in stdin.lock().lines() {
                let line = line.unwrap();
                let mut it = line.split_whitespace();
                let x: f64 = it.next().unwrap().parse().unwrap();
                let y: f64 = it.next().unwrap().parse().unwrap();
                writeln!(out, "{:016x}", x.powf(y).to_bits()).unwrap();
            }
        }
        Some("pow") => {
            // lines "x y" -> bits of pow(x, y) as hex
            let stdin = std::io::stdin();
            let mut out = BufWriter::new(std::io::stdout());
            for line in stdin.lock().lines() {
                let line = line.unwrap();
                let mut it = line.split_whitespace();
                let x: f64 = it.next().unwrap().parse().unwrap();
                let y: f64 = it.next().unwrap().parse().unwrap();
                writeln!(out, "{:016x}", js::pow(x, y).to_bits()).unwrap();
            }
        }
        Some("rng") => {
            let seed: f64 = args[2].parse().unwrap();
            let n: usize = args[3].parse().unwrap();
            let mut r = js::Rng::new(seed);
            for _ in 0..n {
                println!("{:016x}", r.next().to_bits());
            }
        }
        _ => {
            eprintln!("usage: mwi-fastsim serve <gamedata.json> [threads] | pow | rng <seed> <n>");
            std::process::exit(2);
        }
    }
}
