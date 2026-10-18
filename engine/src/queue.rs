//! Event queue ordered by (time, sequence) — a strict total order, so the pop order is the
//! same as the original binary heap regardless of its internal layout.

use crate::js;
use crate::unit::UnitId;

#[derive(Clone, Debug)]
pub enum Ev {
    CombatStart,
    PlayerRespawn { hrid: u32 },
    EnemyRespawn,
    AutoAttack { source: UnitId },
    ConsumableTick { source: UnitId, drink: bool, slot: usize, total: f64, current: f64 },
    Dot { source_ref: UnitId, target: UnitId, damage: f64, total: f64, current: f64 },
    CheckBuffExpiration { source: UnitId },
    RegenTick,
    StunExp { source: UnitId },
    BlindExp { source: UnitId },
    SilenceExp { source: UnitId },
    CurseExp { amount: f64, source: UnitId },
    WeakenExp { amount: f64, source: UnitId },
    FuryExp { amount: f64, source: UnitId },
    EnrageTick { encounter_time: f64 },
    CastEnd { source: UnitId, slot: usize },
    AwaitCooldown { source: UnitId },
    CooldownReady,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EvType {
    CombatStart,
    PlayerRespawn,
    EnemyRespawn,
    AutoAttack,
    ConsumableTick,
    Dot,
    CheckBuffExpiration,
    RegenTick,
    StunExp,
    BlindExp,
    SilenceExp,
    CurseExp,
    WeakenExp,
    FuryExp,
    EnrageTick,
    CastEnd,
    AwaitCooldown,
    CooldownReady,
}

impl Ev {
    #[inline]
    pub fn ty(&self) -> EvType {
        match self {
            Ev::CombatStart => EvType::CombatStart,
            Ev::PlayerRespawn { .. } => EvType::PlayerRespawn,
            Ev::EnemyRespawn => EvType::EnemyRespawn,
            Ev::AutoAttack { .. } => EvType::AutoAttack,
            Ev::ConsumableTick { .. } => EvType::ConsumableTick,
            Ev::Dot { .. } => EvType::Dot,
            Ev::CheckBuffExpiration { .. } => EvType::CheckBuffExpiration,
            Ev::RegenTick => EvType::RegenTick,
            Ev::StunExp { .. } => EvType::StunExp,
            Ev::BlindExp { .. } => EvType::BlindExp,
            Ev::SilenceExp { .. } => EvType::SilenceExp,
            Ev::CurseExp { .. } => EvType::CurseExp,
            Ev::WeakenExp { .. } => EvType::WeakenExp,
            Ev::FuryExp { .. } => EvType::FuryExp,
            Ev::EnrageTick { .. } => EvType::EnrageTick,
            Ev::CastEnd { .. } => EvType::CastEnd,
            Ev::AwaitCooldown { .. } => EvType::AwaitCooldown,
            Ev::CooldownReady => EvType::CooldownReady,
        }
    }

    /// The event's `source` property (DOT events only have `sourceRef`, which does not count).
    #[inline]
    pub fn source(&self) -> Option<UnitId> {
        match *self {
            Ev::AutoAttack { source }
            | Ev::ConsumableTick { source, .. }
            | Ev::CheckBuffExpiration { source }
            | Ev::StunExp { source }
            | Ev::BlindExp { source }
            | Ev::SilenceExp { source }
            | Ev::CurseExp { source, .. }
            | Ev::WeakenExp { source, .. }
            | Ev::FuryExp { source, .. }
            | Ev::CastEnd { source, .. }
            | Ev::AwaitCooldown { source } => Some(source),
            _ => None,
        }
    }

    #[inline]
    pub fn target(&self) -> Option<UnitId> {
        match *self {
            Ev::Dot { target, .. } => Some(target),
            _ => None,
        }
    }
}

pub struct Entry {
    pub time: f64,
    pub seq: u64,
    pub ev: Ev,
}

#[derive(Default)]
pub struct Queue {
    /// sorted descending by (time, seq); the next event is at the end
    items: Vec<Entry>,
    next_seq: u64,
    /// pending auto attacks and cast ends per unit (`has_attack` without scanning the queue)
    attacks: Vec<u32>,
}

#[inline]
fn attack_source(ev: &Ev) -> Option<UnitId> {
    match *ev {
        Ev::AutoAttack { source } | Ev::CastEnd { source, .. } => Some(source),
        _ => None,
    }
}

impl Queue {
    pub fn add(&mut self, time: f64, ev: Ev) {
        let _prof = crate::prof::start("queue.add");
        let time = js::round(time / 1e3) * 1e3;
        let seq = self.next_seq;
        self.next_seq += 1;
        // first index whose key is smaller than (time, seq): new seq is the largest so far,
        // so equal-time entries already present sort after it in the pop order.
        let pos = self.items.partition_point(|e| e.time > time || (e.time == time && e.seq > seq));
        if let Some(u) = attack_source(&ev) {
            if u >= self.attacks.len() {
                self.attacks.resize(u + 1, 0);
            }
            self.attacks[u] += 1;
        }
        self.items.insert(pos, Entry { time, seq, ev });
    }

    #[inline]
    pub fn pop(&mut self) -> Option<Entry> {
        let e = self.items.pop()?;
        if let Some(u) = attack_source(&e.ev) {
            self.attacks[u] -= 1;
        }
        Some(e)
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.next_seq = 0;
        self.attacks.clear();
    }

    /// Whether an auto attack or a cast end of `u` is pending.
    #[inline]
    pub fn has_attack(&self, u: UnitId) -> bool {
        self.attacks.get(u).is_some_and(|&n| n > 0)
    }

    #[inline]
    pub fn find<F: Fn(&Ev) -> bool>(&self, f: F) -> Option<&Ev> {
        self.items.iter().map(|e| &e.ev).find(|e| f(e))
    }

    #[inline]
    pub fn any<F: Fn(&Ev) -> bool>(&self, f: F) -> bool {
        self.items.iter().any(|e| f(&e.ev))
    }

    /// Removes all matching events; returns whether any was removed.
    #[inline]
    pub fn clear_matching<F: Fn(&Ev) -> bool>(&mut self, f: F) -> bool {
        let _prof = crate::prof::start("queue.clear_matching");
        let before = self.items.len();
        let attacks = &mut self.attacks;
        self.items.retain(|e| {
            let remove = f(&e.ev);
            if remove {
                if let Some(u) = attack_source(&e.ev) {
                    attacks[u] -= 1;
                }
            }
            !remove
        });
        self.items.len() != before
    }

    pub fn clear_type(&mut self, t: EvType) -> bool {
        self.clear_matching(|e| e.ty() == t)
    }

    pub fn clear_for_unit(&mut self, u: UnitId) -> bool {
        self.clear_matching(|e| e.source() == Some(u) || e.target() == Some(u))
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
}
