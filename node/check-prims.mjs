// Checks the Rust RNG and pow against V8 bit-for-bit.
import { execFileSync } from "node:child_process"
const bin = process.argv[2]
// RNG: the site's Xi, including the double-precision counter beyond 2^53
function Xi(r) { let e = r >>> 0; return () => { e += 1831565813; let t = e; return (t = Math.imul(t ^ (t >>> 15), t | 1)), (t ^= t + Math.imul(t ^ (t >>> 7), t | 61)), ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const hex = x => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getBigUint64(0).toString(16).padStart(16, "0") }
let bad = 0
for (const seed of [0, 1, 12345, 2 ** 31 - 1, 4294967295, 20260729]) {
  const n = 6000000
  const out = execFileSync(bin, ["rng", String(seed), String(n)], { maxBuffer: 1 << 30 }).toString().trim().split("\n")
  const g = Xi(seed)
  for (let i = 0; i < n; i++) if (hex(g()) !== out[i]) { bad++; console.log("rng mismatch seed", seed, "i", i); break }
}
console.log("rng checked, mismatches:", bad)
// pow(x, 1.4) on typical rating magnitudes plus random doubles
let lines = []
const xs = []
let s = 1
const r = () => (s = (s * 16807) % 2147483647) / 2147483647
for (let i = 0; i < 2000000; i++) {
  const x = i % 4 === 0 ? r() * 5000 : i % 4 === 1 ? r() * 1e6 : i % 4 === 2 ? 10 + r() * 400 * (1 + r()) : Math.exp(r() * 40 - 20)
  const y = i % 7 === 0 ? r() * 4 - 2 : 1.4
  xs.push([x, y]); lines.push(`${x} ${y}`)
}
const out = execFileSync(bin, [process.argv[3] || "pow"], { input: lines.join("\n"), maxBuffer: 1 << 30 }).toString().trim().split("\n")
let pbad = 0
for (let i = 0; i < xs.length; i++) if (hex(Math.pow(xs[i][0], xs[i][1])) !== out[i]) { if (pbad < 5) console.log("pow mismatch", xs[i], hex(Math.pow(...xs[i])), out[i]); pbad++ }
console.log("pow checked", xs.length, "mismatches:", pbad)
