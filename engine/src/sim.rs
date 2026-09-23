//! The combat simulator (`Wt` in the site's worker) and its setup from a compiled scenario.

use crate::data::*;
use crate::js::{self, Rng};
use crate::queue::{Ev, EvType, Queue};
use crate::result::SimResult;
use crate::stats::*;
use crate::unit::*;
use serde_json::Value;
use rustc_hash::FxHashMap as HashMap;
use smallvec::SmallVec;

type Units = SmallVec<[UnitId; 8]>;
use std::rc::Rc;

const X: f64 = 1e9;
const CONSUMABLE_TICK: f64 = 5.0 * X;
const DOT_TICK: f64 = 3.0 * X;
const REGEN_TICK: f64 = 10.0 * X;
const ENEMY_RESPAWN: f64 = 3.0 * X;
const PLAYER_RESPAWN: f64 = 150.0 * X;
const DUNGEON_RESTART: f64 = 3.0 * X;
const ENRAGE_TICK: f64 = 60.0 * X;

pub type SimErr = String;

struct Spawn {
    hrid: String,
    tier: f64,
    rate: f64,
    strength: f64,
}

struct SpawnInfo {
    spawns: Vec<Spawn>,
    max_spawn_count: f64,
    max_total_strength: f64,
}

impl SpawnInfo {
    fn parse(v: &Value) -> SpawnInfo {
        let spawns = match v.get("spawns") {
            Some(Value::Array(list)) => list
                .iter()
                .map(|s| Spawn {
                    hrid: string(s, "combatMonsterHrid"),
                    tier: num(s, "difficultyTier"),
                    rate: num(s, "rate"),
                    strength: num(s, "strength"),
                })
                .collect(),
            _ => Vec::new(),
        };
        SpawnInfo {
            spawns,
            max_spawn_count: num(v, "maxSpawnCount"),
            max_total_strength: num(v, "maxTotalStrength"),
        }
    }
}

fn parse_fixed(v: &Value) -> Vec<(String, f64)> {
    match v {
        Value::Array(list) => list
            .iter()
            .map(|s| (string(s, "combatMonsterHrid"), num(s, "difficultyTier")))
            .collect(),
        _ => Vec::new(),
    }
}

struct Dungeon {
    max_waves: f64,
    /// Object.entries order (integer-like keys ascending) of fixedSpawnsMap
    fixed: Vec<(String, Vec<(String, f64)>)>,
    /// randomSpawnInfoMap sorted by numeric key
    random: Vec<(f64, SpawnInfo)>,
}

struct Zone {
    hrid: String,
    tier: f64,
    is_dungeon: bool,
    random: Option<SpawnInfo>,
    boss: Option<Vec<(String, f64)>>,
    dungeon: Option<Dungeon>,
    encounters_killed: f64,
    dungeons_completed: f64,
    dungeons_failed: f64,
    dungeon_attempts_started: f64,
}

impl Zone {
    fn parse(v: &Value) -> Zone {
        let info = v.get("combatZoneInfo").cloned().unwrap_or(Value::Null);
        let fight = info.get("fightInfo").cloned().unwrap_or(Value::Null);
        let random = fight.get("randomSpawnInfo").map(SpawnInfo::parse);
        let boss = match fight.get("bossSpawns") {
            Some(Value::Array(_)) => Some(parse_fixed(fight.get("bossSpawns").unwrap())),
            _ => None,
        };
        let dungeon = match info.get("dungeonInfo") {
            Some(d @ Value::Object(_)) => {
                let mut fixed = Vec::new();
                if let Some(Value::Object(m)) = d.get("fixedSpawnsMap") {
                    for (k, s) in m {
                        fixed.push((k.clone(), parse_fixed(s)));
                    }
                }
                sort_js_keys(&mut fixed);
                let mut random = Vec::new();
                if let Some(Value::Object(m)) = d.get("randomSpawnInfoMap") {
                    for (k, s) in m {
                        random.push((k.parse::<f64>().unwrap_or(f64::NAN), SpawnInfo::parse(s)));
                    }
                }
                random.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                Some(Dungeon {
                    max_waves: num(d, "maxWaves"),
                    fixed,
                    random,
                })
            }
            _ => None,
        };
        Zone {
            hrid: string(v, "hrid"),
            tier: num(v, "difficultyTier"),
            is_dungeon: matches!(info.get("isDungeon"), Some(Value::Bool(true))),
            random,
            boss,
            dungeon,
            encounters_killed: 1.0,
            dungeons_completed: 0.0,
            dungeons_failed: 0.0,
            dungeon_attempts_started: 0.0,
        }
    }

    fn fail_wave(&mut self) {
        self.dungeons_failed += 1.0;
        self.encounters_killed = 1.0;
    }

    fn complete_dungeon(&mut self) {
        self.dungeons_completed += 1.0;
        self.encounters_killed = 1.0;
    }
}

/// Orders keys like JS objects do: array-index keys ascending first, then insertion order.
fn sort_js_keys<T>(v: &mut Vec<(String, T)>) {
    let is_index = |k: &str| {
        !k.is_empty()
            && k.bytes().all(|b| b.is_ascii_digit())
            && (k == "0" || !k.starts_with('0'))
            && k.len() < 10
    };
    let mut idx: Vec<(String, T)> = Vec::new();
    let mut rest: Vec<(String, T)> = Vec::new();
    for e in v.drain(..) {
        if is_index(&e.0) {
            idx.push(e);
        } else {
            rest.push(e);
        }
    }
    idx.sort_by_key(|e| e.0.parse::<u64>().unwrap());
    v.extend(idx);
    v.extend(rest);
}

struct Lab {
    monster_hrid: String,
    room_level: f64,
    encounter_start: f64,
}

/// JS value produced by a trigger dependency lookup.
enum Val {
    Num(f64),
    Bool(bool),
    Obj(bool),
    Str,
}

pub struct Sim<'a> {
    gd: &'a GameData,
    it: Interner,
    units: Vec<Unit>,
    players: Rc<[UnitId]>,
    enemies: Option<Rc<[UnitId]>>,
    zone: Option<Zone>,
    lab: Option<Lab>,
    q: Queue,
    time: f64,
    all_dead: bool,
    enrage_begin: f64,
    temp_dungeon_count: f64,
    rng: Rng,
    pub res: SimResult,
    ability_cache: HashMap<String, HashMap<u64, (Rc<AbilityDef>, Rc<Vec<Trigger>>)>>,
    blaze_def: Option<Rc<AbilityDef>>,
    bloom_def: Option<Rc<AbilityDef>>,
    monster_cache: HashMap<String, Rc<MonsterTemplate>>,
    u_fury_acc: u32,
    u_fury_dmg: u32,
    u_curse: u32,
    u_weaken: u32,
    u_enrage_dmg: u32,
    u_enrage_acc: u32,
    s_regen: u32,
    s_lifesteal: u32,
    s_mana_leech: u32,
    s_ripple: u32,
    s_auto: u32,
    s_parry: u32,
    s_dot: u32,
    s_retaliation: u32,
    s_physical_thorns: u32,
    s_elemental_thorns: u32,
    pub events_processed: u64,
}

fn two<T>(v: &mut [T], a: usize, b: usize) -> (&mut T, &mut T) {
    assert!(a != b);
    if a < b {
        let (x, y) = v.split_at_mut(b);
        (&mut x[a], &mut y[0])
    } else {
        let (x, y) = v.split_at_mut(a);
        (&mut y[0], &mut x[b])
    }
}

struct AttackOut {
    damage_done: f64,
    did_hit: bool,
    thorn_damage: f64,
    thorn_physical: bool,
    retaliation_damage: f64,
    life_steal_heal: f64,
    hp_drain: f64,
    mana_leech: f64,
}

impl<'a> Sim<'a> {
    pub fn new(gd: &'a GameData, sc: &Value, record_attacks: bool) -> Result<Sim<'a>, SimErr> {
        let mut it = Interner::default();
        for n in BUFF_TYPE_NAMES {
            it.id(n);
        }
        let u_fury_acc = it.id("/buff_uniques/fury_accuracy");
        let u_fury_dmg = it.id("/buff_uniques/fury_damage");
        let u_curse = it.id("/buff_uniques/curse");
        let u_weaken = it.id("/buff_uniques/weaken");
        let u_enrage_dmg = it.id("/buff_uniques/enrage_damage");
        let u_enrage_acc = it.id("/buff_uniques/enrage_accuracy");

        let zone = match sc.get("zone") {
            Some(z @ Value::Object(_)) => Some(Zone::parse(z)),
            _ => None,
        };
        let lab = match sc.get("labyrinth") {
            Some(l @ Value::Object(_)) => Some(Lab {
                monster_hrid: string(l, "monsterHrid"),
                room_level: num(l, "roomLevel"),
                encounter_start: 0.0,
            }),
            _ => None,
        };
        let players_v = sc
            .get("players")
            .and_then(|p| p.as_array())
            .ok_or("scenario has no players")?;
        let seed = sc.get("seed").map(to_num).unwrap_or(0.0);
        let res = SimResult::new(
            zone.as_ref().map(|z| (z.hrid.clone(), z.tier)),
            lab.as_ref().map(|l| (l.monster_hrid.clone(), l.room_level)),
            players_v.len(),
            record_attacks,
            &mut it,
        );
        let special: Vec<u32> = ["regen", "lifesteal", "manaLeech", "ripple", "autoAttack", "parry", "damageOverTime", "retaliation", "physicalThorns", "elementalThorns"]
            .iter()
            .map(|n| it.id(n))
            .collect();
        let mut sim = Sim {
            gd,
            it,
            units: Vec::new(),
            players: Rc::from(Vec::new()),
            enemies: None,
            zone,
            lab,
            q: Queue::default(),
            time: 0.0,
            all_dead: false,
            enrage_begin: 0.0,
            temp_dungeon_count: 0.0,
            rng: Rng::new(seed),
            res,
            ability_cache: HashMap::default(),
            blaze_def: None,
            bloom_def: None,
            monster_cache: HashMap::default(),
            u_fury_acc,
            u_fury_dmg,
            u_curse,
            u_weaken,
            u_enrage_dmg,
            u_enrage_acc,
            s_regen: special[0],
            s_lifesteal: special[1],
            s_mana_leech: special[2],
            s_ripple: special[3],
            s_auto: special[4],
            s_parry: special[5],
            s_dot: special[6],
            s_retaliation: special[7],
            s_physical_thorns: special[8],
            s_elemental_thorns: special[9],
            events_processed: 0,
        };
        let mut ids = Vec::new();
        for p in players_v {
            let u = sim.build_player(p)?;
            sim.units.push(u);
            ids.push(sim.units.len() - 1);
        }
        sim.players = Rc::from(ids);
        Ok(sim)
    }

    fn build_player(&mut self, p: &Value) -> Result<Unit, SimErr> {
        let mut equip = Vec::new();
        if let Some(Value::Object(m)) = p.get("equipStats") {
            for (k, v) in m {
                let i = stat_index(k).ok_or_else(|| format!("unknown stat {}", k))?;
                equip.push((i, to_num(v)));
            }
        }
        let style_hrid = string(p, "combatStyleHrid");
        let xp_weights = xp_weights(
            &string(p, "primaryTraining"),
            &string(p, "focusTraining"),
            self.gd.skill_exp_maps.get(&style_hrid).cloned().flatten().unwrap_or_default(),
        );
        let ps = PlayerStatic {
            xp_weights,
            equip,
            style: Style::parse(&style_hrid),
            style_hrid,
            dtype: DType::parse(&string(p, "damageType")),
            attack_interval: num(p, "attackInterval"),
            primary_training: string(p, "primaryTraining"),
            focus_training: string(p, "focusTraining"),
            food_slots: num(p, "foodSlots"),
            drink_slots: num(p, "drinkSlots"),
            bulwark: matches!(p.get("bulwark"), Some(Value::Bool(true))),
        };
        let mut u = Unit::new_player(&string(p, "hrid"), ps);
        u.hid = self.it.id(&string(p, "hrid"));
        if let Some(Value::Array(lv)) = p.get("levels") {
            for (i, x) in lv.iter().enumerate().take(7) {
                u.base_level[i] = to_num(x);
            }
        }
        u.debuff_on_level_gap = match p.get("debuffOnLevelGap") {
            None => f64::NAN,
            Some(x) => to_num(x),
        };
        u.task_damage_enabled = matches!(p.get("taskDamageEnabled"), Some(Value::Bool(true)));
        if let Some(Value::Array(list)) = p.get("abilities") {
            for a in list {
                if a.is_null() {
                    u.abilities.push(None);
                    continue;
                }
                let hrid = string(a, "hrid");
                let level = num(a, "level");
                let def = self.ability_def(&hrid, level)?;
                let triggers: Vec<Trigger> = match a.get("triggers") {
                    Some(Value::Array(ts)) => ts
                        .iter()
                        .map(|t| Trigger::from_def(t, self.gd, &mut self.it))
                        .collect(),
                    _ => return Err("ability without triggers array".into()),
                };
                u.abilities.push(Some(Ability {
                    def,
                    triggers: Rc::new(triggers),
                    last_used: MIN_SAFE_INTEGER,
                }));
            }
        }
        for (key, drink) in [("food", false), ("drinks", true)] {
            if let Some(Value::Array(list)) = p.get(key) {
                for c in list {
                    let slot = if c.is_null() {
                        None
                    } else {
                        Some(self.build_consumable(c)?)
                    };
                    if drink {
                        u.drinks.push(slot);
                    } else {
                        u.food.push(slot);
                    }
                }
            }
        }
        if let Some(Value::Array(list)) = p.get("permanentBuffs") {
            for b in list {
                let pb = PermBuff {
                    unique: self.it.id(&string(b, "uniqueHrid")),
                    typ: self.it.id(&string(b, "typeHrid")),
                    flat: num(b, "flatBoost"),
                    ratio: num(b, "ratioBoost"),
                    duration: num(b, "duration"),
                };
                // exported after generatePermanentBuffs(), already merged by type
                u.permanent.insert(pb.typ, pb);
            }
        }
        Ok(u)
    }

    fn build_consumable(&mut self, c: &Value) -> Result<Consumable, SimErr> {
        let cat = string(c, "categoryHrid");
        let buffs = match c.get("buffs") {
            Some(Value::Array(bs)) => bs
                .iter()
                .map(|b| BuffTemplate::from_def(b, 1.0, &mut self.it))
                .collect(),
            _ => Vec::new(),
        };
        let triggers = match c.get("triggers") {
            Some(Value::Array(ts)) => ts
                .iter()
                .map(|t| Trigger::from_def(t, self.gd, &mut self.it))
                .collect(),
            _ => return Err("consumable without triggers array".into()),
        };
        Ok(Consumable {
            hid: self.it.id(&string(c, "hrid")),
            hrid: Rc::from(string(c, "hrid").as_str()),
            cooldown: num(c, "cooldownDuration"),
            hp_restore: num(c, "hitpointRestore"),
            mp_restore: num(c, "manapointRestore"),
            recovery: num(c, "recoveryDuration"),
            is_food: cat.contains("food"),
            is_drink: cat.contains("drink"),
            buffs,
            triggers,
            last_used: MIN_SAFE_INTEGER,
        })
    }

    fn cached_ability(&mut self, hrid: &str, level: f64) -> Result<&(Rc<AbilityDef>, Rc<Vec<Trigger>>), SimErr> {
        let bits = level.to_bits();
        let have = self
            .ability_cache
            .get(hrid)
            .map(|m| m.contains_key(&bits))
            .unwrap_or(false);
        if !have {
            let d = Rc::new(AbilityDef::build(hrid, level, self.gd, &mut self.it)?);
            let t = Rc::new(d.default_triggers.clone());
            self.ability_cache
                .entry(hrid.to_string())
                .or_default()
                .insert(bits, (d, t));
        }
        Ok(&self.ability_cache[hrid][&bits])
    }

    fn ability_def(&mut self, hrid: &str, level: f64) -> Result<Rc<AbilityDef>, SimErr> {
        Ok(self.cached_ability(hrid, level)?.0.clone())
    }

    /// `new se(hrid, level)` with the data's default triggers.
    fn default_ability(&mut self, hrid: &str, level: f64) -> Result<Ability, SimErr> {
        let (def, triggers) = self.cached_ability(hrid, level)?.clone();
        Ok(Ability {
            def,
            triggers,
            last_used: MIN_SAFE_INTEGER,
        })
    }

    /// `new me(hrid, tier, roomLevel)`
    fn spawn_monster(&mut self, hrid: &str, tier: f64, room_level: f64) -> Result<UnitId, SimErr> {
        let _prof = crate::prof::start("spawn_monster");
        let tpl = match self.monster_cache.get(hrid) {
            Some(t) => t.clone(),
            None => {
                let mut t = MonsterTemplate::build(hrid, self.gd)?;
                t.hid = self.it.id(hrid);
                let t = Rc::new(t);
                self.monster_cache.insert(hrid.to_string(), t.clone());
                t
            }
        };
        let mut u = Unit::new_monster(tpl.clone(), tier, room_level);
        let o = if room_level <= 0.0 { 100.0 } else { room_level } / 100.0;
        for (s, (ah, lvl, min_tier)) in tpl.abilities.iter().enumerate() {
            if *min_tier > tier {
                continue;
            }
            let ab = self.default_ability(ah, (lvl * o).floor())?;
            while u.abilities.len() <= s {
                u.abilities.push(None);
            }
            u.abilities[s] = Some(ab);
        }
        self.units.push(u);
        Ok(self.units.len() - 1)
    }

    // ------------------------------------------------------------------ main loop

    pub fn result_json(&self) -> Value {
        self.res.to_json(&self.it)
    }

    pub fn simulate(&mut self, limit: f64) -> Result<(), SimErr> {
        self.q.clear();
        self.time = 0.0;
        self.temp_dungeon_count = 0.0;
        self.q.add(0.0, Ev::CombatStart);
        let mut same_time = 0u64;
        while self.time < limit {
            let e = self.q.pop().ok_or("event queue empty")?;
            if e.time == self.time {
                same_time += 1;
                // e.g. a weapon with attackInterval 0: the original engine loops forever here
                if same_time > 2_000_000 {
                    return Err("simulation stalled (time does not advance)".into());
                }
            } else {
                same_time = 0;
            }
            self.time = e.time;
            self.process(e.ev)?;
            if let Some(err) = self.res.error.take() {
                return Err(err);
            }
            self.events_processed += 1;
        }
        self.finish();
        Ok(())
    }

    fn finish(&mut self) {
        let is_dungeon = self.zone.as_ref().map(|z| z.is_dungeon).unwrap_or(false);
        self.res.is_dungeon = is_dungeon;
        if is_dungeon {
            let z = self.zone.as_ref().unwrap();
            self.res.dungeons_completed = z.dungeons_completed;
            self.res.dungeons_failed = z.dungeons_failed;
            self.res.dungeon_attempts_started = z.dungeon_attempts_started;
            let max_waves = z.dungeon.as_ref().map(|d| d.max_waves).unwrap_or(0.0);
            if self.res.dungeons_completed < 1.0 {
                self.res.max_wave_reached = 0.0;
                let mut w = 1.0;
                while w <= max_waves {
                    let name = format!("#{}", js::num_key(w));
                    match self.res.time_spent_alive.iter().find(|t| t.name == name) {
                        Some(t) if t.count != 0.0 => self.res.max_wave_reached = w,
                        _ => break,
                    }
                    w += 1.0;
                }
            } else {
                self.res.max_wave_reached = max_waves;
            }
        }
        self.res.simulated_time = self.time;
        for &p in self.players.iter() {
            let u = &self.units[p];
            let h = u.hid;
            self.res.drop_rate_multiplier.insert(h.clone(), 1.0 + u.s[COMBAT_DROP_RATE]);
            self.res.rare_find_multiplier.insert(h.clone(), 1.0 + u.s[COMBAT_RARE_FIND]);
            self.res.combat_drop_quantity.insert(h.clone(), u.s[COMBAT_DROP_QUANTITY]);
            self.res.debuff_on_level_gap.insert(h.clone(), u.debuff_on_level_gap);
            self.res.mana_used.insert(h, u.mana_costs.clone());
        }
        if is_dungeon {
            let z = self.zone.as_ref().unwrap();
            if let Some(d) = &z.dungeon {
                for (k, list) in &d.fixed {
                    let mut p = format!("#{}", k);
                    for (h, _) in list {
                        p.push(',');
                        p.push_str(h);
                    }
                    self.res.boss_spawns.push(p);
                }
            }
            if let Some(b) = &z.boss {
                for (h, _) in b {
                    self.res.boss_spawns.push(h.clone());
                }
            }
        }
    }

    fn process(&mut self, ev: Ev) -> Result<(), SimErr> {
        let _prof = crate::prof::start("process(all)");
        match ev {
            Ev::CombatStart => self.on_combat_start()?,
            Ev::PlayerRespawn { hrid } => self.on_player_respawn(hrid)?,
            Ev::EnemyRespawn => self.start_new_encounter()?,
            Ev::AutoAttack { source } => self.on_auto_attack(source)?,
            Ev::ConsumableTick {
                source,
                drink,
                slot,
                total,
                current,
            } => self.on_consumable_tick(source, drink, slot, total, current),
            Ev::Dot {
                source_ref,
                target,
                damage,
                total,
                current,
            } => self.on_dot(source_ref, target, damage, total, current)?,
            Ev::CheckBuffExpiration { source } => self.units[source].remove_expired(self.time),
            Ev::RegenTick => self.on_regen(),
            Ev::StunExp { source } => {
                self.units[source].stunned = false;
                self.add_next_attack(source)?;
            }
            Ev::BlindExp { source } => {
                self.units[source].blinded = false;
                self.add_next_attack(source)?;
            }
            Ev::SilenceExp { source } => self.units[source].silenced = false,
            Ev::CurseExp { source, .. } | Ev::WeakenExp { source, .. } | Ev::FuryExp { source, .. } => {
                self.units[source].remove_expired(self.time)
            }
            Ev::EnrageTick { encounter_time } => self.on_enrage(encounter_time),
            Ev::CastEnd { source, slot } => {
                self.try_use_ability(source, slot)?;
            }
            Ev::AwaitCooldown { source } => self.add_next_attack(source)?,
            Ev::CooldownReady => {}
        }
        self.check_triggers()
    }

    // ------------------------------------------------------------------ encounters

    fn on_combat_start(&mut self) -> Result<(), SimErr> {
        // permanent buffs were generated by the compile step (generatePermanentBuffs at t=0)
        let t = if self.lab.is_some() { 0.0 } else { self.time };
        for i in 0..self.players.len() {
            let p = self.players[i];
            let rng = &mut self.rng;
            self.units[p].reset(t, rng);
        }
        self.q.add(self.time + REGEN_TICK, Ev::RegenTick);
        self.start_new_encounter()
    }

    fn on_player_respawn(&mut self, hrid: u32) -> Result<(), SimErr> {
        let p = *self
            .players
            .iter()
            .find(|&&p| self.units[p].hid == hrid)
            .ok_or("respawn of unknown player")?;
        {
            let u = &mut self.units[p];
            u.d.hp = u.d.max_hp;
            u.d.mp = u.d.max_mp;
            u.clear_buffs();
            u.clear_ccs();
        }
        if self.all_dead {
            self.all_dead = false;
            self.start_attacks()
        } else {
            self.add_next_attack(p)
        }
    }

    fn start_new_encounter(&mut self) -> Result<(), SimErr> {
        let _prof = crate::prof::start("start_new_encounter");
        if self.all_dead {
            self.all_dead = false;
            if let Some(z) = &mut self.zone {
                if !z.is_dungeon || z.encounters_killed != 1.0 {
                    z.fail_wave();
                }
            }
        }
        if self.zone.is_some() {
            let is_dungeon = self.zone.as_ref().unwrap().is_dungeon;
            if !is_dungeon {
                let e = self.random_encounter()?;
                self.enemies = Some(Rc::from(e));
            } else {
                let e = self.next_wave()?;
                self.enemies = Some(Rc::from(e));
                let k = self.zone.as_ref().unwrap().encounters_killed;
                self.res
                    .update_time_spent_alive(&format!("#{}", js::num_key(k - 1.0)), true, self.time);
                let t = self.zone.as_ref().unwrap().dungeons_completed;
                if t > self.temp_dungeon_count {
                    self.temp_dungeon_count = t;
                    for &p in self.players.iter() {
                        let u = &mut self.units[p];
                        u.d.hp = u.d.max_hp;
                        u.d.mp = u.d.max_mp;
                    }
                }
            }
        }
        if self.lab.is_some() {
            let (h, rl) = {
                let l = self.lab.as_ref().unwrap();
                (l.monster_hrid.clone(), l.room_level)
            };
            let m = self.spawn_monster(&h, 0.0, rl)?;
            self.enemies = Some(Rc::from(vec![m]));
            self.lab.as_mut().unwrap().encounter_start = self.time;
        }
        let enemies = self.enemies.clone().ok_or("no enemies for encounter")?;
        for &e in enemies.iter() {
            let rng = &mut self.rng;
            self.units[e].reset(self.time, rng);
            let h = self.units[e].hid;
            self.res.update_time_spent_alive(self.it.name(h), true, self.time);
        }
        self.q.clear_type(EvType::EnrageTick);
        self.q.add(
            self.time + ENRAGE_TICK,
            Ev::EnrageTick {
                encounter_time: ENRAGE_TICK,
            },
        );
        self.enrage_begin = self.time;
        self.q.clear_type(EvType::CastEnd);
        self.check_triggers()?;
        self.start_attacks()
    }

    fn build_encounter(&mut self, which: Option<f64>) -> Result<Vec<UnitId>, SimErr> {
        // which: None => zone.random, Some(k) => dungeon random map entry k
        let mut picked: Vec<(String, f64)> = Vec::new();
        {
            let z = self.zone.as_ref().unwrap();
            let info = match which {
                None => z.random.as_ref().ok_or("zone without randomSpawnInfo")?,
                Some(k) => {
                    &z.dungeon
                        .as_ref()
                        .unwrap()
                        .random
                        .iter()
                        .find(|e| e.0 == k)
                        .ok_or("missing random spawn info")?
                        .1
                }
            };
            let mut total = 0.0;
            for s in &info.spawns {
                total += s.rate;
            }
            let mut strength = 0.0;
            let mut n = 0.0;
            'outer: while n < info.max_spawn_count {
                let o = total * self.rng.next();
                let mut acc = 0.0;
                for l in &info.spawns {
                    acc += l.rate;
                    if o <= acc {
                        strength += l.strength;
                        if strength <= info.max_total_strength {
                            picked.push((l.hrid.clone(), l.tier));
                        } else {
                            break 'outer;
                        }
                        break;
                    }
                }
                n += 1.0;
            }
        }
        let zt = self.zone.as_ref().unwrap().tier;
        let mut out = Vec::new();
        for (h, t) in picked {
            out.push(self.spawn_monster(&h, t + zt, 0.0)?);
        }
        Ok(out)
    }

    fn random_encounter(&mut self) -> Result<Vec<UnitId>, SimErr> {
        let z = self.zone.as_mut().unwrap();
        if z.boss.is_some() && z.encounters_killed == 10.0 {
            z.encounters_killed = 1.0;
            let list = z.boss.clone().unwrap();
            let zt = z.tier;
            let mut out = Vec::new();
            for (h, t) in list {
                out.push(self.spawn_monster(&h, t + zt, 0.0)?);
            }
            Ok(out)
        } else {
            z.encounters_killed += 1.0;
            self.build_encounter(None)
        }
    }

    fn next_wave(&mut self) -> Result<Vec<UnitId>, SimErr> {
        let z = self.zone.as_mut().unwrap();
        let d = z.dungeon.as_ref().ok_or("dungeon zone without dungeonInfo")?;
        if z.encounters_killed > d.max_waves {
            z.complete_dungeon();
        }
        if z.encounters_killed == 1.0 {
            z.dungeon_attempts_started += 1.0;
        }
        let d = z.dungeon.as_ref().unwrap();
        let key = js::num_key(z.encounters_killed);
        if let Some((_, list)) = d.fixed.iter().find(|(k, _)| *k == key) {
            let list = list.clone();
            z.encounters_killed += 1.0;
            let zt = z.tier;
            let mut out = Vec::new();
            for (h, t) in list {
                out.push(self.spawn_monster(&h, t + zt, 0.0)?);
            }
            return Ok(out);
        }
        let keys: Vec<f64> = d.random.iter().map(|e| e.0).collect();
        let k = z.encounters_killed;
        let mut chosen = None;
        if k > *keys.last().ok_or("empty randomSpawnInfoMap")? {
            chosen = Some(*keys.last().unwrap());
        } else {
            for o in 0..keys.len().saturating_sub(1) {
                if k >= keys[o] && k <= keys[o + 1] {
                    chosen = Some(keys[o]);
                    break;
                }
            }
        }
        let chosen = chosen.ok_or("no random spawn info for wave")?;
        let out = self.build_encounter(Some(chosen))?;
        self.zone.as_mut().unwrap().encounters_killed += 1.0;
        Ok(out)
    }

    fn start_attacks(&mut self) -> Result<(), SimErr> {
        let mut all: Units = self.players.iter().copied().collect();
        if let Some(e) = &self.enemies {
            all.extend(e.iter().copied());
        }
        for t in all {
            if self.units[t].d.hp <= 0.0 {
                continue;
            }
            self.add_next_attack(t)?;
        }
        Ok(())
    }

    fn get_target(&self, list: Option<&[UnitId]>) -> Option<UnitId> {
        list?.iter().copied().find(|&u| self.units[u].d.hp > 0.0)
    }

    fn check_parry(&mut self, list: &[UnitId]) -> Option<UnitId> {
        let t: Units = list
            .iter()
            .copied()
            .filter(|&a| self.units[a].d.hp > 0.0 && self.units[a].s[PARRY] > 0.0)
            .collect();
        if t.is_empty() {
            return None;
        }
        let i = (self.rng.next() * t.len() as f64).floor() as usize;
        if self.units[t[i]].s[PARRY] > self.rng.next() {
            Some(t[i])
        } else {
            None
        }
    }

    fn pick_by_threat(&mut self, list: &[UnitId]) -> Result<UnitId, SimErr> {
        let mut p = 0.0;
        let mut ranges: SmallVec<[(UnitId, f64, f64); 8]> = SmallVec::new();
        for &f in list {
            let k = self.units[f].s[THREAT];
            p += k;
            ranges.push((f, p - k, p));
        }
        let h = self.rng.next() * p;
        ranges
            .iter()
            .find(|r| h >= r.1 && h < r.2)
            .map(|r| r.0)
            .ok_or_else(|| "threat roll out of range".to_string())
    }

    fn opponents(&self, u: UnitId) -> Option<Rc<[UnitId]>> {
        if self.units[u].is_player {
            self.enemies.clone()
        } else {
            Some(self.players.clone())
        }
    }

    fn allies(&self, u: UnitId) -> Option<Rc<[UnitId]>> {
        if self.units[u].is_player {
            Some(self.players.clone())
        } else {
            self.enemies.clone()
        }
    }

    fn kill(&mut self, u: UnitId) {
        let _prof = crate::prof::start("kill");
        self.q.clear_for_unit(u);
        let h = self.units[u].hid;
        self.res.add_death(h);
        if !self.units[u].is_player {
            self.res.update_time_spent_alive(self.it.name(h), false, self.time);
        }
    }

    fn thorn_name(&self, physical: bool) -> u32 {
        if physical {
            self.s_physical_thorns
        } else {
            self.s_elemental_thorns
        }
    }

    fn on_auto_attack(&mut self, source: UnitId) -> Result<(), SimErr> {
        let _prof = crate::prof::start("on_auto_attack");
        let t = match self.opponents(source) {
            Some(t) => t,
            None => return Ok(()),
        };
        let i: Units = t
            .iter()
            .copied()
            .filter(|&s| self.units[s].d.hp > 0.0)
            .collect();
        let src_is_player = self.units[source].is_player;
        for s in 0..i.len() {
            let mut l = i[s];
            if !src_is_player && i.len() > 1 {
                l = self.pick_by_threat(&i)?;
            }
            let mut c = source;
            let u = self.check_parry(&t);
            if let Some(pu) = u {
                l = c;
                c = pu;
            }
            let r = self.process_attack(c, l, None)?;
            let g = self.units[c].s[MAYHEM] > self.rng.next();
            if r.did_hit && self.units[c].s[CURSE] > 0.0 {
                let amt = self.units[c].s[CURSE];
                self.apply_capped_debuff(l, amt, true);
            }
            if self.units[c].s[FURY] > 0.0 {
                self.fury(c, r.did_hit, true);
            }
            if self.units[l].s[WEAKEN] > 0.0 {
                let amt = self.units[l].s[WEAKEN];
                self.apply_capped_debuff(c, amt, false);
            }
            if !g || (g && r.did_hit) || (g && s == i.len() - 1) {
                let name = if u.is_some() {
                    self.s_parry
                } else {
                    self.s_auto
                };
                let (ch, lh) = (self.units[c].hid, self.units[l].hid);
                self.res
                    .add_attack(ch, lh, name, if r.did_hit { Some(r.damage_done) } else { None });
            }
            let (ch, lh) = (self.units[c].hid, self.units[l].hid);
            if r.life_steal_heal > 0.0 {
                self.res.add_hp_gained(ch, self.s_lifesteal, r.life_steal_heal);
            }
            if r.mana_leech > 0.0 {
                self.res.add_mp_gained(ch, self.s_mana_leech, r.mana_leech);
            }
            if r.thorn_damage > 0.0 {
                let tn = self.thorn_name(r.thorn_physical);
                self.res.add_attack(lh, ch, tn, Some(r.thorn_damage));
            }
            if self.units[l].s[RETALIATION] > 0.0 {
                let rn = self.s_retaliation;
                self.res.add_attack(
                    lh,
                    ch,
                    rn,
                    if r.retaliation_damage > 0.0 { Some(r.retaliation_damage) } else { None },
                );
            }
            if self.units[l].d.hp == 0.0 {
                self.kill(l);
            }
            if self.units[c].d.hp == 0.0 && (r.thorn_damage != 0.0 || r.retaliation_damage != 0.0) {
                self.kill(c);
                break;
            }
            if !(g && !r.did_hit)
                && (!r.did_hit || u.is_some() || self.units[c].s[PIERCE] <= self.rng.next())
            {
                break;
            }
        }
        if !self.check_encounter_end()? {
            self.add_next_attack(source)?;
        }
        Ok(())
    }

    fn process_attack(
        &mut self,
        src: UnitId,
        tgt: UnitId,
        eff: Option<&Effect>,
    ) -> Result<AttackOut, SimErr> {
        let _prof = crate::prof::start("process_attack");
        let (e, t) = two(&mut self.units, src, tgt);
        let rng = &mut self.rng;
        let style = eff.map(|x| x.style).unwrap_or(e.style);
        let dtype = eff.map(|x| x.dtype).unwrap_or(e.dtype);
        let (mut o, s, l) = match style {
            Style::Stab => (e.d.acc[IDX_STAB], e.d.max_dmg[IDX_STAB], t.d.eva[IDX_STAB]),
            Style::Slash => (e.d.acc[IDX_SLASH], e.d.max_dmg[IDX_SLASH], t.d.eva[IDX_SLASH]),
            Style::Smash => (e.d.acc[IDX_SMASH], e.d.max_dmg[IDX_SMASH], t.d.eva[IDX_SMASH]),
            Style::Ranged => (e.d.acc[IDX_RANGED], e.d.max_dmg[IDX_RANGED], t.d.eva[IDX_RANGED]),
            Style::Magic => (e.d.acc[IDX_MAGIC], e.d.max_dmg[IDX_MAGIC], t.d.eva[IDX_MAGIC]),
            Style::Other => return Err("Unknown combat style".into()),
        };
        let (c, u, pen, g, p, h, thorn_physical) = match dtype {
            DType::Physical => (
                1.0 + e.s[PHYSICAL_AMPLIFY],
                e.d.total_armor,
                e.s[ARMOR_PENETRATION],
                t.d.total_armor,
                t.s[PHYSICAL_THORNS],
                t.s[ARMOR_PENETRATION],
                true,
            ),
            DType::Water => (
                1.0 + e.s[WATER_AMPLIFY],
                e.d.total_water_res,
                e.s[WATER_PENETRATION],
                t.d.total_water_res,
                t.s[ELEMENTAL_THORNS],
                t.s[WATER_PENETRATION],
                false,
            ),
            DType::Nature => (
                1.0 + e.s[NATURE_AMPLIFY],
                e.d.total_nature_res,
                e.s[NATURE_PENETRATION],
                t.d.total_nature_res,
                t.s[ELEMENTAL_THORNS],
                t.s[NATURE_PENETRATION],
                false,
            ),
            DType::Fire => (
                1.0 + e.s[FIRE_AMPLIFY],
                e.d.total_fire_res,
                e.s[FIRE_PENETRATION],
                t.d.total_fire_res,
                t.s[ELEMENTAL_THORNS],
                t.s[FIRE_PENETRATION],
                false,
            ),
            DType::Other => return Err("Unknown damage type".into()),
        };
        let r_crit = e.s[CRITICAL_RATE];
        let pe = e.s[CRITICAL_DAMAGE];
        if let Some(i) = eff {
            o *= 1.0 + i.bonus_accuracy_ratio;
        }
        let po = js::pow(o, 1.4);
        let f = po / (po + js::pow(l, 1.4));
        let mut k = 0.0;
        if style == Style::Ranged {
            k = 0.3 * f;
        }
        k = k + r_crit;
        let n_flat = eff.map(|i| i.damage_flat).unwrap_or(0.0);
        let j_ratio = eff.map(|i| i.damage_ratio).unwrap_or(1.0);
        let j = eff.map(|i| i.armor_damage_ratio * e.d.total_armor).unwrap_or(0.0);
        let mut lo = c * (1.0 + n_flat + j);
        let mut hi = c * (j_ratio * s + n_flat + j);
        if rng.next() < k {
            hi = hi * (1.0 + pe);
            lo = hi;
        }
        let mut q = random_int(rng, lo, hi);
        q *= 1.0 + if e.task_damage_enabled { e.s[TASK_DAMAGE] } else { 0.0 };
        q *= 1.0 + t.s[DAMAGE_TAKEN];
        if eff.is_some() {
            q *= 1.0 + e.s[ABILITY_DAMAGE];
        } else {
            q += q * e.s[AUTO_ATTACK_DAMAGE];
        }
        let mut dmg = 0.0;
        let mut thorn = 0.0;
        let mut hit = false;
        if rng.next() < f {
            hit = true;
            let mut tt = g;
            if pen > 0.0 && g > 0.0 {
                tt = g / (1.0 + pen);
            }
            let mut w = 100.0 / (100.0 + tt);
            if tt < 0.0 {
                w = (100.0 - tt) / 100.0;
            }
            let de = (w * q).ceil();
            dmg = js::min(de, t.d.hp);
            t.d.hp -= dmg;
        }
        if p > 0.0 && g > -99.0 {
            let mut tt = u;
            if u > 0.0 {
                tt = u / (1.0 + h);
            }
            let mut w = 100.0 / (100.0 + tt);
            if tt < 0.0 {
                w = (100.0 - tt) / 100.0;
            }
            let de = 1.0 + if t.task_damage_enabled { t.s[TASK_DAMAGE] } else { 0.0 };
            let ttk = 1.0 + e.s[DAMAGE_TAKEN];
            let it = de * ttk;
            let fe = random_int(rng, 1.0, it * t.d.defensive_max_damage * (1.0 + g / 100.0) * p);
            let ge = (w * fe).ceil();
            thorn = js::min(ge, e.d.hp);
            e.d.hp -= thorn;
        }
        let mut ret = 0.0;
        if t.s[RETALIATION] > 0.0 {
            let pa = js::pow(t.d.acc[IDX_SMASH], 1.4);
            let ratio = pa / (pa + js::pow(e.d.eva[IDX_SMASH], 1.4));
            if ratio > rng.next() {
                let mut w = e.d.total_armor;
                if w > 0.0 {
                    w = w / (1.0 + t.s[ARMOR_PENETRATION]);
                }
                let mut ee = 100.0 / (100.0 + w);
                if w < 0.0 {
                    ee = (100.0 - w) / 100.0;
                }
                let tt = 1.0 + if t.task_damage_enabled { t.s[TASK_DAMAGE] } else { 0.0 };
                let it = 1.0 + e.s[DAMAGE_TAKEN];
                let fe = tt * it;
                let mut ge = q;
                ge = js::min(ge, t.d.defensive_max_damage * 5.0);
                let ni = fe * t.s[RETALIATION] * ge;
                let ji = fe * t.s[RETALIATION] * (t.d.defensive_max_damage + ge);
                let ui = random_int(rng, ni, ji);
                let vi = (ee * ui).ceil();
                ret = js::min(vi, e.d.hp);
                e.d.hp -= ret;
            }
        }
        let mut ls = 0.0;
        if eff.is_none() && hit && e.s[LIFE_STEAL] > 0.0 {
            ls = e.add_hp((e.s[LIFE_STEAL] * dmg).floor());
        }
        let mut drain = 0.0;
        if let Some(i) = eff {
            if hit && i.hp_drain_ratio > 0.0 {
                let tt = 1.0 + e.s[HEALING_AMPLIFY];
                drain = e.add_hp((i.hp_drain_ratio * dmg * tt).floor());
            }
        }
        let mut ml = 0.0;
        if eff.is_none() && hit && e.s[MANA_LEECH] > 0.0 {
            ml = e.add_mp((e.s[MANA_LEECH] * dmg).floor());
        }
        Ok(AttackOut {
            damage_done: dmg,
            did_hit: hit,
            thorn_damage: thorn,
            thorn_physical,
            retaliation_damage: ret,
            life_steal_heal: ls,
            hp_drain: drain,
            mana_leech: ml,
        })
    }

    fn check_encounter_end(&mut self) -> Result<bool, SimErr> {
        let _prof = crate::prof::start("check_encounter_end");
        if let Some(en) = self.enemies.clone() {
            for &s in en.iter() {
                let u = &mut self.units[s];
                if u.d.hp <= 0.0 && u.experience_rate == 0.0 {
                    let mut l = self.time - self.enrage_begin;
                    if l > u.enrage_time {
                        l = u.enrage_time;
                    }
                    u.experience_rate = 1.0 + l / u.enrage_time;
                }
            }
        }
        let mut e = false;
        let t = !self.players.iter().any(|&o| self.units[o].d.hp > 0.0);
        let is_dungeon = self.zone.as_ref().map(|z| z.is_dungeon).unwrap_or(false);
        let i = is_dungeon && t;
        if let Some(en) = self.enemies.clone() {
            if !en.iter().any(|&o| self.units[o].d.hp > 0.0) {
                self.q.clear_type(EvType::AutoAttack);
                if !i {
                    self.q.add(self.time + ENEMY_RESPAWN, Ev::EnemyRespawn);
                }
                let mut o = 0.0;
                for &s in en.iter() {
                    o += self.units[s].experience * self.units[s].experience_rate;
                }
                let np = self.players.len() as f64;
                for pi in 0..self.players.len() {
                    let p = self.players[pi];
                    self.add_experience(p, o / np);
                }
                if !i {
                    self.enemies = None;
                }
                if is_dungeon {
                    let k = self.zone.as_ref().unwrap().encounters_killed;
                    self.res
                        .update_time_spent_alive(&format!("#{}", js::num_key(k - 1.0)), false, self.time);
                    let max_waves = self
                        .zone
                        .as_ref()
                        .unwrap()
                        .dungeon
                        .as_ref()
                        .map(|d| d.max_waves)
                        .unwrap_or(f64::NAN);
                    if !i && k > max_waves {
                        self.res.update_dungeon_finish("#1", self.time);
                        self.res.last_dungeon_finish_time = self.time;
                        self.zone.as_mut().unwrap().complete_dungeon();
                    }
                }
                self.res.encounters += 1.0;
                self.res.last_encounter_finish_time = self.time;
                e = true;
            }
        }
        for pi in 0..self.players.len() {
            let o = self.players[pi];
            if self.units[o].d.hp <= 0.0 {
                let h = self.units[o].hid;
                let has = self
                    .q
                    .any(|ev| matches!(ev, Ev::PlayerRespawn { hrid } if *hrid == h));
                if !has {
                    if let Some(z) = &self.zone {
                        if !z.is_dungeon {
                            self.q.add(
                                self.time + PLAYER_RESPAWN,
                                Ev::PlayerRespawn { hrid: h },
                            );
                        }
                    }
                    self.res.add_ran_out_of_mana(h, false, self.time);
                }
            }
        }
        if t {
            if self.zone.is_some() {
                if is_dungeon {
                    let k = self.zone.as_ref().unwrap().encounters_killed;
                    self.res.wipe_events.push((self.time, k - 1.0));
                    self.zone.as_mut().unwrap().fail_wave();
                    self.res.last_dungeon_finish_time = self.time;
                    for ty in [
                        EvType::AutoAttack,
                        EvType::CastEnd,
                        EvType::Dot,
                        EvType::ConsumableTick,
                        EvType::RegenTick,
                        EvType::EnrageTick,
                        EvType::StunExp,
                        EvType::BlindExp,
                        EvType::SilenceExp,
                        EvType::AwaitCooldown,
                    ] {
                        self.q.clear_type(ty);
                    }
                    self.enemies = None;
                    self.q.add(self.time + DUNGEON_RESTART, Ev::CombatStart);
                } else {
                    self.q.clear_type(EvType::AutoAttack);
                    self.q.clear_type(EvType::CastEnd);
                }
            }
            e = true;
            self.all_dead = true;
        }
        if let Some(lab) = &self.lab {
            if self.time - lab.encounter_start > 120.0 * 1e9 || e {
                self.enemies = None;
                e = true;
                self.q.clear();
                self.q.add(self.time, Ev::CombatStart);
            }
        }
        Ok(e)
    }

    fn add_experience(&mut self, p: UnitId, t: f64) {
        let u = &self.units[p];
        if !u.is_player {
            return;
        }
        let i = match &u.kind {
            Kind::Player(ps) => ps.xp_weights,
            _ => return,
        };
        let ce = u.s[COMBAT_EXPERIENCE];
        let dl = u.debuff_on_level_gap;
        let skill_xp = [
            u.s[STAMINA_EXPERIENCE],
            u.s[INTELLIGENCE_EXPERIENCE],
            u.s[ATTACK_EXPERIENCE],
            u.s[MELEE_EXPERIENCE],
            u.s[DEFENSE_EXPERIENCE],
            u.s[RANGED_EXPERIENCE],
            u.s[MAGIC_EXPERIENCE],
        ];
        let h = u.hid;
        let entry = self.res.experience_gained.entry(h).or_insert([0.0; 7]);
        for k in 0..7 {
            let c = i[k];
            if c <= 0.0 {
                continue;
            }
            let uu = c * (1.0 + skill_xp[k]);
            entry[k] += t * (1.0 + ce) * uu * (1.0 + dl);
        }
    }

    fn add_next_attack(&mut self, e: UnitId) -> Result<(), SimErr> {
        let _prof = crate::prof::start("add_next_attack");
        if self.q.any(|ev| match ev {
            Ev::CastEnd { source, .. } | Ev::AutoAttack { source } => *source == e,
            _ => false,
        }) {
            return Ok(());
        }
        let is_player = self.units[e].is_player;
        let (i, a): (Option<Rc<[UnitId]>>, Option<Rc<[UnitId]>>) = if is_player {
            (Some(self.players.clone()), self.enemies.clone())
        } else {
            (self.enemies.clone(), Some(self.players.clone()))
        };
        let t = self.get_target(a.as_deref());
        let mut n = false;
        let mut o = false;
        let nab = self.units[e].abilities.len();
        for slot in 0..nab {
            if self.units[e].abilities[slot].is_none() {
                continue;
            }
            if n || o {
                continue;
            }
            if !self.ability_should_trigger(e, slot, t, i.as_deref(), a.as_deref())? {
                continue;
            }
            let mana = self.units[e].abilities[slot].as_ref().unwrap().def.mana_cost;
            if !self.can_use_ability(e, mana, true) {
                o = true;
            }
            if !o {
                let u = &self.units[e];
                let mut l = u.abilities[slot].as_ref().unwrap().def.cast;
                l /= 1.0 + u.s[CAST_SPEED];
                self.q.add(self.time + l, Ev::CastEnd { source: e, slot });
                n = true;
            }
        }
        if n {
            self.units[e].out_of_mana = false;
            return Ok(());
        }
        if a.is_some() {
            if self.units[e].blinded {
                self.units[e].out_of_mana = true;
            } else {
                let ai = self.units[e].s[ATTACK_INTERVAL];
                self.q.add(self.time + ai, Ev::AutoAttack { source: e });
            }
        }
        Ok(())
    }

    fn on_consumable_tick(&mut self, source: UnitId, drink: bool, slot: usize, total: f64, current: f64) {
        let (hp_r, mp_r, hrid) = {
            let c = self.consumable(source, drink, slot);
            (c.hp_restore, c.mp_restore, c.hid)
        };
        let sh = self.units[source].hid;
        if hp_r > 0.0 {
            let t = calc_tick(hp_r, total, current);
            let i = self.units[source].add_hp(t);
            self.res.add_hp_gained(sh, hrid, i);
        }
        if mp_r > 0.0 {
            let t = calc_tick(mp_r, total, current);
            let i = self.units[source].add_mp(t);
            self.res.add_mp_gained(sh, hrid, i);
            if self.units[source].out_of_mana {
                self.q.add(self.time, Ev::AwaitCooldown { source });
            }
        }
        if current < total {
            self.q.add(
                self.time + CONSUMABLE_TICK,
                Ev::ConsumableTick {
                    source,
                    drink,
                    slot,
                    total,
                    current: current + 1.0,
                },
            );
        }
    }

    fn consumable(&self, u: UnitId, drink: bool, slot: usize) -> &Consumable {
        let list = if drink {
            &self.units[u].drinks
        } else {
            &self.units[u].food
        };
        list[slot].as_ref().unwrap()
    }

    fn consumable_mut(&mut self, u: UnitId, drink: bool, slot: usize) -> &mut Consumable {
        let list = if drink {
            &mut self.units[u].drinks
        } else {
            &mut self.units[u].food
        };
        list[slot].as_mut().unwrap()
    }

    fn on_dot(&mut self, source_ref: UnitId, target: UnitId, damage: f64, total: f64, current: f64) -> Result<(), SimErr> {
        let t = calc_tick(damage, total, current);
        let i = js::min(t, self.units[target].d.hp);
        self.units[target].d.hp -= i;
        let (sh, th) = (self.units[source_ref].hid, self.units[target].hid);
        let dn = self.s_dot;
        self.res.add_attack(sh, th, dn, Some(i));
        if current < total {
            self.q.add(
                self.time + DOT_TICK,
                Ev::Dot {
                    source_ref,
                    target,
                    damage,
                    total,
                    current: current + 1.0,
                },
            );
        }
        if self.units[target].d.hp == 0.0 {
            self.kill(target);
        }
        self.check_encounter_end()?;
        Ok(())
    }

    fn on_regen(&mut self) {
        for pi in 0..self.players.len() {
            let a = self.players[pi];
            if self.units[a].d.hp <= 0.0 {
                continue;
            }
            let h = self.units[a].hid;
            let n = (self.units[a].d.max_hp * self.units[a].s[HP_REGEN]).floor();
            let o = self.units[a].add_hp(n);
            let rn = self.s_regen;
            self.res.add_hp_gained(h, rn, o);
            let s = (self.units[a].d.max_mp * self.units[a].s[MP_REGEN]).floor();
            let l = self.units[a].add_mp(s);
            self.res.add_mp_gained(h, rn, l);
            if self.units[a].out_of_mana {
                self.q.add(self.time, Ev::AwaitCooldown { source: a });
            }
        }
        self.q.add(self.time + REGEN_TICK, Ev::RegenTick);
    }

    /// `applyCappedStackingDebuff` for curse (true) or weaken (false).
    fn apply_capped_debuff(&mut self, e: UnitId, t: f64, curse: bool) {
        let prev = self.q.find(|ev| match ev {
            Ev::CurseExp { source, .. } if curse => *source == e,
            Ev::WeakenExp { source, .. } if !curse => *source == e,
            _ => false,
        });
        let prev_amount = match prev {
            Some(Ev::CurseExp { amount, .. }) | Some(Ev::WeakenExp { amount, .. }) => *amount,
            _ => 0.0,
        };
        let u = js::or0(prev_amount);
        self.q.clear_matching(|ev| match ev {
            Ev::CurseExp { source, .. } if curse => *source == e,
            Ev::WeakenExp { source, .. } if !curse => *source == e,
            _ => false,
        });
        let n = js::max(0.0, js::or0(u));
        let o = js::max(0.0, js::or0(t));
        let amount = js::max(n, js::min(n + o, o * 5.0));
        let (unique, typ, ratio, flat) = if curse {
            (self.u_curse, bt::DAMAGE_TAKEN, 0.0, amount)
        } else {
            (self.u_weaken, bt::DAMAGE, -1.0 * amount, 0.0)
        };
        let h = BuffTemplate {
            unique,
            typ,
            ratio,
            flat,
            duration: 15e9,
            has_multiplier_skill: false,
            multiplier_skill: None,
            multiplier_per_level: 0.0,
        };
        self.units[e].replace_buff(&h, self.time);
        let ev = if curse {
            Ev::CurseExp { amount, source: e }
        } else {
            Ev::WeakenExp { amount, source: e }
        };
        self.q.add(self.time + 15e9, ev);
    }

    fn fury(&mut self, e: UnitId, did_hit: bool, batch: bool) {
        let prev = self.q.find(|ev| matches!(ev, Ev::FuryExp { source, .. } if *source == e));
        let mut f = match prev {
            Some(Ev::FuryExp { amount, .. }) => *amount,
            _ => 0.0,
        };
        self.q
            .clear_matching(|ev| matches!(ev, Ev::FuryExp { source, .. } if *source == e));
        if did_hit {
            f = js::min(f + 1.0, 5.0);
        } else {
            f = f / 2.0;
        }
        let rb = f * self.units[e].s[FURY];
        let k = BuffTemplate {
            unique: self.u_fury_acc,
            typ: bt::FURY_ACCURACY,
            ratio: rb,
            flat: 0.0,
            duration: 15e9,
            has_multiplier_skill: false,
            multiplier_skill: None,
            multiplier_per_level: 0.0,
        };
        let mut ed = k.clone();
        ed.unique = self.u_fury_dmg;
        ed.typ = bt::FURY_DAMAGE;
        if f > 0.0 {
            self.q.add(self.time + 15e9, Ev::FuryExp { amount: f, source: e });
            if batch {
                self.units[e].add_buffs(&[k, ed], self.time);
            } else {
                self.units[e].add_buff(&k, self.time);
                self.units[e].add_buff(&ed, self.time);
            }
        } else if batch {
            self.units[e].remove_buffs(&[k.unique, ed.unique]);
        } else {
            self.units[e].remove_buffs(&[k.unique]);
            self.units[e].remove_buffs(&[ed.unique]);
        }
    }

    fn on_enrage(&mut self, encounter_time: f64) {
        let en = match self.enemies.clone() {
            Some(e) => e,
            None => return,
        };
        let alive: Units = en.iter().copied().filter(|&a| self.units[a].d.hp > 0.0).collect();
        for a in alive {
            let n = js::min(10.0, (encounter_time / self.units[a].enrage_time).floor());
            if n <= 0.0 {
                continue;
            }
            let o = BuffTemplate {
                unique: self.u_enrage_dmg,
                typ: bt::DAMAGE,
                ratio: n * 0.1,
                flat: 0.0,
                duration: ENRAGE_TICK,
                has_multiplier_skill: false,
                multiplier_skill: None,
                multiplier_per_level: 0.0,
            };
            let mut s = o.clone();
            s.unique = self.u_enrage_acc;
            s.typ = bt::ACCURACY;
            self.units[a].add_buffs(&[o, s], self.time);
            self.res.max_enrage_stack = js::max(self.res.max_enrage_stack, n);
        }
        self.q.add(
            self.time + ENRAGE_TICK,
            Ev::EnrageTick {
                encounter_time: encounter_time + ENRAGE_TICK,
            },
        );
    }

    // ------------------------------------------------------------------ triggers

    fn check_triggers(&mut self) -> Result<(), SimErr> {
        let _prof = crate::prof::start("check_triggers");
        let mut rounds = 0u32;
        loop {
            rounds += 1;
            if rounds > 100_000 {
                // e.g. a consumable with cooldown 0: the original engine never returns here
                return Err("consumable trigger loop does not terminate".into());
            }
            let mut e = false;
            let players = self.players.clone();
            let alive_p: Units = players
                .iter()
                .copied()
                .filter(|&t| self.units[t].d.hp > 0.0)
                .collect();
            for t in alive_p {
                let en = self.enemies.clone();
                if self.check_triggers_for_unit(t, &players, en.as_deref())? {
                    e = true;
                }
            }
            if let Some(en) = self.enemies.clone() {
                let alive_e: Units = en
                    .iter()
                    .copied()
                    .filter(|&t| self.units[t].d.hp > 0.0)
                    .collect();
                for t in alive_e {
                    let en2 = self.enemies.clone().unwrap_or_default();
                    if self.check_triggers_for_unit(t, &en2, Some(&players))? {
                        e = true;
                    }
                }
            }
            if !e {
                return Ok(());
            }
        }
    }

    fn check_triggers_for_unit(
        &mut self,
        e: UnitId,
        allies: &[UnitId],
        opps: Option<&[UnitId]>,
    ) -> Result<bool, SimErr> {
        if self.units[e].d.hp <= 0.0 {
            return Err("Checking triggers for a dead unit".into());
        }
        let mut a = false;
        let n = self.get_target(opps);
        for drink in [false, true] {
            let len = if drink {
                self.units[e].drinks.len()
            } else {
                self.units[e].food.len()
            };
            for slot in 0..len {
                let present = if drink {
                    self.units[e].drinks[slot].is_some()
                } else {
                    self.units[e].food[slot].is_some()
                };
                if !present {
                    continue;
                }
                if self.consumable_should_trigger(e, drink, slot, n, allies, opps)?
                    && self.try_use_consumable(e, drink, slot)
                {
                    a = true;
                }
            }
        }
        Ok(a)
    }

    fn consumable_should_trigger(
        &self,
        unit: UnitId,
        drink: bool,
        slot: usize,
        target: Option<UnitId>,
        allies: &[UnitId],
        opps: Option<&[UnitId]>,
    ) -> Result<bool, SimErr> {
        let u = &self.units[unit];
        if u.stunned {
            return Ok(false);
        }
        let c = self.consumable(unit, drink, slot);
        let o = if c.is_food {
            u.s[FOOD_HASTE]
        } else {
            u.s[DRINK_CONCENTRATION]
        };
        let mut s = c.cooldown;
        if o > 0.0 {
            s = s / (1.0 + o);
        }
        if c.last_used + s > self.time {
            return Ok(false);
        }
        if c.triggers.is_empty() {
            return Ok(true);
        }
        let mut l = true;
        for tr in &c.triggers {
            if !self.trigger_active(tr, unit, target, Some(allies), opps)? {
                l = false;
            }
        }
        Ok(l)
    }

    fn ability_should_trigger(
        &self,
        unit: UnitId,
        slot: usize,
        target: Option<UnitId>,
        allies: Option<&[UnitId]>,
        opps: Option<&[UnitId]>,
    ) -> Result<bool, SimErr> {
        let u = &self.units[unit];
        if u.stunned || u.silenced {
            return Ok(false);
        }
        let ab = u.abilities[slot].as_ref().unwrap();
        let o = u.s[ABILITY_HASTE];
        let mut s = ab.def.cooldown;
        if o > 0.0 {
            s = (s * 100.0) / (100.0 + o);
        }
        if ab.last_used + s > self.time {
            return Ok(false);
        }
        if ab.triggers.is_empty() {
            return Ok(true);
        }
        let mut l = true;
        for tr in ab.triggers.iter() {
            if !self.trigger_active(tr, unit, target, allies, opps)? {
                l = false;
            }
        }
        Ok(l)
    }

    fn trigger_active(
        &self,
        tr: &Trigger,
        unit: UnitId,
        target: Option<UnitId>,
        allies: Option<&[UnitId]>,
        opps: Option<&[UnitId]>,
    ) -> Result<bool, SimErr> {
        if tr.single_target {
            let v = match tr.dep {
                Dep::SelfDep => self.dep_value(tr, unit)?,
                Dep::TargetedEnemy => match target {
                    None => return Ok(false),
                    Some(t) => self.dep_value(tr, t)?,
                },
                _ => return Err("Unknown dependencyHrid in trigger".into()),
            };
            return compare(tr, v);
        }
        let list: &[UnitId] = match tr.dep {
            Dep::AllAllies => allies.ok_or("allies list missing")?,
            Dep::AllEnemies => match opps {
                None => return Ok(false),
                Some(o) => o,
            },
            _ => return Err("Unknown dependencyHrid in trigger".into()),
        };
        let v = match tr.cond {
            Cond::NumberOfActiveUnits => {
                Val::Num(list.iter().filter(|&&o| self.units[o].d.hp > 0.0).count() as f64)
            }
            Cond::NumberOfDeadUnits => {
                Val::Num(list.iter().filter(|&&o| self.units[o].d.hp <= 0.0).count() as f64)
            }
            Cond::LowestHpPercentage => {
                let mut m = 2.0;
                for &o in list {
                    let u = &self.units[o];
                    if u.d.hp > 0.0 {
                        let l = u.d.hp / u.d.max_hp;
                        if l < m {
                            m = l;
                        }
                    }
                }
                Val::Num(m * 100.0)
            }
            _ => {
                let mut acc = Val::Num(0.0);
                for &o in list {
                    if self.units[o].d.hp <= 0.0 {
                        continue;
                    }
                    let v = self.dep_value(tr, o)?;
                    acc = match (acc, v) {
                        (Val::Str, _) => Val::Str,
                        (Val::Num(a), Val::Num(b)) => Val::Num(a + b),
                        (Val::Num(a), Val::Bool(b)) => Val::Num(a + if b { 1.0 } else { 0.0 }),
                        (Val::Num(_), Val::Obj(true)) => Val::Str,
                        (Val::Num(_), Val::Obj(false)) => Val::Num(f64::NAN),
                        (Val::Num(_), Val::Str) => Val::Str,
                        (a, _) => a,
                    };
                }
                acc
            }
        };
        compare(tr, v)
    }

    fn dep_value(&self, tr: &Trigger, u: UnitId) -> Result<Val, SimErr> {
        let unit = &self.units[u];
        Ok(match &tr.cond {
            Cond::BuffExact(id) => Val::Obj(unit.combat_buffs.contains_key(id)),
            Cond::BuffPrefix(k) => {
                let bit = 1u32 << *k;
                Val::Obj(
                    unit.combat_buffs
                        .keys()
                        .any(|u| self.it.prefix_mask[*u as usize] & bit != 0),
                )
            }
            Cond::CurrentHp => Val::Num(unit.d.hp),
            Cond::CurrentMp => Val::Num(unit.d.mp),
            Cond::MissingHp => Val::Num(unit.d.max_hp - unit.d.hp),
            Cond::MissingMp => Val::Num(unit.d.max_mp - unit.d.mp),
            Cond::StunStatus => Val::Bool(unit.stunned || unit.stun_expire == Some(self.time)),
            Cond::BlindStatus => Val::Bool(unit.blinded || unit.blind_expire == Some(self.time)),
            Cond::SilenceStatus => {
                Val::Bool(unit.silenced || unit.silence_expire == Some(self.time))
            }
            _ => return Err("Unknown conditionHrid in trigger".into()),
        })
    }

    // ------------------------------------------------------------------ consumables

    fn try_use_consumable(&mut self, e: UnitId, drink: bool, slot: usize) -> bool {
        let _prof = crate::prof::start("try_use_consumable");
        if self.units[e].d.hp <= 0.0 {
            return false;
        }
        let time = self.time;
        let dc = self.units[e].s[DRINK_CONCENTRATION];
        let fh = self.units[e].s[FOOD_HASTE];
        let (mut i, is_drink, is_food, recovery, hp_r, mp_r, hrid, buffs) = {
            let c = self.consumable_mut(e, drink, slot);
            c.last_used = time;
            (
                c.cooldown,
                c.is_drink,
                c.is_food,
                c.recovery,
                c.hp_restore,
                c.mp_restore,
                c.hid,
                c.buffs.clone(),
            )
        };
        if dc > 0.0 && is_drink {
            i = i / (1.0 + dc);
        } else if fh > 0.0 && is_food {
            i = i / (1.0 + fh);
        }
        self.q.add(time + i, Ev::CooldownReady);
        let eh = self.units[e].hid;
        self.res.add_consumable_use(eh, hrid);
        if recovery == 0.0 {
            if hp_r > 0.0 {
                let n = self.units[e].add_hp(hp_r);
                self.res.add_hp_gained(eh, hrid, n);
            }
            if mp_r > 0.0 {
                let n = self.units[e].add_mp(mp_r);
                self.res.add_mp_gained(eh, hrid, n);
                if self.units[e].out_of_mana {
                    self.q.add(time, Ev::AwaitCooldown { source: e });
                }
            }
        } else {
            self.q.add(
                time + CONSUMABLE_TICK,
                Ev::ConsumableTick {
                    source: e,
                    drink,
                    slot,
                    total: recovery / CONSUMABLE_TICK,
                    current: 1.0,
                },
            );
        }
        for n in buffs {
            let mut o = n.clone();
            let dc = self.units[e].s[DRINK_CONCENTRATION];
            if dc > 0.0 && is_drink {
                o.ratio *= 1.0 + dc;
                o.flat *= 1.0 + dc;
                o.duration = o.duration / (1.0 + dc);
            }
            self.units[e].add_buff(&o, time);
            self.q
                .add(time + o.duration, Ev::CheckBuffExpiration { source: e });
        }
        true
    }

    // ------------------------------------------------------------------ abilities

    fn can_use_ability(&mut self, e: UnitId, mana_cost: f64, record: bool) -> bool {
        let u = &self.units[e];
        if u.d.hp <= 0.0 {
            return false;
        }
        let is_player = u.is_player;
        let h = u.hid;
        if u.d.mp < mana_cost {
            if is_player && record {
                self.res.add_ran_out_of_mana(h, true, self.time);
            }
            false
        } else {
            if is_player && record {
                self.res.add_ran_out_of_mana(h, false, self.time);
            }
            true
        }
    }

    fn try_use_ability(&mut self, e0: UnitId, slot: usize) -> Result<bool, SimErr> {
        let _prof = crate::prof::start("try_use_ability");
        let def = match self.units[e0].abilities.get(slot).and_then(|a| a.as_ref()) {
            Some(a) => a.def.clone(),
            None => return Err("cast of missing ability".into()),
        };
        if !self.can_use_ability(e0, def.mana_cost, true) {
            return Ok(false);
        }
        let mut e = e0;
        {
            let u = &mut self.units[e];
            if u.is_player {
                *u.mana_costs.entry(def.hid).or_insert(0.0) += def.mana_cost;
            }
            u.d.mp -= def.mana_cost;
            u.abilities[slot].as_mut().unwrap().last_used = self.time;
        }
        let mut list: SmallVec<[Rc<AbilityDef>; 3]> = SmallVec::new();
        list.push(def.clone());
        if self.units[e].s[BLAZE] > 0.0 && self.rng.next() < self.units[e].s[BLAZE] {
            if self.blaze_def.is_none() {
                self.blaze_def = Some(self.ability_def("blaze", 1.0)?);
            }
            list.push(self.blaze_def.clone().unwrap());
        }
        if self.units[e].s[BLOOM] > 0.0 && self.rng.next() < self.units[e].s[BLOOM] {
            if self.bloom_def.is_none() {
                self.bloom_def = Some(self.ability_def("bloom", 1.0)?);
            }
            list.push(self.bloom_def.clone().unwrap());
        }
        for a in &list {
            for idx in 0..a.effects.len() {
                let eff = &a.effects[idx];
                match eff.kind {
                    EffectKind::Buff => self.ability_buff(e, a, eff)?,
                    EffectKind::Damage => self.ability_damage(e, a, eff)?,
                    EffectKind::Heal => self.ability_heal(e, a, eff)?,
                    EffectKind::SpendHp => self.ability_spend_hp(e, a, eff)?,
                    EffectKind::Revive => self.ability_revive(e, a, eff)?,
                    EffectKind::Promote => {
                        self.q.clear_for_unit(e);
                        let tier = self.units[e].difficulty_tier;
                        let names = [
                            "/monsters/enchanted_rook",
                            "/monsters/enchanted_knight",
                            "/monsters/enchanted_bishop",
                        ];
                        let n = (self.rng.next() * 3.0).floor() as usize;
                        e = self.spawn_monster(names[n], tier, 0.0)?;
                        self.add_next_attack(e)?;
                    }
                    EffectKind::Other => {
                        return Err(format!("Unsupported effect type for ability: {}", a.hrid))
                    }
                }
            }
        }
        if self.units[e].s[RIPPLE] > 0.0 && self.rng.next() < self.units[e].s[RIPPLE] {
            let a = self.units[e].add_mp(10.0);
            let h = self.units[e].hid;
            let rn = self.s_ripple;
            self.res.add_mp_gained(h, rn, a);
            let time = self.time;
            for ab in self.units[e].abilities.iter_mut().flatten() {
                if js::truthy(ab.last_used) && ab.last_used + ab.def.cooldown - time > 0.0 {
                    ab.last_used = js::max(ab.last_used - X * 2.0, time - ab.def.cooldown);
                }
            }
        }
        self.add_next_attack(e)?;
        if self.units[e].d.hp == 0.0 {
            self.kill(e);
        }
        self.check_encounter_end()?;
        Ok(true)
    }

    fn ability_buff(&mut self, e: UnitId, t: &AbilityDef, i: &Effect) -> Result<(), SimErr> {
        let buffs = i.buffs.as_ref().ok_or("buff effect without buffs")?;
        if i.target == Target::AllAllies {
            let a = self.allies(e).ok_or("allies list missing")?;
            let alive: Units = a.iter().copied().filter(|&o| self.units[o].d.hp > 0.0).collect();
            for n in alive {
                for o in buffs {
                    if t.is_special && o.has_multiplier_skill && o.multiplier_per_level > 0.0 {
                        let lvl = match o.multiplier_skill {
                            Some(k) => self.units[e].d.level[k],
                            None => f64::NAN,
                        };
                        let l = 1.0 + lvl * o.multiplier_per_level;
                        let mut c = o.clone();
                        c.flat *= l;
                        c.ratio *= l;
                        self.units[n].add_buff(&c, self.time);
                    } else {
                        self.units[n].add_buff(o, self.time);
                    }
                    self.q
                        .add(self.time + o.duration, Ev::CheckBuffExpiration { source: n });
                }
            }
            return Ok(());
        }
        if i.target != Target::SelfT {
            return Err(format!("Unsupported target type for buff ability effect: {}", t.hrid));
        }
        for a in buffs {
            self.units[e].add_buff(a, self.time);
            self.q
                .add(self.time + a.duration, Ev::CheckBuffExpiration { source: e });
        }
        Ok(())
    }

    fn ability_damage(&mut self, e: UnitId, t: &AbilityDef, i: &Effect) -> Result<(), SimErr> {
        let _prof = crate::prof::start("ability_damage");
        match i.target {
            Target::Enemy | Target::AllEnemies => {}
            _ => {
                return Err(format!(
                    "Unsupported target type for damage ability effect: {}",
                    t.hrid
                ))
            }
        }
        let mut a: Units = match self.opponents(e) {
            Some(a) => a.iter().copied().collect(),
            None => return Ok(()),
        };
        let mut picked: SmallVec<[u32; 8]> = SmallVec::new();
        let mut parry_checked = false;
        let snapshot: Units = a.iter().copied().filter(|&x| self.units[x].d.hp > 0.0).collect();
        let e_is_player = self.units[e].is_player;
        for mut u in snapshot {
            let mut par = None;
            if !parry_checked {
                par = self.check_parry(&a);
                parry_checked = true;
            }
            if let Some(p) = par {
                let g = e;
                let h = self.process_attack(p, g, None)?;
                let (ph, gh) = (self.units[p].hid, self.units[g].hid);
                let pn = self.s_parry;
                self.res
                    .add_attack(ph, gh, pn, if h.did_hit { Some(h.damage_done) } else { None });
                if h.life_steal_heal > 0.0 {
                    let n = self.s_lifesteal;
                    self.res.add_hp_gained(ph, n, h.life_steal_heal);
                }
                if h.mana_leech > 0.0 {
                    let n = self.s_mana_leech;
                    self.res.add_mp_gained(ph, n, h.mana_leech);
                }
                if h.thorn_damage > 0.0 {
                    let tn = self.thorn_name(h.thorn_physical);
                    self.res.add_attack(gh, ph, tn, Some(h.thorn_damage));
                }
                if self.units[g].s[RETALIATION] > 0.0 {
                    let rn = self.s_retaliation;
                    self.res.add_attack(
                        gh,
                        ph,
                        rn,
                        if h.retaliation_damage > 0.0 { Some(h.retaliation_damage) } else { None },
                    );
                }
                if self.units[g].d.hp == 0.0 {
                    self.kill(g);
                }
                if self.units[p].d.hp == 0.0 && (h.thorn_damage != 0.0 || h.retaliation_damage != 0.0) {
                    self.kill(p);
                }
            } else {
                a = a
                    .into_iter()
                    .filter(|&p| {
                        let pu = &self.units[p];
                        !picked.iter().any(|x| *x == pu.hid) && pu.d.hp > 0.0
                    })
                    .collect();
                if !e_is_player && !a.is_empty() && i.target == Target::Enemy {
                    u = self.pick_by_threat(&a)?;
                    picked.push(self.units[u].hid);
                }
                if a.is_empty() {
                    break;
                }
                let g = self.process_attack(e, u, Some(i))?;
                let (eh, uh) = (self.units[e].hid, self.units[u].hid);
                if g.hp_drain > 0.0 {
                    self.res.add_hp_gained(eh, t.hid, g.hp_drain);
                }
                if g.did_hit {
                    if let Some(bs) = &i.buffs {
                        for p in bs {
                            self.units[u].add_buff(p, self.time);
                            self.q
                                .add(self.time + p.duration, Ev::CheckBuffExpiration { source: u });
                        }
                    }
                }
                if i.dot_ratio > 0.0 && g.damage_done > 0.0 {
                    self.q.add(
                        self.time + DOT_TICK,
                        Ev::Dot {
                            source_ref: e,
                            target: u,
                            damage: g.damage_done * i.dot_ratio,
                            total: i.dot_duration / DOT_TICK,
                            current: 1.0,
                        },
                    );
                }
                if g.did_hit
                    && i.stun_chance > 0.0
                    && self.rng.next()
                        < (i.stun_chance * 100.0) / (100.0 + self.units[u].s[TENACITY])
                {
                    let exp = self.time + i.stun_duration;
                    self.units[u].stunned = true;
                    self.units[u].stun_expire = Some(exp);
                    self.q.clear_matching(|h| {
                        matches!(h, Ev::AutoAttack { source } | Ev::CastEnd { source, .. } | Ev::StunExp { source } if *source == u)
                    });
                    self.q.add(exp, Ev::StunExp { source: u });
                }
                if g.did_hit
                    && i.blind_chance > 0.0
                    && self.rng.next()
                        < (i.blind_chance * 100.0) / (100.0 + self.units[u].s[TENACITY])
                {
                    let exp = self.time + i.blind_duration;
                    self.units[u].blinded = true;
                    self.units[u].blind_expire = Some(exp);
                    self.q
                        .clear_matching(|h| matches!(h, Ev::BlindExp { source } if *source == u));
                    if self
                        .q
                        .clear_matching(|h| matches!(h, Ev::AutoAttack { source } if *source == u))
                    {
                        self.add_next_attack(u)?;
                    }
                    self.q.add(exp, Ev::BlindExp { source: u });
                }
                if g.did_hit
                    && i.silence_chance > 0.0
                    && self.rng.next()
                        < (i.silence_chance * 100.0) / (100.0 + self.units[u].s[TENACITY])
                {
                    let exp = self.time + i.silence_duration;
                    self.units[u].silenced = true;
                    self.units[u].silence_expire = Some(exp);
                    self.q
                        .clear_matching(|h| matches!(h, Ev::SilenceExp { source } if *source == u));
                    if self
                        .q
                        .clear_matching(|h| matches!(h, Ev::CastEnd { source, .. } if *source == u))
                    {
                        self.add_next_attack(u)?;
                    }
                    self.q.add(exp, Ev::SilenceExp { source: u });
                }
                if g.did_hit && self.units[e].s[CURSE] > 0.0 {
                    let amt = self.units[e].s[CURSE];
                    self.apply_capped_debuff(u, amt, true);
                }
                if self.units[e].s[FURY] > 0.0 {
                    self.fury(e, g.did_hit, false);
                }
                if self.units[u].s[WEAKEN] > 0.0 {
                    let amt = self.units[u].s[WEAKEN];
                    self.apply_capped_debuff(e, amt, false);
                }
                self.res
                    .add_attack(eh, uh, t.hid, if g.did_hit { Some(g.damage_done) } else { None });
                if g.thorn_damage > 0.0 {
                    let tn = self.thorn_name(g.thorn_physical);
                    self.res.add_attack(uh, eh, tn, Some(g.thorn_damage));
                }
                if self.units[u].s[RETALIATION] > 0.0 {
                    let rn = self.s_retaliation;
                    self.res.add_attack(
                        uh,
                        eh,
                        rn,
                        if g.retaliation_damage > 0.0 { Some(g.retaliation_damage) } else { None },
                    );
                }
                if self.units[u].d.hp == 0.0 {
                    self.kill(u);
                }
                if g.did_hit && i.pierce_chance > self.rng.next() {
                    continue;
                }
            }
            if par.is_some() || i.target == Target::Enemy {
                break;
            }
        }
        Ok(())
    }

    fn process_heal(&mut self, e: UnitId, i: &Effect, target: UnitId) -> Result<f64, SimErr> {
        if !i.style_is_magic {
            return Err("Heal ability effect not supported for combat style".into());
        }
        let u = &self.units[e];
        let a = 1.0 + u.s[HEALING_AMPLIFY];
        let n = u.d.max_dmg[IDX_MAGIC];
        let o = i.damage_flat;
        let s = i.damage_ratio;
        let l = a * (1.0 + o);
        let c = a * (s * n + o);
        let v = random_int(&mut self.rng, l, c);
        Ok(self.units[target].add_hp(v))
    }

    fn ability_heal(&mut self, e: UnitId, t: &AbilityDef, i: &Effect) -> Result<(), SimErr> {
        match i.target {
            Target::AllAllies => {
                let n = self.allies(e).ok_or("allies list missing")?;
                let alive: Units =
                    n.iter().copied().filter(|&o| self.units[o].d.hp > 0.0).collect();
                for o in alive {
                    let s = self.process_heal(e, i, o)?;
                    let h = self.units[o].hid;
                    self.res.add_hp_gained(h, t.hid, s);
                }
                Ok(())
            }
            Target::LowestHpAlly => {
                let n = self.allies(e).ok_or("allies list missing")?;
                let mut best: Option<UnitId> = None;
                for &s in n.iter() {
                    if self.units[s].d.hp <= 0.0 {
                        continue;
                    }
                    match best {
                        None => best = Some(s),
                        Some(o) => {
                            let l = self.units[s].d.hp / self.units[s].d.max_hp;
                            let c = self.units[o].d.hp / self.units[o].d.max_hp;
                            if l < c {
                                best = Some(s);
                            }
                        }
                    }
                }
                if let Some(o) = best {
                    let s = self.process_heal(e, i, o)?;
                    let h = self.units[o].hid;
                    self.res.add_hp_gained(h, t.hid, s);
                }
                Ok(())
            }
            Target::SelfT => {
                let a = self.process_heal(e, i, e)?;
                let h = self.units[e].hid;
                self.res.add_hp_gained(h, t.hid, a);
                Ok(())
            }
            _ => Err(format!("Unsupported target type for heal ability effect: {}", t.hrid)),
        }
    }

    fn ability_revive(&mut self, e: UnitId, t: &AbilityDef, i: &Effect) -> Result<(), SimErr> {
        if i.target != Target::DeadAlly {
            return Err(format!("Unsupported target type for revive ability effect: {}", t.hrid));
        }
        let list = self.allies(e).ok_or("allies list missing")?;
        let n = match list.iter().copied().find(|&o| self.units[o].d.hp <= 0.0) {
            Some(n) => n,
            None => return Ok(()),
        };
        let nh = self.units[n].hid;
        self.q
            .clear_matching(|s| matches!(s, Ev::PlayerRespawn { hrid } if *hrid == nh));
        self.units[n].remove_expired(self.time);
        if !i.style_is_magic {
            return Err("Heal ability effect not supported for combat style".into());
        }
        let (l, c) = {
            let u = &self.units[e];
            let a = 1.0 + u.s[HEALING_AMPLIFY];
            let nn = u.d.max_dmg[IDX_MAGIC];
            (a * (1.0 + i.damage_flat), a * (i.damage_ratio * nn + i.damage_flat))
        };
        let v = random_int(&mut self.rng, l, c);
        let o = self.units[n].add_hp(v);
        {
            let tu = &mut self.units[n];
            tu.d.mp = tu.d.max_mp;
            tu.clear_ccs();
        }
        self.res.add_hp_gained(nh, t.hid, o);
        self.add_next_attack(n)?;
        if !self.units[e].is_player {
            self.res.update_time_spent_alive(self.it.name(nh), true, self.time);
        }
        Ok(())
    }

    fn ability_spend_hp(&mut self, e: UnitId, t: &AbilityDef, i: &Effect) -> Result<(), SimErr> {
        if i.target != Target::SelfT {
            return Err(format!("Unsupported target type for spend hp ability effect: {}", t.hrid));
        }
        let u = &mut self.units[e];
        let cur = u.d.hp;
        let n = (cur * i.spend_hp_ratio).floor();
        u.d.hp -= n;
        let h = u.hid;
        self.res.add_hp_spent(h, t.hid, n);
        Ok(())
    }
}

fn compare(tr: &Trigger, v: Val) -> Result<bool, SimErr> {
    let x = tr.value;
    Ok(match (tr.cmp, v) {
        (Cmp::Unknown, _) => return Err("Unknown comparatorHrid in trigger".into()),
        (Cmp::Gte, Val::Num(a)) => a >= x,
        (Cmp::Lte, Val::Num(a)) => a <= x,
        (Cmp::IsActive, Val::Num(a)) => js::truthy(a),
        (Cmp::IsInactive, Val::Num(a)) => !js::truthy(a),
        (Cmp::Gte, Val::Bool(b)) => (if b { 1.0 } else { 0.0 }) >= x,
        (Cmp::Lte, Val::Bool(b)) => (if b { 1.0 } else { 0.0 }) <= x,
        (Cmp::IsActive, Val::Bool(b)) => b,
        (Cmp::IsInactive, Val::Bool(b)) => !b,
        (Cmp::Gte, Val::Obj(_)) | (Cmp::Lte, Val::Obj(_)) => false,
        (Cmp::IsActive, Val::Obj(p)) => p,
        (Cmp::IsInactive, Val::Obj(p)) => !p,
        (Cmp::Gte, Val::Str) | (Cmp::Lte, Val::Str) => false,
        (Cmp::IsActive, Val::Str) => true,
        (Cmp::IsInactive, Val::Str) => false,
    })
}

/// Per-skill share of combat experience (`addExperienceGain`'s `i` object).
fn xp_weights(primary: &str, focus: &str, map: Vec<String>) -> [f64; 7] {
    let mut i = [0.0f64; 7];
    if let Some(k) = primary.split('/').nth(2).and_then(skill_index) {
        i[k] = 0.3;
    }
    let o = map.len() as f64;
    if !focus.is_empty() && map.iter().any(|m| m == focus) {
        if let Some(k) = focus.split('/').nth(2).and_then(skill_index) {
            i[k] += 0.7;
        }
    } else {
        for l in &map {
            if let Some(k) = l.split('/').nth(2).and_then(skill_index) {
                i[k] += 0.7 / o;
            }
        }
    }
    i
}

/// `x.calculateTickValue`
#[inline]
fn calc_tick(e: f64, t: f64, i: f64) -> f64 {
    let a = ((i * e) / t).floor();
    let n = (((i - 1.0) * e) / t).floor();
    a - n
}

/// `x.randomInt`
fn random_int(rng: &mut Rng, mut e: f64, mut t: f64) -> f64 {
    if t < e {
        std::mem::swap(&mut e, &mut t);
    }
    let i = e.ceil();
    let a = t.floor();
    if e.floor() == a {
        return ((e + t) / 2.0 + rng.next()).floor();
    }
    let n = -1.0 * (e - i);
    let o = t - a;
    let s = 2.0 * n + (a - i);
    let l = (a + i) / 2.0;
    let c = (t + e) / 2.0;
    let u = (s * (c - l)) / (a + 1.0 - c);
    let w = (u / (u + s)).abs();
    if rng.next() < w {
        if o > n {
            (a + 1.0).floor()
        } else {
            (i - 1.0).floor()
        }
    } else if o > n {
        (e + rng.next() * (a + n - e + 1.0)).floor()
    } else {
        (i - o + rng.next() * (t - (i - o) + 1.0)).floor()
    }
}
