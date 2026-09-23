//! Optional section timers (`--features prof`), printed to stderr per job.
#[cfg(feature = "prof")]
mod imp {
    use std::cell::RefCell;
    use std::time::Instant;
    thread_local! {
        static T: RefCell<Vec<(&'static str, u128, u64)>> = RefCell::new(Vec::new());
    }
    pub struct Guard(&'static str, Instant);
    impl Drop for Guard {
        fn drop(&mut self) {
            let ns = self.1.elapsed().as_nanos();
            T.with(|t| {
                let mut t = t.borrow_mut();
                match t.iter_mut().find(|e| e.0 == self.0) {
                    Some(e) => {
                        e.1 += ns;
                        e.2 += 1;
                    }
                    None => t.push((self.0, ns, 1)),
                }
            });
        }
    }
    pub fn start(name: &'static str) -> Guard {
        Guard(name, Instant::now())
    }
    pub fn dump() {
        T.with(|t| {
            let mut t = t.borrow_mut();
            t.sort_by(|a, b| b.1.cmp(&a.1));
            for (n, ns, c) in t.iter() {
                eprintln!("{:>28} {:>9.2} ms {:>9} calls {:>8.0} ns/call", n, *ns as f64 / 1e6, c, *ns as f64 / *c as f64);
            }
            t.clear();
        });
    }
}
#[cfg(not(feature = "prof"))]
mod imp {
    pub struct Guard;
    #[inline(always)]
    pub fn start(_: &'static str) -> Guard {
        Guard
    }
    pub fn dump() {}
}
pub use imp::*;
