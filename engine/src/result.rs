//! `simResult` accumulation and JSON output in the same shape as the JS engine.

use crate::js;
use crate::js::FxIndexMap as IndexMap;
use serde_json::{json, Map, Value};
use crate::data::Interner;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum DmgKey {
    Num(u64),
    Miss,
}

pub struct TimeAlive {
    pub name: String,
    pub time_spent_alive: f64,
    pub spawned_at: f64,
    pub alive: bool,
    pub count: f64,
}

pub struct OutOfMana {
    pub is_out: bool,
    pub start: f64,
    pub total: f64,
}

pub struct SimResult {
    /// set when the original engine would have thrown
    pub error: Option<String>,
    pub record_attacks: bool,
    pub deaths: IndexMap<u32, f64>,
    pub experience_gained: IndexMap<u32, [f64; 7]>,
    pub encounters: f64,
    /// (source hrid, target hrid, ability) -> damage/miss -> count
    pub attacks: IndexMap<(u32, u32, u32), IndexMap<DmgKey, f64>>,
    pub consumables_used: IndexMap<(u32, u32), f64>,
    pub hitpoints_gained: IndexMap<(u32, u32), f64>,
    pub manapoints_gained: IndexMap<(u32, u32), f64>,
    pub debuff_on_level_gap: IndexMap<u32, f64>,
    pub drop_rate_multiplier: IndexMap<u32, f64>,
    pub rare_find_multiplier: IndexMap<u32, f64>,
    pub combat_drop_quantity: IndexMap<u32, f64>,
    pub player_ran_out_of_mana: IndexMap<u32, bool>,
    pub player_ran_out_of_mana_time: IndexMap<u32, OutOfMana>,
    pub mana_used: IndexMap<u32, IndexMap<u32, f64>>,
    pub time_spent_alive: Vec<TimeAlive>,
    pub boss_spawns: Vec<String>,
    pub hitpoints_spent: IndexMap<(u32, u32), f64>,
    pub zone_name: Option<String>,
    pub difficulty_tier: Option<f64>,
    pub labyrinth_name: Option<String>,
    pub room_level: Option<f64>,
    pub is_dungeon: bool,
    pub is_labyrinth: bool,
    pub dungeons_completed: f64,
    pub dungeons_failed: f64,
    pub dungeon_attempts_started: f64,
    pub max_wave_reached: f64,
    pub number_of_players: f64,
    pub max_enrage_stack: f64,
    pub min_dungeon_time: f64,
    pub last_dungeon_finish_time: f64,
    pub last_encounter_finish_time: f64,
    /// (simulationTime, wave)
    pub wipe_events: Vec<(f64, f64)>,
    pub simulated_time: f64,
}

impl SimResult {
    pub fn new(
        zone: Option<(String, f64)>,
        lab: Option<(String, f64)>,
        n_players: usize,
        record_attacks: bool,
        names: &mut Interner,
    ) -> SimResult {
        let mut out_of_mana = IndexMap::default();
        for i in 1..=5 {
            out_of_mana.insert(names.id(&format!("player{}", i)), false);
        }
        SimResult {
            error: None,
            record_attacks,
            deaths: IndexMap::default(),
            experience_gained: IndexMap::default(),
            encounters: 0.0,
            attacks: IndexMap::default(),
            consumables_used: IndexMap::default(),
            hitpoints_gained: IndexMap::default(),
            manapoints_gained: IndexMap::default(),
            debuff_on_level_gap: IndexMap::default(),
            drop_rate_multiplier: IndexMap::default(),
            rare_find_multiplier: IndexMap::default(),
            combat_drop_quantity: IndexMap::default(),
            player_ran_out_of_mana: out_of_mana,
            player_ran_out_of_mana_time: IndexMap::default(),
            mana_used: IndexMap::default(),
            time_spent_alive: Vec::new(),
            boss_spawns: Vec::new(),
            hitpoints_spent: IndexMap::default(),
            zone_name: zone.as_ref().map(|z| z.0.clone()),
            difficulty_tier: zone.as_ref().map(|z| z.1),
            labyrinth_name: lab.as_ref().map(|l| l.0.clone()),
            room_level: lab.as_ref().map(|l| l.1),
            is_dungeon: false,
            is_labyrinth: lab.is_some(),
            dungeons_completed: 0.0,
            dungeons_failed: 0.0,
            dungeon_attempts_started: 0.0,
            max_wave_reached: 0.0,
            number_of_players: n_players as f64,
            max_enrage_stack: 0.0,
            min_dungeon_time: 0.0,
            last_dungeon_finish_time: 0.0,
            last_encounter_finish_time: 0.0,
            wipe_events: Vec::new(),
            simulated_time: 0.0,
        }
    }

    pub fn add_death(&mut self, hrid: u32) {
        *self.deaths.entry(hrid).or_insert(0.0) += 1.0;
    }

    pub fn update_time_spent_alive(&mut self, name: &str, alive: bool, time: f64) {
        let idx = self.time_spent_alive.iter().position(|x| x.name == name);
        if alive {
            match idx {
                Some(a) => {
                    self.time_spent_alive[a].alive = true;
                    self.time_spent_alive[a].spawned_at = time;
                }
                None => self.time_spent_alive.push(TimeAlive {
                    name: name.to_string(),
                    time_spent_alive: 0.0,
                    spawned_at: time,
                    alive: true,
                    count: 0.0,
                }),
            }
        } else {
            match idx {
                Some(a) => {
                    let e = &mut self.time_spent_alive[a];
                    let n = time - e.spawned_at;
                    e.alive = false;
                    e.time_spent_alive += n;
                    e.count += 1.0;
                }
                None => {
                    if self.error.is_none() {
                        self.error = Some("Cannot read properties of undefined (reading 'spawnedAt')".into());
                    }
                }
            }
        }
    }

    pub fn update_dungeon_finish(&mut self, name: &str, time: f64) {
        if let Some(e) = self.time_spent_alive.iter().find(|x| x.name == name) {
            let a = time - e.spawned_at;
            if self.min_dungeon_time == 0.0 || self.min_dungeon_time > a {
                self.min_dungeon_time = a;
            }
        }
    }

    pub fn add_attack(&mut self, src: u32, tgt: u32, ability: u32, dmg: Option<f64>) {
        if !self.record_attacks {
            return;
        }
        let k = match dmg {
            Some(d) => DmgKey::Num(if d == 0.0 { 0.0f64.to_bits() } else { d.to_bits() }),
            None => DmgKey::Miss,
        };
        let inner = self
            .attacks
            .entry((src, tgt, ability))
            .or_default();
        *inner.entry(k).or_insert(0.0) += 1.0;
    }

    pub fn add_consumable_use(&mut self, unit: u32, item: u32) {
        *self
            .consumables_used
            .entry((unit, item))
            .or_insert(0.0) += 1.0;
    }

    pub fn add_hp_gained(&mut self, unit: u32, src: u32, v: f64) {
        *self
            .hitpoints_gained
            .entry((unit, src))
            .or_insert(0.0) += v;
    }

    pub fn add_mp_gained(&mut self, unit: u32, src: u32, v: f64) {
        *self
            .manapoints_gained
            .entry((unit, src))
            .or_insert(0.0) += v;
    }

    pub fn add_hp_spent(&mut self, unit: u32, src: u32, v: f64) {
        *self
            .hitpoints_spent
            .entry((unit, src))
            .or_insert(0.0) += v;
    }

    pub fn add_ran_out_of_mana(&mut self, hrid: u32, out: bool, time: f64) {
        if out {
            self.player_ran_out_of_mana.insert(hrid, true);
        }
        let e = self
            .player_ran_out_of_mana_time
            .entry(hrid)
            .or_insert(OutOfMana {
                is_out: false,
                start: 0.0,
                total: 0.0,
            });
        if out {
            if !e.is_out {
                e.is_out = true;
                e.start = time;
            }
        } else if e.is_out {
            e.is_out = false;
            e.total += time - e.start;
        }
    }

    pub fn to_json(&self, names: &Interner) -> Value {
        let nm = |i: &u32| names.name(*i).to_string();
        fn n(x: f64) -> Value {
            json_num(x)
        }
        let mut o = Map::new();
        o.insert(
            "deaths".into(),
            Value::Object(self.deaths.iter().map(|(k, v)| (nm(k), n(*v))).collect()),
        );
        let mut xp = Map::new();
        for (k, v) in &self.experience_gained {
            let mut m = Map::new();
            for (i, s) in crate::data::SKILLS.iter().enumerate() {
                m.insert(s.to_string(), n(v[i]));
            }
            xp.insert(nm(k), Value::Object(m));
        }
        o.insert("experienceGained".into(), Value::Object(xp));
        o.insert("encounters".into(), n(self.encounters));
        let mut att: Map<String, Value> = Map::new();
        for ((s, t, a), dm) in &self.attacks {
            let sm = att
                .entry(nm(s))
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap();
            let tm = sm
                .entry(nm(t))
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap();
            let am = tm
                .entry(nm(a))
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap();
            for (k, c) in dm {
                let key = match k {
                    DmgKey::Num(b) => js::num_key(f64::from_bits(*b)),
                    DmgKey::Miss => "miss".to_string(),
                };
                am.insert(key, n(*c));
            }
        }
        o.insert("attacks".into(), Value::Object(att));
        o.insert("consumablesUsed".into(), nested(&self.consumables_used, names));
        o.insert("hitpointsGained".into(), nested(&self.hitpoints_gained, names));
        o.insert("manapointsGained".into(), nested(&self.manapoints_gained, names));
        o.insert("debuffOnLevelGap".into(), flat(&self.debuff_on_level_gap, names));
        o.insert("dropRateMultiplier".into(), flat(&self.drop_rate_multiplier, names));
        o.insert("rareFindMultiplier".into(), flat(&self.rare_find_multiplier, names));
        o.insert("combatDropQuantity".into(), flat(&self.combat_drop_quantity, names));
        o.insert(
            "playerRanOutOfMana".into(),
            Value::Object(
                self.player_ran_out_of_mana
                    .iter()
                    .map(|(k, v)| (nm(k), Value::Bool(*v)))
                    .collect(),
            ),
        );
        o.insert(
            "playerRanOutOfManaTime".into(),
            Value::Object(
                self.player_ran_out_of_mana_time
                    .iter()
                    .map(|(k, v)| {
                        (
                            nm(k),
                            json!({"isOutOfMana": v.is_out, "startTimeForOutOfMana": n(v.start), "totalTimeForOutOfMana": n(v.total)}),
                        )
                    })
                    .collect(),
            ),
        );
        o.insert(
            "manaUsed".into(),
            Value::Object(
                self.mana_used
                    .iter()
                    .map(|(k, v)| {
                        (
                            nm(k),
                            Value::Object(v.iter().map(|(a, b)| (nm(a), n(*b))).collect()),
                        )
                    })
                    .collect(),
            ),
        );
        o.insert(
            "timeSpentAlive".into(),
            Value::Array(
                self.time_spent_alive
                    .iter()
                    .map(|t| {
                        json!({"name": t.name, "timeSpentAlive": n(t.time_spent_alive), "spawnedAt": n(t.spawned_at), "alive": t.alive, "count": n(t.count)})
                    })
                    .collect(),
            ),
        );
        o.insert("bossSpawns".into(), json!(self.boss_spawns));
        o.insert("hitpointsSpent".into(), nested(&self.hitpoints_spent, names));
        if let Some(z) = &self.zone_name {
            o.insert("zoneName".into(), json!(z));
        }
        if let Some(d) = self.difficulty_tier {
            o.insert("difficultyTier".into(), n(d));
        }
        if let Some(l) = &self.labyrinth_name {
            o.insert("labyrinthName".into(), json!(l));
        }
        if let Some(r) = self.room_level {
            o.insert("roomLevel".into(), n(r));
        }
        o.insert("isDungeon".into(), json!(self.is_dungeon));
        o.insert("isLabyrinth".into(), json!(self.is_labyrinth));
        o.insert("dungeonsCompleted".into(), n(self.dungeons_completed));
        o.insert("dungeonsFailed".into(), n(self.dungeons_failed));
        o.insert("dungeonAttemptsStarted".into(), n(self.dungeon_attempts_started));
        o.insert("maxWaveReached".into(), n(self.max_wave_reached));
        o.insert("numberOfPlayers".into(), n(self.number_of_players));
        o.insert("maxEnrageStack".into(), n(self.max_enrage_stack));
        o.insert("minDungenonTime".into(), n(self.min_dungeon_time));
        o.insert("dungeonTerminalTrackingVersion".into(), n(1.0));
        o.insert("lastDungeonFinishTime".into(), n(self.last_dungeon_finish_time));
        o.insert("lastEncounterFinishTime".into(), n(self.last_encounter_finish_time));
        o.insert(
            "wipeEvents".into(),
            Value::Array(
                self.wipe_events
                    .iter()
                    .map(|(t, w)| json!({"simulationTime": n(*t), "logs": [], "wave": n(*w)}))
                    .collect(),
            ),
        );
        o.insert("timeSeriesData".into(), json!({"timestamps": [], "players": {}}));
        o.insert("simulatedTime".into(), n(self.simulated_time));
        Value::Object(o)
    }
}

pub fn json_num(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else if x.is_finite() {
        Value::from(x)
    } else {
        // JSON has no NaN/Infinity; JS JSON.stringify writes null
        Value::Null
    }
}

fn flat(m: &IndexMap<u32, f64>, names: &Interner) -> Value {
    Value::Object(m.iter().map(|(k, v)| (names.name(*k).to_string(), json_num(*v))).collect())
}

fn nested(m: &IndexMap<(u32, u32), f64>, names: &Interner) -> Value {
    let mut out: Map<String, Value> = Map::new();
    for ((a, b), v) in m {
        out.entry(names.name(*a).to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .unwrap()
            .insert(names.name(*b).to_string(), json_num(*v));
    }
    Value::Object(out)
}
