//! Talisman reroll Monte Carlo (the 符石洗练 planner's inner loop; strategy search and summaries stay
//! in node/app/opt-talisman.mjs). A job `{"talisman": {...}}` runs `runs` rerolls of one strategy and
//! returns their costs, so the host can spread one strategy over all engine threads / wasm workers.
//! Rules: see opt-talisman.mjs (game data talismanInfo + item descriptions, test server 2026-11).
use serde_json::{json, Value};

// item / price slots, in this order in `prices` and `counts`
const RESHAPE: usize = 0;
const REFORGE: usize = 1;
const MUTATE: usize = 2;
const FOCUS: usize = 3;
const ATTUNE: usize = 4;
const EXCHANGE: usize = 5;
const BIND: usize = 6;
const CORE1: usize = 7;
const N_ITEMS: usize = 10;
const OP_NAMES: [&str; 6] = ["reshape", "reforge", "mutate", "focus", "attune", "exchange"];
const ATTUNE_PLUS: usize = 100; // exchange first when a spare line holds a higher grade, else attune

#[derive(Clone, Copy, PartialEq)]
struct Line {
    t: usize,
    g: u32,
}

struct Model {
    w: Vec<f64>,
    special: Vec<bool>,
    focus_weight: f64,
    max_grade: u32,
    max_lines: usize,
    caps: [usize; 3], // reshape, reforge, mutate
    mutate_lines: usize,
    att_down: f64,
    att_up: f64,
    gw: Vec<f64>,
    add_cost: [(usize, f64); 5], // index = lines after adding
}

struct Strategy {
    add_max: bool,
    type_op: usize,
    last_type_op: usize,
    grade_op: usize,
    lock: u8, // 0 none, 1 ok, 2 type
    prio_ok: bool,
}

/// mulberry32 (same as the JS version)
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut x = self.0;
        x = (x ^ (x >> 15)).wrapping_mul(x | 1);
        x ^= x.wrapping_add((x ^ (x >> 7)).wrapping_mul(x | 61));
        ((x ^ (x >> 14)) as f64) / 4294967296.0
    }
}

fn num(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(d)
}

fn op_index(s: &str) -> Result<usize, String> {
    if s == "attune+" {
        return Ok(ATTUNE_PLUS);
    }
    OP_NAMES.iter().position(|n| *n == s).ok_or_else(|| format!("unknown talisman op {}", s))
}

fn parse_model(m: &Value) -> Result<Model, String> {
    let types = m.get("types").and_then(|x| x.as_array()).ok_or("talisman model without types")?;
    let caps = m.get("caps").ok_or("talisman model without caps")?;
    let gw: Vec<f64> = m.get("gradeWeights").and_then(|x| x.as_array()).ok_or("no gradeWeights")?.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
    let mut add_cost = [(CORE1, 1.0); 5];
    if let Some(a) = m.get("addCost").and_then(|x| x.as_object()) {
        for (k, v) in a {
            if let Ok(n) = k.parse::<usize>() {
                if n < 5 {
                    add_cost[n] = (num(v, "item", CORE1 as f64) as usize, num(v, "count", 1.0));
                }
            }
        }
    }
    Ok(Model {
        w: types.iter().map(|x| num(x, "weight", 0.0)).collect(),
        special: types.iter().map(|x| x.get("special").and_then(|s| s.as_bool()).unwrap_or(false)).collect(),
        focus_weight: num(m, "focusWeight", 5.0),
        max_grade: num(m, "maxGrade", 6.0) as u32,
        max_lines: num(m, "maxLines", 4.0) as usize,
        caps: [num(caps, "reshape", 4.0) as usize, num(caps, "reforge", 6.0) as usize, num(caps, "mutate", 6.0) as usize],
        mutate_lines: num(m, "mutateLines", 2.0) as usize,
        att_down: num(m, "attuneDown", 0.65),
        att_up: num(m, "attuneUp", 0.15),
        gw,
        add_cost,
    })
}

fn grade_roll(m: &Model, cap: usize, r: &mut Rng) -> u32 {
    let w = &m.gw[..cap.min(m.gw.len())];
    let mut x = r.next() * w.iter().sum::<f64>();
    for (i, v) in w.iter().enumerate() {
        x -= v;
        if x < 0.0 {
            return i as u32 + 1;
        }
    }
    w.len() as u32
}

/// A type not in `taken`, by weight (`ws`: the plain or the focused weights, `total` their sum).
fn type_roll(ws: &[f64], total: f64, taken: &[usize], r: &mut Rng) -> usize {
    let mut t = total;
    for &i in taken {
        t -= ws[i];
    }
    let mut v = r.next() * t;
    let mut last = 0;
    for (i, &w) in ws.iter().enumerate() {
        if w <= 0.0 || taken.contains(&i) {
            continue;
        }
        last = i;
        v -= w;
        if v < 0.0 {
            return i;
        }
    }
    last
}

struct Status {
    types: usize,
    ok: usize,
    deficit: u32,
    done: bool,
}

fn status(lines: &[Line], target: &[(usize, u32)]) -> Status {
    let (mut types, mut ok, mut deficit) = (0, 0, 0);
    for &(t, min) in target {
        match lines.iter().find(|l| l.t == t) {
            Some(l) => {
                types += 1;
                if l.g >= min {
                    ok += 1;
                } else {
                    deficit += min - l.g;
                }
            }
            None => deficit += min,
        }
    }
    Status { types, ok, deficit, done: ok == target.len() }
}

fn better(a: &Status, b: &Status, prio_ok: bool) -> bool {
    let k = if prio_ok {
        [a.ok as i64 - b.ok as i64, a.types as i64 - b.types as i64, b.deficit as i64 - a.deficit as i64]
    } else {
        [a.types as i64 - b.types as i64, a.ok as i64 - b.ok as i64, b.deficit as i64 - a.deficit as i64]
    };
    for d in k {
        if d != 0 {
            return d > 0;
        }
    }
    false
}

fn shuffle(v: &mut [usize], r: &mut Rng) {
    for k in (1..v.len()).rev() {
        let j = (r.next() * (k as f64 + 1.0)) as usize;
        v.swap(k, j);
    }
}

struct Ctx<'a> {
    m: &'a Model,
    target: &'a [(usize, u32)],
    plain_total: f64,
    focus_w: Vec<f64>,
    focus_total: f64,
}

/// The lines an orb would give (the talisman itself is unchanged).
fn apply(c: &Ctx, lines: &[Line], lock: Option<usize>, op: usize, r: &mut Rng) -> Vec<Line> {
    let m = c.m;
    let mut out = lines.to_vec();
    let free: Vec<usize> = (0..lines.len()).filter(|&i| Some(i) != lock).collect();
    match op {
        RESHAPE | REFORGE | FOCUS => {
            let mut taken: Vec<usize> = lock.map(|i| vec![lines[i].t]).unwrap_or_default();
            let (ws, total) = if op == FOCUS { (&c.focus_w[..], c.focus_total) } else { (&m.w[..], c.plain_total) };
            for &i in &free {
                out[i].t = type_roll(ws, total, &taken, r);
                taken.push(out[i].t);
                if op != FOCUS {
                    out[i].g = grade_roll(m, m.caps[if op == RESHAPE { 0 } else { 1 }], r);
                }
            }
        }
        MUTATE => {
            let mut pick = free.clone();
            shuffle(&mut pick, r);
            pick.truncate(m.mutate_lines);
            let mut taken: Vec<usize> = (0..lines.len()).filter(|i| !pick.contains(i)).map(|i| lines[i].t).collect();
            for &i in &pick {
                out[i].t = type_roll(&m.w, c.plain_total, &taken, r);
                taken.push(out[i].t);
                out[i].g = grade_roll(m, m.caps[2], r);
            }
        }
        ATTUNE => {
            for &i in &free {
                let x = r.next();
                let g = out[i].g as i64 + if x < m.att_down { -1 } else if x < m.att_down + m.att_up { 1 } else { 0 };
                out[i].g = g.clamp(1, m.max_grade as i64) as u32;
            }
        }
        EXCHANGE => {
            // a random derangement of the unlocked lines' grades
            let g: Vec<u32> = free.iter().map(|&i| lines[i].g).collect();
            let mut p: Vec<usize> = (0..free.len()).collect();
            loop {
                for (k, x) in p.iter_mut().enumerate() {
                    *x = k;
                }
                shuffle(&mut p, r);
                if !p.iter().enumerate().any(|(k, &v)| k == v) {
                    break;
                }
            }
            for (k, &i) in free.iter().enumerate() {
                out[i].g = g[p[k]];
            }
        }
        _ => {}
    }
    out
}

struct RunOut {
    cost: f64,
    done: bool,
    steps: u64,
    counts: [f64; N_ITEMS],
    log: Option<Vec<Value>>,
}

fn lines_json(lines: &[Line]) -> Value {
    Value::Array(lines.iter().map(|l| json!([l.t, l.g])).collect())
}

#[allow(clippy::too_many_arguments)]
fn run_once(c: &Ctx, start: &[Line], start_lock: Option<usize>, st: &Strategy, prices: &[f64; N_ITEMS], r: &mut Rng, max_cost: f64, max_steps: u64, log: bool) -> RunOut {
    let m = c.m;
    let target = c.target;
    let mut lines = start.to_vec();
    let mut lock = start_lock;
    let mut bound = lock.is_some();
    // a lock on a line the target does not need is taken off first (assumed free)
    if let Some(i) = lock {
        if !target.iter().any(|q| q.0 == lines[i].t) {
            lock = None;
            bound = false;
        }
    }
    let mut o = RunOut { cost: 0.0, done: false, steps: 0, counts: [0.0; N_ITEMS], log: if log { Some(Vec::new()) } else { None } };
    let mut pay = |o: &mut RunOut, item: usize, n: f64| {
        o.counts[item] += n;
        o.cost += prices[item] * n;
    };
    let want = if st.add_max { m.max_lines } else { target.len().max(lines.len()) };
    while lines.len() < want {
        let n = lines.len() + 1;
        let (item, cnt) = if n == 1 { (CORE1, 1.0) } else { m.add_cost[n] };
        pay(&mut o, item, cnt);
        let taken: Vec<usize> = lines.iter().map(|l| l.t).collect();
        let t = type_roll(&m.w, c.plain_total, &taken, r);
        let g = grade_roll(m, m.caps[1], r);
        lines.push(Line { t, g });
        if let Some(l) = o.log.as_mut() {
            l.push(json!({"op": "add", "lines": lines_json(&lines), "taken": true}));
        }
    }
    let mut cur = status(&lines, target);
    while !cur.done && o.steps < max_steps && o.cost < max_cost {
        o.steps += 1;
        if !bound && st.lock != 0 && lines.len() >= 2 {
            if let Some(i) = lines.iter().position(|l| target.iter().any(|q| q.0 == l.t && (st.lock == 2 || l.g >= q.1))) {
                pay(&mut o, BIND, 1.0);
                lock = Some(i);
                bound = true;
                if let Some(l) = o.log.as_mut() {
                    l.push(json!({"op": "bind", "lines": lines_json(&lines), "lock": i, "taken": true}));
                }
                continue;
            }
        }
        let missing = target.len() - cur.types;
        let mut op = if missing >= 2 { st.type_op } else if missing == 1 { st.last_type_op } else { st.grade_op };
        let unlocked = lines.len() - lock.map_or(0, |_| 1);
        if op == ATTUNE_PLUS {
            let free = |i: usize| Some(i) != lock;
            let spare = (0..lines.len()).filter(|&i| free(i) && !target.iter().any(|q| q.0 == lines[i].t)).map(|i| lines[i].g).max();
            let short = (0..lines.len()).filter(|&i| free(i) && target.iter().any(|q| q.0 == lines[i].t && lines[i].g < q.1)).map(|i| lines[i].g).min();
            op = match (spare, short) {
                (Some(a), Some(b)) if a > b && unlocked >= 2 => EXCHANGE,
                _ => ATTUNE,
            };
        }
        if (op == MUTATE || op == EXCHANGE) && unlocked < 2 {
            op = if op == MUTATE { REFORGE } else { ATTUNE };
        }
        if unlocked < 1 {
            break;
        }
        pay(&mut o, op, 1.0);
        let next_lines = apply(c, &lines, lock, op, r);
        let next = status(&next_lines, target);
        let take = better(&next, &cur, st.prio_ok);
        if let Some(l) = o.log.as_mut() {
            l.push(json!({"op": OP_NAMES[op], "lines": lines_json(&next_lines), "taken": take}));
        }
        if take {
            lines = next_lines;
            cur = next;
        }
    }
    o.done = cur.done;
    o
}

/// Job `{"talisman": {model, start: {lines: [[type, grade]], lock}, target: [[type, min]], strategy,
/// prices: [10], runs, seed, maxCost, maxSteps, logRun}}` -> `{costs: [cost | -1 (not reached)], steps,
/// counts: [10], log?}` (`log`: the steps of run number `logRun`)
pub fn run(job: &Value) -> Result<Value, String> {
    let m = parse_model(job.get("model").ok_or("talisman job without model")?)?;
    let pair = |v: &Value| -> (usize, u32) { (v.get(0).and_then(|x| x.as_u64()).unwrap_or(0) as usize, v.get(1).and_then(|x| x.as_u64()).unwrap_or(1) as u32) };
    let target: Vec<(usize, u32)> = job.get("target").and_then(|x| x.as_array()).ok_or("no target")?.iter().map(pair).collect();
    let s = job.get("start").ok_or("no start")?;
    let start: Vec<Line> = s.get("lines").and_then(|x| x.as_array()).map(|a| a.iter().map(|v| { let (t, g) = pair(v); Line { t, g } }).collect()).unwrap_or_default();
    let start_lock = s.get("lock").and_then(|x| x.as_i64()).filter(|&i| i >= 0 && (i as usize) < start.len()).map(|i| i as usize);
    let sv = job.get("strategy").ok_or("no strategy")?;
    let sstr = |k: &str| sv.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let st = Strategy {
        add_max: sstr("add") == "max",
        type_op: op_index(sstr("typeOp"))?,
        last_type_op: op_index(sstr("lastTypeOp"))?,
        grade_op: op_index(sstr("gradeOp"))?,
        lock: match sstr("lock") { "ok" => 1, "type" => 2, _ => 0 },
        prio_ok: sstr("prio") == "ok",
    };
    let mut prices = [0.0; N_ITEMS];
    if let Some(p) = job.get("prices").and_then(|x| x.as_array()) {
        for (i, v) in p.iter().enumerate().take(N_ITEMS) {
            prices[i] = v.as_f64().unwrap_or(0.0);
        }
    }
    let target_types: Vec<usize> = target.iter().map(|q| q.0).collect();
    let mut focus_w = m.w.clone();
    let mut picks = 0;
    for &t in &target_types {
        if t < focus_w.len() && !m.special[t] && picks < num(job.get("model").unwrap(), "focusPickLimit", 10.0) as usize {
            focus_w[t] *= m.focus_weight;
            picks += 1;
        }
    }
    let c = Ctx { m: &m, target: &target, plain_total: m.w.iter().sum(), focus_total: focus_w.iter().sum(), focus_w };
    let runs = num(job, "runs", 100.0) as u64;
    let max_cost = job.get("maxCost").and_then(|x| x.as_f64()).unwrap_or(f64::INFINITY);
    let max_steps = num(job, "maxSteps", 20000.0) as u64;
    let log_run = job.get("logRun").and_then(|x| x.as_u64());
    let mut r = Rng(num(job, "seed", 1.0) as u32);
    let mut costs = Vec::with_capacity(runs as usize);
    let mut steps = 0u64;
    let mut counts = [0.0; N_ITEMS];
    let mut log = None;
    for k in 0..runs {
        let o = run_once(&c, &start, start_lock, &st, &prices, &mut r, max_cost, max_steps, log_run == Some(k));
        costs.push(if o.done { o.cost } else { -1.0 });
        steps += o.steps;
        for i in 0..N_ITEMS {
            counts[i] += o.counts[i];
        }
        if o.log.is_some() {
            log = o.log;
        }
    }
    let mut out = json!({"costs": costs, "steps": steps, "counts": counts.to_vec()});
    if let Some(l) = log {
        out["log"] = Value::Array(l);
    }
    Ok(out)
}
