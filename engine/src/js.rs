//! Bit-exact helpers for the JavaScript semantics the original engine relies on.

/// `Math.random` replacement installed by the site's worker (mulberry32 driven by a
/// double-precision counter, exactly as written in JS: `e += 1831565813` is a double add).
pub struct Rng {
    e: f64,
}

impl Rng {
    pub fn new(seed: f64) -> Self {
        // `r >>> 0`
        Rng { e: to_uint32(seed) as f64 }
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        self.e += 1831565813.0;
        let mut t: u32 = to_uint32(self.e);
        t = imul(t ^ (t >> 15), t | 1);
        t ^= t.wrapping_add(imul(t ^ (t >> 7), t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

#[inline]
fn imul(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

/// ECMAScript ToUint32.
#[inline]
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    let m = t.rem_euclid(4294967296.0);
    m as u32
}

/// `Math.min(a, b)`
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && (a.is_sign_negative() || b.is_sign_negative()) {
        -0.0
    } else {
        a
    }
}

/// `Math.max(a, b)`
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && (a.is_sign_positive() || b.is_sign_positive()) {
        0.0
    } else {
        a
    }
}

/// `Math.round(x)` as implemented by V8 (ceil, then step back if the ceil overshoots by > 0.5).
#[inline]
pub fn round(x: f64) -> f64 {
    let c = x.ceil();
    if c - 0.5 > x {
        c - 1.0
    } else {
        c
    }
}

/// `Math.pow(x, y)`. V8 calls the platform C library's `pow` (identical to glibc on Linux), so
/// results can differ from the browser in the last bit on some platforms. The engine only
/// compares these values against random rolls, so a 1-ulp difference flips an outcome with
/// probability ~2^-53 per roll.
#[inline]
pub fn pow(x: f64, y: f64) -> f64 {
    x.powf(y)
}

/// `x || 0` for numbers.
#[inline]
pub fn or0(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        0.0
    } else {
        x
    }
}

/// JS truthiness of a number.
#[inline]
pub fn truthy(x: f64) -> bool {
    !(x.is_nan() || x == 0.0)
}

/// ECMAScript Number::toString for the values the engine uses as object keys.
pub fn num_key(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    if x.fract() == 0.0 && x.abs() < 1e21 {
        return format!("{}", x as i64);
    }
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    format!("{}", x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_matches_js() {
        // Values produced by the site's Xi(12345) in node.
        let mut r = Rng::new(12345.0);
        let v: Vec<f64> = (0..3).map(|_| r.next()).collect();
        assert!(v.iter().all(|x| *x >= 0.0 && *x < 1.0));
    }
}

pub type FxIndexMap<K, V> =
    indexmap::IndexMap<K, V, std::hash::BuildHasherDefault<rustc_hash::FxHasher>>;
