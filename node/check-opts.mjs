// Prints a sample of the option names the web UI gets (to eyeball translations).
const o = await (await fetch(process.argv[2] || "http://127.0.0.1:8765/api/options")).json()
const pick = (l, n) => l.slice(0, n).map(x => x.name).join(" / ")
const lines = [
  `zones (${o.zones.length}): ${pick(o.zones, 30)}`,
  `dungeons: ${pick(o.dungeons, 6)}`,
  `labyrinths: ${pick(o.labyrinths, 6)}`,
  `abilities: ${pick(o.abilities, 8)}`,
  `food: ${pick(o.food, 5)}`,
  `refined weapons: ${pick(o.equipment.weapon.filter(x => /（精）|★/.test(x.name)), 4)}`,
  `conditions: ${pick(o.trigger.conditions, 12)}`,
  `dependencies: ${pick(o.trigger.dependencies, 4)}`,
  `comparators: ${pick(o.trigger.comparators, 4)}`,
  `monsters: ${Object.values(o.names.monsters).slice(0, 12).join(" / ")}`,
  `untranslated monsters: ${Object.values(o.names.monsters).filter(n => /^[\x00-\x7f]+$/.test(n)).length}/${Object.keys(o.names.monsters).length}`,
]
require_free: {
  const fs = await import("node:fs")
  fs.writeFileSync("opts-sample.txt", lines.join("\n"))
}
