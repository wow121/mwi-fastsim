//! Numeric combat stats, stored in a flat array indexed by the constants below.

macro_rules! stats {
    ($($idx:expr, $name:ident, $js:literal);* $(;)?) => {
        $(pub const $name: usize = $idx;)*
        pub const STAT_NAMES: &[&str] = &[$($js),*];
    };
}

stats! {
    0, ATTACK_INTERVAL, "attackInterval";
    1, AUTO_ATTACK_DAMAGE, "autoAttackDamage";
    2, ABILITY_DAMAGE, "abilityDamage";
    3, CRITICAL_RATE, "criticalRate";
    4, CRITICAL_DAMAGE, "criticalDamage";
    5, STAB_ACCURACY, "stabAccuracy";
    6, SLASH_ACCURACY, "slashAccuracy";
    7, SMASH_ACCURACY, "smashAccuracy";
    8, RANGED_ACCURACY, "rangedAccuracy";
    9, MAGIC_ACCURACY, "magicAccuracy";
    10, STAB_DAMAGE, "stabDamage";
    11, SLASH_DAMAGE, "slashDamage";
    12, SMASH_DAMAGE, "smashDamage";
    13, RANGED_DAMAGE, "rangedDamage";
    14, MAGIC_DAMAGE, "magicDamage";
    15, DEFENSIVE_DAMAGE, "defensiveDamage";
    16, TASK_DAMAGE, "taskDamage";
    17, PHYSICAL_AMPLIFY, "physicalAmplify";
    18, WATER_AMPLIFY, "waterAmplify";
    19, NATURE_AMPLIFY, "natureAmplify";
    20, FIRE_AMPLIFY, "fireAmplify";
    21, HEALING_AMPLIFY, "healingAmplify";
    22, PHYSICAL_THORNS, "physicalThorns";
    23, ELEMENTAL_THORNS, "elementalThorns";
    24, MAX_HITPOINTS, "maxHitpoints";
    25, MAX_MANAPOINTS, "maxManapoints";
    26, STAB_EVASION, "stabEvasion";
    27, SLASH_EVASION, "slashEvasion";
    28, SMASH_EVASION, "smashEvasion";
    29, RANGED_EVASION, "rangedEvasion";
    30, MAGIC_EVASION, "magicEvasion";
    31, ARMOR, "armor";
    32, WATER_RESISTANCE, "waterResistance";
    33, NATURE_RESISTANCE, "natureResistance";
    34, FIRE_RESISTANCE, "fireResistance";
    35, LIFE_STEAL, "lifeSteal";
    36, HP_REGEN, "hpRegenPer10";
    37, MP_REGEN, "mpRegenPer10";
    38, COMBAT_DROP_RATE, "combatDropRate";
    39, COMBAT_DROP_QUANTITY, "combatDropQuantity";
    40, COMBAT_RARE_FIND, "combatRareFind";
    41, COMBAT_EXPERIENCE, "combatExperience";
    42, FOOD_SLOTS, "foodSlots";
    43, DRINK_SLOTS, "drinkSlots";
    44, ARMOR_PENETRATION, "armorPenetration";
    45, WATER_PENETRATION, "waterPenetration";
    46, NATURE_PENETRATION, "naturePenetration";
    47, FIRE_PENETRATION, "firePenetration";
    48, MANA_LEECH, "manaLeech";
    49, CAST_SPEED, "castSpeed";
    50, THREAT, "threat";
    51, PARRY, "parry";
    52, MAYHEM, "mayhem";
    53, PIERCE, "pierce";
    54, CURSE, "curse";
    55, RIPPLE, "ripple";
    56, BLOOM, "bloom";
    57, BLAZE, "blaze";
    58, WEAKEN, "weaken";
    59, FURY, "fury";
    60, FOOD_HASTE, "foodHaste";
    61, DRINK_CONCENTRATION, "drinkConcentration";
    62, DAMAGE_TAKEN, "damageTaken";
    63, ATTACK_SPEED, "attackSpeed";
    64, ARMOR_DAMAGE_RATIO, "armorDamageRatio";
    65, HP_DRAIN_RATIO, "hpDrainRatio";
    66, STAMINA_EXPERIENCE, "staminaExperience";
    67, INTELLIGENCE_EXPERIENCE, "intelligenceExperience";
    68, ATTACK_EXPERIENCE, "attackExperience";
    69, DEFENSE_EXPERIENCE, "defenseExperience";
    70, MELEE_EXPERIENCE, "meleeExperience";
    71, RANGED_EXPERIENCE, "rangedExperience";
    72, MAGIC_EXPERIENCE, "magicExperience";
    73, RETALIATION, "retaliation";
    74, MAX_HITPOINTS_RATIO, "maxHitpointsRatio";
    75, MAX_MANAPOINTS_RATIO, "maxManapointsRatio";
    76, ABILITY_HASTE, "abilityHaste";
    77, TENACITY, "tenacity";
}

pub const N_STATS: usize = 78;

pub fn stat_index(name: &str) -> Option<usize> {
    STAT_NAMES.iter().position(|n| *n == name)
}

/// Defaults of `combatDetails.combatStats` in the unit constructor. `abilityHaste` and
/// `tenacity` are absent there (undefined), which behaves like NaN in arithmetic.
pub fn default_stats() -> [f64; N_STATS] {
    let mut s = [0.0; N_STATS];
    s[ATTACK_INTERVAL] = 3e9;
    s[HP_REGEN] = 0.01;
    s[MP_REGEN] = 0.01;
    s[FOOD_SLOTS] = 1.0;
    s[DRINK_SLOTS] = 1.0;
    s[THREAT] = 100.0;
    s[ABILITY_HASTE] = f64::NAN;
    s[TENACITY] = f64::NAN;
    s
}

/// Keys the player recomputes from equipment on every `updateCombatDetails`.
pub const PLAYER_EQUIP_KEYS: &[&str] = &[
    "stabAccuracy", "slashAccuracy", "smashAccuracy", "rangedAccuracy", "magicAccuracy",
    "stabDamage", "slashDamage", "smashDamage", "rangedDamage", "magicDamage",
    "defensiveDamage", "taskDamage", "physicalAmplify", "waterAmplify", "natureAmplify",
    "fireAmplify", "healingAmplify", "stabEvasion", "slashEvasion", "smashEvasion",
    "rangedEvasion", "magicEvasion", "armor", "waterResistance", "natureResistance",
    "fireResistance", "maxHitpoints", "maxManapoints", "lifeSteal", "hpRegenPer10",
    "mpRegenPer10", "physicalThorns", "elementalThorns", "combatDropRate", "combatRareFind",
    "combatDropQuantity", "combatExperience", "criticalRate", "criticalDamage",
    "armorPenetration", "waterPenetration", "naturePenetration", "firePenetration",
    "abilityHaste", "tenacity", "manaLeech", "castSpeed", "threat", "parry", "mayhem",
    "pierce", "curse", "fury", "weaken", "ripple", "bloom", "blaze", "attackSpeed",
    "foodHaste", "drinkConcentration", "autoAttackDamage", "abilityDamage",
    "staminaExperience", "intelligenceExperience", "attackExperience", "defenseExperience",
    "meleeExperience", "rangedExperience", "magicExperience", "retaliation",
];

/// Keys the monster zeroes when its data does not define them.
pub const MONSTER_ZERO_KEYS: &[&str] = &[
    "stabAccuracy", "slashAccuracy", "smashAccuracy", "rangedAccuracy", "magicAccuracy",
    "stabDamage", "slashDamage", "smashDamage", "rangedDamage", "magicDamage",
    "defensiveDamage", "taskDamage", "physicalAmplify", "waterAmplify", "natureAmplify",
    "fireAmplify", "healingAmplify", "stabEvasion", "slashEvasion", "smashEvasion",
    "rangedEvasion", "magicEvasion", "armor", "waterResistance", "natureResistance",
    "fireResistance", "maxHitpoints", "maxManapoints", "lifeSteal", "hpRegenPer10",
    "mpRegenPer10", "physicalThorns", "elementalThorns", "combatDropRate", "combatRareFind",
    "combatDropQuantity", "combatExperience", "criticalRate", "criticalDamage",
    "armorPenetration", "waterPenetration", "naturePenetration", "firePenetration",
    "abilityHaste", "tenacity", "manaLeech", "castSpeed", "threat", "parry", "mayhem",
    "pierce", "curse", "fury", "weaken", "ripple", "bloom", "blaze", "attackSpeed",
    "foodHaste", "drinkConcentration", "autoAttackDamage", "abilityDamage", "retaliation",
];
