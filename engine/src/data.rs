//! Game data (shared, read-only) and per-simulation definitions built from it.

use serde_json::Value;
use std::collections::HashMap;

/// Reads a JS-ish number: missing -> NaN (undefined), null -> 0, bool -> 0/1.
pub fn num(v: &Value, key: &str) -> f64 {
    match v.get(key) {
        None => f64::NAN,
        Some(x) => to_num(x),
    }
}

pub fn to_num(x: &Value) -> f64 {
    match x {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

pub fn string(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Game data needed by the engine, exported by `node/compile.mjs` from the site's worker
/// after any game-data envelope has been applied.
pub struct GameData {
    pub abilities: HashMap<String, Value>,
    pub ability_aliases: HashMap<String, String>,
    pub monsters: HashMap<String, Value>,
    /// combat style hrid -> ordered skill hrids of its `skillExpMap` (null => None)
    pub skill_exp_maps: HashMap<String, Option<Vec<String>>>,
    pub single_target_deps: HashMap<String, bool>,
}

impl GameData {
    pub fn from_json(v: &Value) -> Result<GameData, String> {
        let obj = |k: &str| -> Result<&serde_json::Map<String, Value>, String> {
            v.get(k)
                .and_then(|x| x.as_object())
                .ok_or_else(|| format!("gamedata missing {}", k))
        };
        let abilities = obj("abilities")?
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let ability_aliases = obj("abilityAliases")?
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect();
        let monsters = obj("monsters")?
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut skill_exp_maps = HashMap::new();
        for (k, st) in obj("combatStyles")? {
            let m = match st.get("skillExpMap") {
                Some(Value::Object(m)) => Some(m.keys().cloned().collect()),
                _ => None,
            };
            skill_exp_maps.insert(k.clone(), m);
        }
        let mut single_target_deps = HashMap::new();
        for (k, d) in obj("triggerDependencies")? {
            single_target_deps.insert(
                k.clone(),
                d.get("isSingleTarget").and_then(|x| x.as_bool()).unwrap_or(false),
            );
        }
        Ok(GameData {
            abilities,
            ability_aliases,
            monsters,
            skill_exp_maps,
            single_target_deps,
        })
    }

    /// `Gt(hrid)`: resolve aliases, then look the ability up.
    pub fn ability(&self, hrid: &str) -> Option<&Value> {
        let key = self
            .ability_aliases
            .get(hrid)
            .map(|s| s.as_str())
            .unwrap_or(hrid);
        if key.is_empty() {
            return None;
        }
        self.abilities.get(key)
    }
}

#[derive(Default)]
pub struct Interner {
    map: HashMap<String, u32>,
    pub names: Vec<String>,
    /// bit k set when the name starts with `/buff_uniques/<PREFIX_BUFF_CONDS[k]>`
    pub prefix_mask: Vec<u32>,
}

impl Interner {
    pub fn id(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.map.get(s) {
            return i;
        }
        let i = self.names.len() as u32;
        let mut mask = 0u32;
        if let Some(rest) = s.strip_prefix("/buff_uniques/") {
            for (k, p) in PREFIX_BUFF_CONDS.iter().enumerate() {
                if rest.starts_with(p) {
                    mask |= 1 << k;
                }
            }
        }
        self.names.push(s.to_string());
        self.prefix_mask.push(mask);
        self.map.insert(s.to_string(), i);
        i
    }
    pub fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }
    pub fn name(&self, i: u32) -> &str {
        &self.names[i as usize]
    }
}

/// Buff types the engine reads directly; interned first so their ids are these constants.
pub const BUFF_TYPE_NAMES: &[&str] = &[
    "/buff_types/stamina_level",
    "/buff_types/intelligence_level",
    "/buff_types/attack_level",
    "/buff_types/melee_level",
    "/buff_types/defense_level",
    "/buff_types/ranged_level",
    "/buff_types/magic_level",
    "/buff_types/max_hitpoints",
    "/buff_types/max_manapoints",
    "/buff_types/fury_accuracy",
    "/buff_types/fury_damage",
    "/buff_types/accuracy",
    "/buff_types/damage",
    "/buff_types/evasion",
    "/buff_types/damage_taken",
    "/buff_types/physical_amplify",
    "/buff_types/water_amplify",
    "/buff_types/nature_amplify",
    "/buff_types/fire_amplify",
    "/buff_types/healing_amplify",
    "/buff_types/attack_speed",
    "/buff_types/armor",
    "/buff_types/water_resistance",
    "/buff_types/nature_resistance",
    "/buff_types/fire_resistance",
    "/buff_types/hp_regen",
    "/buff_types/mp_regen",
    "/buff_types/life_steal",
    "/buff_types/physical_thorns",
    "/buff_types/elemental_thorns",
    "/buff_types/wisdom",
    "/buff_types/critical_rate",
    "/buff_types/critical_damage",
    "/buff_types/cast_speed",
    "/buff_types/combat_drop_rate",
    "/buff_types/rare_find",
    "/buff_types/combat_drop_quantity",
    "/buff_types/threat",
    "/buff_types/retaliation",
    "/buff_types/tenacity",
];

pub mod bt {
    pub const LEVEL0: u32 = 0; // stamina..magic = 0..6
    pub const MAX_HITPOINTS: u32 = 7;
    pub const MAX_MANAPOINTS: u32 = 8;
    pub const FURY_ACCURACY: u32 = 9;
    pub const FURY_DAMAGE: u32 = 10;
    pub const ACCURACY: u32 = 11;
    pub const DAMAGE: u32 = 12;
    pub const EVASION: u32 = 13;
    pub const DAMAGE_TAKEN: u32 = 14;
    pub const PHYSICAL_AMPLIFY: u32 = 15;
    pub const WATER_AMPLIFY: u32 = 16;
    pub const NATURE_AMPLIFY: u32 = 17;
    pub const FIRE_AMPLIFY: u32 = 18;
    pub const HEALING_AMPLIFY: u32 = 19;
    pub const ATTACK_SPEED: u32 = 20;
    pub const ARMOR: u32 = 21;
    pub const WATER_RESISTANCE: u32 = 22;
    pub const NATURE_RESISTANCE: u32 = 23;
    pub const FIRE_RESISTANCE: u32 = 24;
    pub const HP_REGEN: u32 = 25;
    pub const MP_REGEN: u32 = 26;
    pub const LIFE_STEAL: u32 = 27;
    pub const PHYSICAL_THORNS: u32 = 28;
    pub const ELEMENTAL_THORNS: u32 = 29;
    pub const WISDOM: u32 = 30;
    pub const CRITICAL_RATE: u32 = 31;
    pub const CRITICAL_DAMAGE: u32 = 32;
    pub const CAST_SPEED: u32 = 33;
    pub const COMBAT_DROP_RATE: u32 = 34;
    pub const RARE_FIND: u32 = 35;
    pub const COMBAT_DROP_QUANTITY: u32 = 36;
    pub const THREAT: u32 = 37;
    pub const RETALIATION: u32 = 38;
    pub const TENACITY: u32 = 39;
}

pub const SKILLS: [&str; 7] = [
    "stamina",
    "intelligence",
    "attack",
    "melee",
    "defense",
    "ranged",
    "magic",
];

pub fn skill_index(name: &str) -> Option<usize> {
    SKILLS.iter().position(|s| *s == name)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    Stab,
    Slash,
    Smash,
    Ranged,
    Magic,
    Other,
}

impl Style {
    pub fn parse(s: &str) -> Style {
        match s {
            "/combat_styles/stab" => Style::Stab,
            "/combat_styles/slash" => Style::Slash,
            "/combat_styles/smash" => Style::Smash,
            "/combat_styles/ranged" => Style::Ranged,
            "/combat_styles/magic" => Style::Magic,
            _ => Style::Other,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DType {
    Physical,
    Water,
    Nature,
    Fire,
    Other,
}

impl DType {
    pub fn parse(s: &str) -> DType {
        match s {
            "/damage_types/physical" => DType::Physical,
            "/damage_types/water" => DType::Water,
            "/damage_types/nature" => DType::Nature,
            "/damage_types/fire" => DType::Fire,
            _ => DType::Other,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BuffTemplate {
    pub unique: u32,
    pub typ: u32,
    pub ratio: f64,
    pub flat: f64,
    pub duration: f64,
    /// `multiplierForSkillHrid` is a non-empty string
    pub has_multiplier_skill: bool,
    /// index into SKILLS when the hrid names one of them
    pub multiplier_skill: Option<usize>,
    pub multiplier_per_level: f64,
}

impl BuffTemplate {
    /// `new G(def, level)`
    pub fn from_def(def: &Value, level: f64, it: &mut Interner) -> BuffTemplate {
        let unique = it.id(&string(def, "uniqueHrid"));
        let typ = it.id(&string(def, "typeHrid"));
        let ratio = num(def, "ratioBoost") + (level - 1.0) * num(def, "ratioBoostLevelBonus");
        let flat = num(def, "flatBoost") + (level - 1.0) * num(def, "flatBoostLevelBonus");
        let duration = num(def, "duration");
        let mskill = match def.get("multiplierForSkillHrid") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        let mper = match def.get("multiplierPerSkillLevel") {
            None | Some(Value::Null) => 0.0,
            Some(x) => to_num(x),
        };
        BuffTemplate {
            unique,
            typ,
            ratio,
            flat,
            duration,
            has_multiplier_skill: !mskill.is_empty(),
            multiplier_skill: mskill.split('/').nth(2).and_then(skill_index),
            multiplier_per_level: mper,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    Enemy,
    AllEnemies,
    AllAllies,
    SelfT,
    LowestHpAlly,
    DeadAlly,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EffectKind {
    Buff,
    Damage,
    Heal,
    SpendHp,
    Revive,
    Promote,
    Other,
}

#[derive(Clone, Debug)]
pub struct Effect {
    pub target: Target,
    pub kind: EffectKind,
    pub style: Style,
    pub style_is_magic: bool,
    pub dtype: DType,
    pub damage_flat: f64,
    pub damage_ratio: f64,
    pub bonus_accuracy_ratio: f64,
    pub dot_ratio: f64,
    pub dot_duration: f64,
    pub armor_damage_ratio: f64,
    pub hp_drain_ratio: f64,
    pub pierce_chance: f64,
    pub blind_chance: f64,
    pub blind_duration: f64,
    pub silence_chance: f64,
    pub silence_duration: f64,
    pub stun_chance: f64,
    pub stun_duration: f64,
    pub spend_hp_ratio: f64,
    pub buffs: Option<Vec<BuffTemplate>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dep {
    SelfDep,
    TargetedEnemy,
    AllAllies,
    AllEnemies,
    Unknown,
}

#[derive(Clone, Debug)]
pub enum Cond {
    BuffExact(u32),
    /// index into PREFIX_BUFF_CONDS
    BuffPrefix(u32),
    CurrentHp,
    CurrentMp,
    MissingHp,
    MissingMp,
    StunStatus,
    BlindStatus,
    SilenceStatus,
    NumberOfActiveUnits,
    NumberOfDeadUnits,
    LowestHpPercentage,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cmp {
    Gte,
    Lte,
    IsActive,
    IsInactive,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct Trigger {
    pub single_target: bool,
    pub dep: Dep,
    pub cond: Cond,
    pub cmp: Cmp,
    pub value: f64,
}

const EXACT_BUFF_CONDS: &[&str] = &[
    "berserk", "frenzy", "precision", "vampirism", "attack_coffee", "defense_coffee",
    "lucky_coffee", "magic_coffee", "melee_coffee", "ranged_coffee", "swiftness_coffee",
    "wisdom_coffee", "ice_spear", "puncture", "frost_surge", "elusiveness", "channeling_coffee",
    "fierce_aura", "invincible_armor", "invincible_fire_resistance",
    "invincible_nature_resistance", "invincible_water_resistance", "provoke", "taunt",
    "crippling_slash", "mana_spring", "retribution", "fracturing_impact", "maim", "curse",
    "weaken",
];

pub const PREFIX_BUFF_CONDS: &[&str] = &[
    "critical_aura", "critical_coffee", "intelligence_coffee", "stamina_coffee",
    "elemental_affinity", "fury", "guardian_aura", "insanity", "spike_shell", "toxic_pollen",
    "invincible", "mystic_aura", "pestilent_shot", "smoke_burst", "speed_aura", "toughness",
    "enrage",
];

impl Trigger {
    /// `oe.createFromDTO`; `value` goes through JS relational comparison, so coerce to number
    /// (undefined -> constructor default 0, null -> 0).
    pub fn from_def(def: &Value, gd: &GameData, it: &mut Interner) -> Trigger {
        let dep_s = string(def, "dependencyHrid");
        let cond_s = string(def, "conditionHrid");
        let cmp_s = string(def, "comparatorHrid");
        let value = match def.get("value") {
            None => 0.0,
            Some(x) => to_num(x),
        };
        let dep = match dep_s.as_str() {
            "/combat_trigger_dependencies/self" => Dep::SelfDep,
            "/combat_trigger_dependencies/targeted_enemy" => Dep::TargetedEnemy,
            "/combat_trigger_dependencies/all_allies" => Dep::AllAllies,
            "/combat_trigger_dependencies/all_enemies" => Dep::AllEnemies,
            _ => Dep::Unknown,
        };
        let single_target = gd.single_target_deps.get(&dep_s).copied().unwrap_or(false);
        let suffix = cond_s.rsplit('/').next().unwrap_or("");
        let cond = if cond_s.starts_with("/combat_trigger_conditions/")
            && EXACT_BUFF_CONDS.contains(&suffix)
        {
            Cond::BuffExact(it.id(&format!("/buff_uniques/{}", suffix)))
        } else if cond_s.starts_with("/combat_trigger_conditions/")
            && PREFIX_BUFF_CONDS.contains(&suffix)
        {
            Cond::BuffPrefix(PREFIX_BUFF_CONDS.iter().position(|p| *p == suffix).unwrap() as u32)
        } else {
            match cond_s.as_str() {
                "/combat_trigger_conditions/current_hp" => Cond::CurrentHp,
                "/combat_trigger_conditions/current_mp" => Cond::CurrentMp,
                "/combat_trigger_conditions/missing_hp" => Cond::MissingHp,
                "/combat_trigger_conditions/missing_mp" => Cond::MissingMp,
                "/combat_trigger_conditions/stun_status" => Cond::StunStatus,
                "/combat_trigger_conditions/blind_status" => Cond::BlindStatus,
                "/combat_trigger_conditions/silence_status" => Cond::SilenceStatus,
                "/combat_trigger_conditions/number_of_active_units" => Cond::NumberOfActiveUnits,
                "/combat_trigger_conditions/number_of_dead_units" => Cond::NumberOfDeadUnits,
                "/combat_trigger_conditions/lowest_hp_percentage" => Cond::LowestHpPercentage,
                _ => Cond::Unknown,
            }
        };
        let cmp = match cmp_s.as_str() {
            "/combat_trigger_comparators/greater_than_equal" => Cmp::Gte,
            "/combat_trigger_comparators/less_than_equal" => Cmp::Lte,
            "/combat_trigger_comparators/is_active" => Cmp::IsActive,
            "/combat_trigger_comparators/is_inactive" => Cmp::IsInactive,
            _ => Cmp::Unknown,
        };
        Trigger {
            single_target,
            dep,
            cond,
            cmp,
            value,
        }
    }
}

/// Level-dependent part of an ability (`new se(hrid, level)` minus triggers / lastUsed).
pub struct AbilityDef {
    pub hrid: std::rc::Rc<str>,
    pub hid: u32,
    pub mana_cost: f64,
    pub cooldown: f64,
    pub cast: f64,
    pub is_special: bool,
    pub effects: Vec<Effect>,
    pub default_triggers: Vec<Trigger>,
}

fn target_of(s: &str) -> Target {
    match s {
        "enemy" => Target::Enemy,
        "allEnemies" => Target::AllEnemies,
        "allAllies" => Target::AllAllies,
        "self" => Target::SelfT,
        "lowestHpAlly" => Target::LowestHpAlly,
        "deadAlly" => Target::DeadAlly,
        _ => Target::Other,
    }
}

fn effect_kind_of(s: &str) -> EffectKind {
    match s {
        "/ability_effect_types/buff" => EffectKind::Buff,
        "/ability_effect_types/damage" => EffectKind::Damage,
        "/ability_effect_types/heal" => EffectKind::Heal,
        "/ability_effect_types/spend_hp" => EffectKind::SpendHp,
        "/ability_effect_types/revive" => EffectKind::Revive,
        "/ability_effect_types/promote" => EffectKind::Promote,
        _ => EffectKind::Other,
    }
}

impl AbilityDef {
    pub fn build(
        hrid: &str,
        level: f64,
        gd: &GameData,
        it: &mut Interner,
    ) -> Result<AbilityDef, String> {
        let a = gd
            .ability(hrid)
            .ok_or_else(|| format!("No ability found for hrid: {}", hrid))?;
        let lm1 = level - 1.0;
        let mut effects = Vec::new();
        if let Some(Value::Array(list)) = a.get("abilityEffects") {
            for n in list {
                let buffs = match n.get("buffs") {
                    Some(Value::Array(bs)) => Some(
                        bs.iter()
                            .map(|b| BuffTemplate::from_def(b, level, it))
                            .collect(),
                    ),
                    _ => None,
                };
                let style_s = string(n, "combatStyleHrid");
                effects.push(Effect {
                    target: target_of(&string(n, "targetType")),
                    kind: effect_kind_of(&string(n, "effectType")),
                    style: Style::parse(&style_s),
                    style_is_magic: style_s == "/combat_styles/magic",
                    dtype: DType::parse(&string(n, "damageType")),
                    damage_flat: num(n, "baseDamageFlat") + lm1 * num(n, "baseDamageFlatLevelBonus"),
                    damage_ratio: num(n, "baseDamageRatio")
                        + lm1 * num(n, "baseDamageRatioLevelBonus"),
                    bonus_accuracy_ratio: num(n, "bonusAccuracyRatio")
                        + lm1 * num(n, "bonusAccuracyRatioLevelBonus"),
                    dot_ratio: num(n, "damageOverTimeRatio"),
                    dot_duration: num(n, "damageOverTimeDuration"),
                    armor_damage_ratio: num(n, "armorDamageRatio")
                        + lm1 * num(n, "armorDamageRatioLevelBonus"),
                    hp_drain_ratio: num(n, "hpDrainRatio"),
                    pierce_chance: num(n, "pierceChance"),
                    blind_chance: num(n, "blindChance"),
                    blind_duration: num(n, "blindDuration"),
                    silence_chance: num(n, "silenceChance"),
                    silence_duration: num(n, "silenceDuration"),
                    stun_chance: num(n, "stunChance"),
                    stun_duration: num(n, "stunDuration"),
                    spend_hp_ratio: num(n, "spendHpRatio"),
                    buffs,
                });
            }
        }
        let mut default_triggers = Vec::new();
        if let Some(Value::Array(list)) = a.get("defaultCombatTriggers") {
            for t in list {
                default_triggers.push(Trigger::from_def(t, gd, it));
            }
        }
        Ok(AbilityDef {
            hid: it.id(hrid),
            hrid: std::rc::Rc::from(hrid),
            mana_cost: num(a, "manaCost"),
            cooldown: num(a, "cooldownDuration"),
            cast: num(a, "castDuration"),
            is_special: matches!(a.get("isSpecialAbility"), Some(Value::Bool(true))),
            effects,
            default_triggers,
        })
    }
}
