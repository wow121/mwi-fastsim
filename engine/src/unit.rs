//! Combat units (players and monsters): stats, buffs, `updateCombatDetails`.

use crate::data::*;
use crate::js;
use crate::stats::*;
use crate::js::FxIndexMap as IndexMap;
use serde_json::Value;
use std::rc::Rc;

pub type UnitId = usize;

#[derive(Clone, Debug)]
pub struct Buff {
    pub unique: u32,
    pub typ: u32,
    pub ratio: f64,
    pub flat: f64,
    pub duration: f64,
    pub start: f64,
    pub permanent: bool,
    pub cand: u64,
}

#[derive(Clone, Debug)]
pub struct PermBuff {
    pub unique: u32,
    pub typ: u32,
    pub flat: f64,
    pub ratio: f64,
    pub duration: f64,
}

pub struct Ability {
    pub def: Rc<AbilityDef>,
    pub triggers: Rc<Vec<Trigger>>,
    pub last_used: f64,
}

pub struct Consumable {
    pub hrid: Rc<str>,
    pub hid: u32,
    pub cooldown: f64,
    pub hp_restore: f64,
    pub mp_restore: f64,
    pub recovery: f64,
    pub is_food: bool,
    pub is_drink: bool,
    pub buffs: Vec<BuffTemplate>,
    pub triggers: Vec<Trigger>,
    pub last_used: f64,
}

/// Derived values computed by `updateCombatDetails` (the non-`combatStats` part).
#[derive(Clone)]
pub struct Details {
    pub level: [f64; 7],
    pub max_hp: f64,
    pub hp: f64,
    pub max_mp: f64,
    pub mp: f64,
    /// stab, slash, smash, ranged, magic
    pub acc: [f64; 5],
    pub max_dmg: [f64; 5],
    pub eva: [f64; 5],
    pub defensive_max_damage: f64,
    pub total_armor: f64,
    pub total_water_res: f64,
    pub total_nature_res: f64,
    pub total_fire_res: f64,
    pub total_threat: f64,
}

impl Default for Details {
    fn default() -> Self {
        Details {
            level: [1.0; 7],
            max_hp: 110.0,
            hp: 110.0,
            max_mp: 110.0,
            mp: 110.0,
            acc: [11.0; 5],
            max_dmg: [11.0; 5],
            eva: [11.0; 5],
            defensive_max_damage: 0.0,
            total_armor: 0.2,
            total_water_res: 0.4,
            total_nature_res: 0.4,
            total_fire_res: 0.4,
            total_threat: 100.0,
        }
    }
}

pub const IDX_STAB: usize = 0;
pub const IDX_SLASH: usize = 1;
pub const IDX_SMASH: usize = 2;
pub const IDX_RANGED: usize = 3;
pub const IDX_MAGIC: usize = 4;

pub struct PlayerStatic {
    pub equip: Vec<(usize, f64)>,
    pub style: Style,
    pub style_hrid: String,
    pub dtype: DType,
    pub attack_interval: f64,
    pub primary_training: String,
    pub focus_training: String,
    pub food_slots: f64,
    pub drink_slots: f64,
    pub bulwark: bool,
    /// experience split between the 7 skills (depends only on the equipment)
    pub xp_weights: [f64; 7],
}

pub struct MonsterTemplate {
    pub hrid: Rc<str>,
    pub hid: u32,
    pub data_levels: [f64; 7],
    pub data_experience: f64,
    pub enrage_time: f64,
    pub style: Style,
    pub style_hrid: String,
    /// numeric combatStats present in the monster data
    pub data_stats: Vec<(usize, f64)>,
    pub dtype: Option<DType>,
    /// MONSTER_ZERO_KEYS indices missing (or null) in the data
    pub zero_stats: Vec<usize>,
    pub data_attack_interval: f64,
    /// (ability hrid, level before room scaling, minDifficultyTier)
    pub abilities: Vec<(String, f64, f64)>,
}

impl MonsterTemplate {
    pub fn build(hrid: &str, gd: &GameData) -> Result<MonsterTemplate, String> {
        let m = gd
            .monsters
            .get(hrid)
            .ok_or_else(|| format!("No monster found for hrid: {}", hrid))?;
        let cd = m.get("combatDetails").cloned().unwrap_or(Value::Null);
        let mut data_levels = [0.0; 7];
        for (i, s) in SKILLS.iter().enumerate() {
            data_levels[i] = num(&cd, &format!("{}Level", s));
        }
        let cs = cd.get("combatStats").cloned().unwrap_or(Value::Null);
        let mut data_stats = Vec::new();
        let mut dtype = None;
        let mut style_hrid = String::new();
        if let Value::Object(map) = &cs {
            for (k, v) in map {
                if k == "damageType" {
                    dtype = Some(DType::parse(v.as_str().unwrap_or("")));
                    continue;
                }
                if k == "combatStyleHrids" {
                    style_hrid = v
                        .get(0)
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    continue;
                }
                if let Some(i) = stat_index(k) {
                    data_stats.push((i, to_num(v)));
                }
            }
        }
        let zero_stats = MONSTER_ZERO_KEYS
            .iter()
            .filter(|k| matches!(cs.get(**k), None | Some(Value::Null)))
            .map(|k| stat_index(k).unwrap())
            .collect();
        let mut abilities = Vec::new();
        if let Some(Value::Array(list)) = m.get("abilities") {
            for a in list {
                abilities.push((
                    string(a, "abilityHrid"),
                    num(a, "level"),
                    num(a, "minDifficultyTier"),
                ));
            }
        }
        Ok(MonsterTemplate {
            hid: 0,
            hrid: Rc::from(hrid),
            data_levels,
            data_experience: num(m, "experience"),
            enrage_time: num(m, "enrageTime"),
            style: Style::parse(&style_hrid),
            style_hrid,
            data_stats,
            dtype,
            zero_stats,
            data_attack_interval: num(&cd, "attackInterval"),
            abilities,
        })
    }
}

pub enum Kind {
    Player(PlayerStatic),
    Monster {
        tpl: Rc<MonsterTemplate>,
        tier: f64,
        room_level: f64,
    },
}

pub struct Unit {
    pub is_player: bool,
    pub hrid: Rc<str>,
    pub hid: u32,
    pub kind: Kind,
    pub stunned: bool,
    pub stun_expire: Option<f64>,
    pub blinded: bool,
    pub blind_expire: Option<f64>,
    pub silenced: bool,
    pub silence_expire: Option<f64>,
    pub out_of_mana: bool,
    /// staminaLevel .. magicLevel of the unit itself (before buffs)
    pub base_level: [f64; 7],
    pub experience: f64,
    pub experience_rate: f64,
    pub enrage_time: f64,
    pub abilities: Vec<Option<Ability>>,
    pub food: Vec<Option<Consumable>>,
    pub drinks: Vec<Option<Consumable>>,
    pub mana_costs: IndexMap<u32, f64>,
    pub d: Details,
    pub s: [f64; N_STATS],
    pub style: Style,
    pub dtype: DType,
    pub combat_buffs: IndexMap<u32, Buff>,
    pub candidates: IndexMap<u32, Vec<Buff>>,
    pub next_cand: u64,
    pub permanent: IndexMap<u32, PermBuff>,
    pub debuff_on_level_gap: f64,
    pub task_damage_enabled: bool,
    pub difficulty_tier: f64,
}

impl Unit {
    fn blank(is_player: bool, hrid: Rc<str>, kind: Kind) -> Unit {
        Unit {
            is_player,
            hrid,
            hid: 0,
            kind,
            stunned: false,
            stun_expire: None,
            blinded: false,
            blind_expire: None,
            silenced: false,
            silence_expire: None,
            out_of_mana: false,
            base_level: [1.0; 7],
            experience: 0.0,
            experience_rate: 0.0,
            enrage_time: 0.0,
            abilities: Vec::new(),
            food: Vec::new(),
            drinks: Vec::new(),
            mana_costs: IndexMap::default(),
            d: Details::default(),
            s: default_stats(),
            style: Style::Smash,
            dtype: DType::Physical,
            combat_buffs: IndexMap::default(),
            candidates: IndexMap::default(),
            next_cand: 0,
            permanent: IndexMap::default(),
            debuff_on_level_gap: 0.0,
            task_damage_enabled: false,
            difficulty_tier: 0.0,
        }
    }

    pub fn new_player(hrid: &str, ps: PlayerStatic) -> Unit {
        Unit::blank(true, Rc::from(hrid), Kind::Player(ps))
    }

    /// `new me(hrid, tier, roomLevel)` minus abilities (filled by the caller).
    pub fn new_monster(tpl: Rc<MonsterTemplate>, tier: f64, room_level: f64) -> Unit {
        let room_level = if room_level <= 0.0 { 100.0 } else { room_level };
        let hrid = tpl.hrid.clone();
        let hid = tpl.hid;
        let enrage = tpl.enrage_time;
        let mut u = Unit::blank(
            false,
            hrid,
            Kind::Monster {
                tpl,
                tier,
                room_level,
            },
        );
        u.enrage_time = enrage;
        u.hid = hid;
        u.difficulty_tier = tier;
        u.abilities = (0..4).map(|_| None).collect();
        u
    }

    #[inline]
    pub fn alive(&self) -> bool {
        self.d.hp > 0.0
    }

    // ---- buffs (zt mixin) ----

    #[inline]
    fn strength(b: &Buff) -> f64 {
        js::or0(b.ratio).abs() + js::or0(b.flat).abs()
    }

    fn select_strongest(&mut self, u: u32) {
        let best = match self.candidates.get(&u) {
            None => None,
            Some(list) if list.is_empty() => None,
            Some(list) => {
                let mut t = &list[0];
                for i in &list[1..] {
                    let a = Self::strength(i) - Self::strength(t);
                    if a > 0.0 || (a == 0.0 && i.start >= t.start && i.cand > t.cand) {
                        t = i;
                    }
                }
                Some(t.clone())
            }
        };
        match best {
            None => {
                self.combat_buffs.shift_remove(&u);
            }
            Some(b) => {
                self.combat_buffs.insert(u, b);
            }
        }
    }

    #[inline]
    fn changed(a: Option<(f64, f64)>, b: Option<(f64, f64)>) -> bool {
        match (a, b) {
            (None, None) => false,
            (Some(x), Some(y)) => x.0 != y.0 || x.1 != y.1,
            _ => true,
        }
    }

    #[inline]
    fn eff(&self, u: u32) -> Option<(f64, f64)> {
        self.combat_buffs.get(&u).map(|b| (b.ratio, b.flat))
    }

    fn add_candidate(&mut self, t: &BuffTemplate, start: f64, permanent: bool) -> bool {
        let before = self.eff(t.unique);
        let b = Buff {
            unique: t.unique,
            typ: t.typ,
            ratio: t.ratio,
            flat: t.flat,
            duration: t.duration,
            start,
            permanent,
            cand: self.next_cand,
        };
        self.next_cand += 1;
        self.candidates.entry(t.unique).or_default().push(b);
        self.select_strongest(t.unique);
        Self::changed(before, self.eff(t.unique))
    }

    pub fn add_buffs(&mut self, list: &[BuffTemplate], time: f64) {
        let mut ch = false;
        for b in list {
            let a = self.add_candidate(b, time, false);
            ch = ch || a;
        }
        if ch {
            self.update();
        }
    }

    pub fn add_buff(&mut self, b: &BuffTemplate, time: f64) {
        if self.add_candidate(b, time, false) {
            self.update();
        }
    }

    pub fn replace_buff(&mut self, b: &BuffTemplate, time: f64) {
        let before = self.eff(b.unique);
        self.candidates.shift_remove(&b.unique);
        self.combat_buffs.shift_remove(&b.unique);
        self.add_candidate(b, time, false);
        if Self::changed(before, self.eff(b.unique)) {
            self.update();
        }
    }

    pub fn remove_buffs(&mut self, uniques: &[u32]) {
        let mut ch = false;
        for &u in uniques {
            let a = self.eff(u);
            self.candidates.shift_remove(&u);
            self.combat_buffs.shift_remove(&u);
            ch = ch || Self::changed(a, None);
        }
        if ch {
            self.update();
        }
    }

    pub fn remove_expired(&mut self, time: f64) {
        let mut ch = false;
        let keys: Vec<u32> = self.candidates.keys().copied().collect();
        for t in keys {
            let before = self.eff(t);
            let empty = {
                let list = self.candidates.get_mut(&t).unwrap();
                list.retain(|a| a.permanent || a.start + a.duration > time);
                list.is_empty()
            };
            if empty {
                self.candidates.shift_remove(&t);
            }
            self.select_strongest(t);
            ch = ch || Self::changed(before, self.eff(t));
        }
        if ch {
            self.update();
        }
    }

    pub fn add_permanent(&mut self, b: &PermBuff) {
        if let Some(p) = self.permanent.get_mut(&b.typ) {
            p.flat += b.flat;
            p.ratio += b.ratio;
        } else {
            self.permanent.insert(b.typ, b.clone());
        }
    }

    pub fn clear_buffs(&mut self) {
        self.combat_buffs.clear();
        self.candidates.clear();
        let perms: Vec<PermBuff> = self.permanent.values().cloned().collect();
        for p in perms {
            let t = BuffTemplate {
                unique: p.unique,
                typ: p.typ,
                ratio: p.ratio,
                flat: p.flat,
                duration: p.duration,
                has_multiplier_skill: false,
                multiplier_skill: None,
                multiplier_per_level: 0.0,
            };
            self.add_candidate(&t, f64::NEG_INFINITY, true);
        }
        self.update();
    }

    pub fn clear_ccs(&mut self) {
        self.stunned = false;
        self.stun_expire = None;
        self.silenced = false;
        self.silence_expire = None;
        self.blinded = false;
        self.blind_expire = None;
        self.s[DAMAGE_TAKEN] = 0.0;
    }

    /// Buffs of the types `updateCombatDetails` reads, bucketed by type in `combatBuffs`
    /// insertion order (the original re-filters the whole map per type; order is what matters
    /// for the floating-point sums).
    fn bucket(&self) -> Buckets {
        let mut b = Buckets::default();
        for x in self.combat_buffs.values() {
            let t = x.typ as usize;
            if t < N_BUCKETS {
                b.lists[t].push((x.ratio, x.flat));
            }
        }
        b
    }

    // ---- updateCombatDetails ----

    pub fn update(&mut self) {
        let _prof = crate::prof::start("unit.update");
        match &self.kind {
            Kind::Player(ps) => {
                self.style = ps.style;
                self.dtype = ps.dtype;
                self.s[ATTACK_INTERVAL] = ps.attack_interval;
                for &(i, v) in &ps.equip {
                    self.s[i] = v;
                }
                self.s[FOOD_SLOTS] = ps.food_slots;
                self.s[DRINK_SLOTS] = ps.drink_slots;
            }
            Kind::Monster {
                tpl,
                tier,
                room_level,
            } => {
                let tier = *tier;
                let i = 1.0 + 0.25 * tier;
                let a = 1.0 + 0.15 * tier;
                let n = 20.0 * tier;
                let o = *room_level / 100.0;
                for k in 0..7 {
                    let mult = if k == 4 { a } else { i };
                    self.base_level[k] = mult * (tpl.data_levels[k] + n) * o;
                }
                let s = 1.0 + 0.5 * tier;
                let l = 5.0 * tier;
                self.experience = s * (tpl.data_experience + l);
                self.style = tpl.style;
                for &(k, v) in &tpl.data_stats {
                    self.s[k] = v;
                }
                if let Some(dt) = tpl.dtype {
                    self.dtype = dt;
                }
                self.s[ARMOR] *= o;
                self.s[WATER_RESISTANCE] *= o;
                self.s[NATURE_RESISTANCE] *= o;
                self.s[FIRE_RESISTANCE] *= o;
                for &k in &tpl.zero_stats {
                    self.s[k] = 0.0;
                }
                if self.s[ATTACK_INTERVAL] == 0.0 {
                    self.s[ATTACK_INTERVAL] = tpl.data_attack_interval;
                }
            }
        }
        self.update_common();
    }

    fn update_common(&mut self) {
        let bk = self.bucket();
        if self.is_player {
            self.s[HP_REGEN] = if self.s[HP_REGEN] == 0.0 {
                0.01
            } else {
                0.01 + self.s[HP_REGEN]
            };
            self.s[MP_REGEN] = if self.s[MP_REGEN] == 0.0 {
                0.01
            } else {
                0.01 + self.s[MP_REGEN]
            };
        }
        for m in 0..7 {
            let base = self.base_level[m];
            let mut lv = base;
            for &(ratio, flat) in bk.list(bt::LEVEL0 + m as u32) {
                lv += base * ratio;
                lv += flat;
            }
            self.d.level[m] = lv;
        }
        let st = self.d.level[0];
        let int = self.d.level[1];
        let att = self.d.level[2];
        let mel = self.d.level[3];
        let def = self.d.level[4];
        let rng = self.d.level[5];
        let mag = self.d.level[6];
        let e = bk.boost(bt::MAX_HITPOINTS);
        let t = bk.boost(bt::MAX_MANAPOINTS);
        self.d.max_hp = ((10.0 * (10.0 + st) + self.s[MAX_HITPOINTS] + e.1)
            * (1.0 + self.s[MAX_HITPOINTS_RATIO] + e.0))
            .floor();
        self.d.max_mp = ((10.0 * (10.0 + int) + self.s[MAX_MANAPOINTS] + t.1)
            * (1.0 + self.s[MAX_MANAPOINTS_RATIO] + t.0))
            .floor();
        let i = bk.boost(bt::FURY_ACCURACY).0;
        let a = bk.boost(bt::FURY_DAMAGE).0;
        let n = bk.boost(bt::ACCURACY).0;
        let o = bk.boost(bt::DAMAGE).0;
        let melee_keys = [
            (IDX_STAB, STAB_ACCURACY, STAB_DAMAGE, STAB_EVASION),
            (IDX_SLASH, SLASH_ACCURACY, SLASH_DAMAGE, SLASH_EVASION),
            (IDX_SMASH, SMASH_ACCURACY, SMASH_DAMAGE, SMASH_EVASION),
        ];
        for (idx, ka, kd, ke) in melee_keys {
            self.d.acc[idx] = (10.0 + att) * (1.0 + self.s[ka]) * (1.0 + n) * (1.0 + i);
            self.d.max_dmg[idx] = (10.0 + mel) * (1.0 + self.s[kd]) * (1.0 + o) * (1.0 + a);
            let y = (10.0 + def) * (1.0 + self.s[ke]);
            let mut ev = y;
            for &(b_ratio, b_flat) in bk.list(bt::EVASION) {
                ev += b_flat;
                ev += y * b_ratio;
            }
            self.d.eva[idx] = ev;
        }
        self.d.defensive_max_damage =
            (10.0 + def) * (1.0 + self.s[DEFENSIVE_DAMAGE]) * (1.0 + o) * (1.0 + a);
        if let Kind::Player(ps) = &self.kind {
            if ps.bulwark {
                self.d.max_dmg[IDX_SMASH] += self.d.defensive_max_damage;
            }
        }
        self.d.acc[IDX_RANGED] =
            (10.0 + att) * (1.0 + self.s[RANGED_ACCURACY]) * (1.0 + n) * (1.0 + i);
        self.d.max_dmg[IDX_RANGED] =
            (10.0 + rng) * (1.0 + self.s[RANGED_DAMAGE]) * (1.0 + o) * (1.0 + a);
        let s = (10.0 + def) * (1.0 + self.s[RANGED_EVASION]);
        let mut ev = s;
        for &(b_ratio, b_flat) in bk.list(bt::EVASION) {
            ev += b_flat;
            ev += s * b_ratio;
        }
        self.d.eva[IDX_RANGED] = ev;
        self.s[DAMAGE_TAKEN] = bk.boost(bt::DAMAGE_TAKEN).1;
        self.d.acc[IDX_MAGIC] =
            (10.0 + att) * (1.0 + self.s[MAGIC_ACCURACY]) * (1.0 + n) * (1.0 + i);
        self.d.max_dmg[IDX_MAGIC] =
            (10.0 + mag) * (1.0 + self.s[MAGIC_DAMAGE]) * (1.0 + o) * (1.0 + a);
        let c = (10.0 + def) * (1.0 + self.s[MAGIC_EVASION]);
        let mut ev = c;
        for &(b_ratio, b_flat) in bk.list(bt::EVASION) {
            ev += b_flat;
            ev += c * b_ratio;
        }
        self.d.eva[IDX_MAGIC] = ev;
        self.s[PHYSICAL_AMPLIFY] += bk.boost(bt::PHYSICAL_AMPLIFY).1;
        self.s[WATER_AMPLIFY] += bk.boost(bt::WATER_AMPLIFY).1;
        self.s[NATURE_AMPLIFY] += bk.boost(bt::NATURE_AMPLIFY).1;
        self.s[FIRE_AMPLIFY] += bk.boost(bt::FIRE_AMPLIFY).1;
        self.s[HEALING_AMPLIFY] += bk.boost(bt::HEALING_AMPLIFY).1;
        self.s[ATTACK_INTERVAL] /= 1.0 + att / 2e3;
        let u = self.s[ATTACK_SPEED];
        self.s[ATTACK_INTERVAL] /= 1.0 + u;
        let mut g = 0.0;
        for &(b_ratio, b_flat) in bk.list(bt::ATTACK_SPEED) {
            g += b_ratio;
        }
        self.s[ATTACK_INTERVAL] /= 1.0 + g;
        let p = 0.2 * def + self.s[ARMOR];
        let mut v = p;
        for &(b_ratio, b_flat) in bk.list(bt::ARMOR) {
            v += b_flat;
            v += p * b_ratio;
        }
        self.d.total_armor = v;
        let h = 0.2 * def + self.s[WATER_RESISTANCE];
        let mut v = h;
        for &(b_ratio, b_flat) in bk.list(bt::WATER_RESISTANCE) {
            v += b_flat;
            v += h * b_ratio;
        }
        self.d.total_water_res = v;
        let k = 0.2 * def + self.s[NATURE_RESISTANCE];
        let mut v = k;
        for &(b_ratio, b_flat) in bk.list(bt::NATURE_RESISTANCE) {
            v += b_flat;
            v += k * b_ratio;
        }
        self.d.total_nature_res = v;
        let r = 0.2 * def + self.s[FIRE_RESISTANCE];
        let mut v = r;
        for &(b_ratio, b_flat) in bk.list(bt::FIRE_RESISTANCE) {
            v += b_flat;
            v += r * b_ratio;
        }
        self.d.total_fire_res = v;
        let nb = bk.boost(bt::HP_REGEN);
        self.s[HP_REGEN] += self.s[HP_REGEN] * nb.0;
        self.s[HP_REGEN] += nb.1;
        let jb = bk.boost(bt::MP_REGEN);
        self.s[MP_REGEN] += self.s[MP_REGEN] * jb.0;
        self.s[MP_REGEN] += jb.1;
        self.s[LIFE_STEAL] += bk.boost(bt::LIFE_STEAL).1;
        self.s[PHYSICAL_THORNS] += bk.boost(bt::PHYSICAL_THORNS).1;
        self.s[ELEMENTAL_THORNS] += bk.boost(bt::ELEMENTAL_THORNS).1;
        self.s[COMBAT_EXPERIENCE] += bk.boost(bt::WISDOM).1;
        self.s[CRITICAL_RATE] += bk.boost(bt::CRITICAL_RATE).1;
        self.s[CRITICAL_DAMAGE] += bk.boost(bt::CRITICAL_DAMAGE).1;
        self.s[CAST_SPEED] += bk.boost(bt::CAST_SPEED).1;
        self.s[CAST_SPEED] += att / 2e3;
        let j = bk.boost(bt::COMBAT_DROP_RATE);
        self.s[COMBAT_DROP_RATE] += (1.0 + self.s[COMBAT_DROP_RATE]) * j.0;
        self.s[COMBAT_DROP_RATE] += j.1;
        let ub = bk.boost(bt::RARE_FIND);
        self.s[COMBAT_RARE_FIND] += (1.0 + self.s[COMBAT_RARE_FIND]) * ub.0;
        self.s[COMBAT_RARE_FIND] += ub.1;
        let z = bk.boost(bt::COMBAT_DROP_QUANTITY);
        self.s[COMBAT_DROP_QUANTITY] += (1.0 + self.s[COMBAT_DROP_QUANTITY]) * z.0;
        self.s[COMBAT_DROP_QUANTITY] += z.1;
        let q = 100.0 + self.s[THREAT];
        self.d.total_threat = q;
        let pb = bk.boost(bt::THREAT);
        if pb.0 != 0.0 {
            self.s[THREAT] += q * pb.0;
        } else {
            self.s[THREAT] = q;
        }
        self.s[THREAT] += pb.1;
        self.s[RETALIATION] += bk.boost(bt::RETALIATION).1;
        self.s[TENACITY] += bk.boost(bt::TENACITY).1;
    }

    // ---- misc ----

    /// `combatStats.combatStyleHrid` (monsters that were never updated keep the default).
    pub fn style_hrid(&self) -> &str {
        match &self.kind {
            Kind::Player(ps) => &ps.style_hrid,
            Kind::Monster { tpl, .. } => &tpl.style_hrid,
        }
    }

    pub fn add_hp(&mut self, e: f64) -> f64 {
        if self.d.hp >= self.d.max_hp {
            return 0.0;
        }
        let i = js::min(self.d.hp + e, self.d.max_hp);
        let t = i - self.d.hp;
        self.d.hp = i;
        t
    }

    pub fn add_mp(&mut self, e: f64) -> f64 {
        if self.d.mp >= self.d.max_mp {
            return 0.0;
        }
        let i = js::min(self.d.mp + e, self.d.max_mp);
        let t = i - self.d.mp;
        self.d.mp = i;
        t
    }

    pub fn reset_cooldowns(&mut self, e: f64, rng: &mut js::Rng) {
        for f in self.food.iter_mut().flatten() {
            f.last_used = MIN_SAFE_INTEGER;
        }
        for f in self.drinks.iter_mut().flatten() {
            f.last_used = MIN_SAFE_INTEGER;
        }
        let t = self.s[ABILITY_HASTE];
        let is_player = self.is_player;
        for ab in self.abilities.iter_mut().flatten() {
            if is_player {
                ab.last_used = MIN_SAFE_INTEGER;
            } else {
                let mut a = ab.def.cooldown;
                if t > 0.0 {
                    a = (a * 100.0) / (100.0 + t);
                }
                ab.last_used = e - (a * 0.5).floor() + (rng.next() * a * 0.5).floor();
            }
        }
    }

    /// `reset(e)`
    pub fn reset(&mut self, e: f64, rng: &mut js::Rng) {
        let _prof = crate::prof::start("unit.reset");
        self.clear_ccs();
        if e == 0.0 || !self.is_player {
            self.clear_buffs();
            self.update();
            self.reset_cooldowns(e, rng);
        } else {
            self.remove_expired(e);
            self.update();
        }
        self.d.hp = self.d.max_hp;
        self.d.mp = self.d.max_mp;
    }
}

pub const MIN_SAFE_INTEGER: f64 = -9007199254740991.0;

const N_BUCKETS: usize = 40;

struct Buckets {
    lists: [smallvec::SmallVec<[(f64, f64); 2]>; N_BUCKETS],
}

impl Default for Buckets {
    fn default() -> Self {
        Buckets {
            lists: std::array::from_fn(|_| smallvec::SmallVec::new()),
        }
    }
}

impl Buckets {
    #[inline]
    fn list(&self, typ: u32) -> &[(f64, f64)] {
        &self.lists[typ as usize]
    }
    /// `getBuffBoost(type)`
    #[inline]
    fn boost(&self, typ: u32) -> (f64, f64) {
        let mut r = 0.0;
        let mut f = 0.0;
        for &(a, b) in self.list(typ) {
            r += a;
            f += b;
        }
        (r, f)
    }
}
