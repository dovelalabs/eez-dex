//! Settler configuration and metric names — RD-2 appendix A.5.
//!
//! FROZEN AT THE SCAFFOLD. WP-4 asserts on metric names it does not own and
//! WP-5 reads the same keys, so the strings live here and nowhere else.
//!
//! Configuration is a system boundary: it is parsed once, loudly, and every
//! value is valid by the time the tasks see it. Nothing downstream re-validates
//! (`CLAUDE.md`: fail loudly at boundaries, trust internally).

use std::collections::HashMap;
use std::fmt;

/// Every metric the settler publishes (A.5). Frozen: WP-4's scenario asserts
/// on these names and WP-5's amortisation stream reads them.
pub mod metrics {
    /// Windows by outcome. Labelled `outcome`; see [`WINDOW_OUTCOMES`].
    pub const WINDOWS_TOTAL: &str = "windows_total";
    /// Fills settled by one cross-layer transaction — the amortisation numerator.
    pub const FILLS_PER_SETTLEMENT: &str = "fills_per_settlement";
    /// L1 gas divided by fills, against `COUNTERFACTUAL_L1_GAS_WEI`.
    pub const GAS_PER_FILL_WEI: &str = "gas_per_fill_wei";
    /// What the same fills would have cost as direct L1 swaps (IX-3).
    pub const COUNTERFACTUAL_L1_GAS_WEI: &str = "counterfactual_l1_gas_wei";
    /// Share of orders that rolled rather than filled — the cost of drift (EC-2).
    pub const ROLL_RATE: &str = "roll_rate";
    /// The mirror's age in L1 slots (FL-1).
    pub const MIRROR_AGE_SLOTS: &str = "mirror_age_slots";
    /// Order placement to settlement, in seconds.
    pub const TIME_TO_SETTLE_SECONDS: &str = "time_to_settle_seconds";
    /// Deviation from the per-asset escrow invariant (CT-13). Must be 0.
    pub const ESCROW_INVARIANT_DRIFT_WEI: &str = "escrow_invariant_drift_wei";
    /// Consecutive windows that failed to post; `WINDOW_HALT` halts the settler.
    pub const UNPOSTED_WINDOW: &str = "unposted_window";
    /// Fillable orders the settler left out, as audited by the reconciler
    /// (EC-4). Must be 0.
    pub const SELECTION_OMITTED_TOTAL: &str = "selection_omitted_total";
    /// The residual's realised impact in basis points, per settlement (FL-5).
    pub const IMPACT_BPS: &str = "impact_bps";
    /// `1 - |residual| / gross` per settlement — the number that carries the
    /// economics, shown beside `fills_per_settlement`.
    pub const NETTING_RATIO: &str = "netting_ratio";
    /// The current EC-6 window length in L1 slots.
    pub const WINDOW_SLOTS: &str = "window_slots";

    /// Every metric name, in A.5's order.
    pub const ALL: [&str; 13] = [
        WINDOWS_TOTAL,
        FILLS_PER_SETTLEMENT,
        GAS_PER_FILL_WEI,
        COUNTERFACTUAL_L1_GAS_WEI,
        ROLL_RATE,
        MIRROR_AGE_SLOTS,
        TIME_TO_SETTLE_SECONDS,
        ESCROW_INVARIANT_DRIFT_WEI,
        UNPOSTED_WINDOW,
        SELECTION_OMITTED_TOTAL,
        IMPACT_BPS,
        NETTING_RATIO,
        WINDOW_SLOTS,
    ];

    /// The `outcome` label of [`WINDOWS_TOTAL`], matching the A.4 window state
    /// machine's terminal states plus `empty`.
    pub const WINDOW_OUTCOMES: [&str; 4] = ["settled", "evicted", "rolled_back", "empty"];
}

/// Why a configuration was rejected. Every variant names the key at fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// A required key was absent.
    Missing(&'static str),
    /// A key was present but could not be read as its type.
    Invalid {
        /// The key at fault.
        key: &'static str,
        /// What was wrong with it.
        reason: String,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(key) => write!(f, "{key} is not set"),
            Self::Invalid { key, reason } => write!(f, "{key} is invalid: {reason}"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// The protocol fee's shape (EC-1). Exactly one of `FEE_BPS` and `FEE_FIXED`
/// is set; both, or neither, is a configuration error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeModel {
    /// Basis points of notional. The EC-1 ceiling is derived from measured
    /// gas: at 2026 gas that is 1 bp, above which the median user is worse off
    /// than a direct swap.
    Bps(u16),
    /// A fixed amount per order, in wei of the sell asset.
    Fixed(u128),
}

/// Who pays the window's route fee — the L1 leg's gas and the batch-post share
/// (EC-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteFeeModel {
    /// The protocol absorbs it. The launch default.
    Absorb,
    /// Recovered from fills pro-rata by size. The high-gas fallback.
    Recover,
}

/// How many L1 slots a window spans (EC-6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowSlots {
    /// One slot: above `FLOW_THRESHOLD`.
    One,
    /// Two slots: below `FLOW_THRESHOLD`. The default.
    Two,
}

impl WindowSlots {
    /// The setting as the number of slots, for the `window_slots` metric.
    pub fn as_u8(self) -> u8 {
        match self {
            Self::One => 1,
            Self::Two => 2,
        }
    }
}

/// Which of the two build profiles this configuration selects (RD-2 §1).
/// Profile is configuration, never a fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// Bidirectional calls: bought assets are delivered into L2 balances
    /// through the DEX's own bridge pair.
    Full,
    /// Atomic L2->L1 calls only: every order sells zone ETH and the bought
    /// asset is delivered at an L1 address. No crossing.
    Genesis,
}

/// The settler's configuration — every key of A.5, typed and validated.
#[derive(Clone, PartialEq)]
pub struct Config {
    /// L1 JSON-RPC: the head, pool state, and the `eth_call` simulation (SV-2).
    pub l1_rpc: String,
    /// L2 JSON-RPC: `WindowBook` logs and the safe head.
    pub l2_rpc: String,
    /// The L2->L1 front. `settleWindow` must be sent here (A.2, SV-3).
    pub l2_front: String,
    /// `WindowBook` on L2.
    pub window_book: String,
    /// `SettlementRouter` on L1.
    pub router: String,
    /// The target Uniswap v3 pool on L1.
    pub pool: String,
    /// The settler key, used to sign settlements offline. Redacted in `Debug`.
    pub settler_key: String,
    /// A window below this notional does not settle until it grows or times
    /// out (EC-1).
    pub min_window_notional: u128,
    /// The protocol fee's shape.
    pub fee: FeeModel,
    /// Who pays the route fee.
    pub route_fee_model: RouteFeeModel,
    /// The current window length.
    pub window_slots: WindowSlots,
    /// Orders per slot above which `window_slots` drops to one (EC-6).
    pub flow_threshold: f64,
    /// Mirror age in slots above which an empty window submits a CT-6 refresh.
    /// Quote demand is not observable on-chain, so this is the sole trigger.
    pub mirror_refresh_age: u32,
    /// Seconds added to the Sync block's timestamp to form the leg's deadline.
    pub deadline_seconds: u64,
    /// Explicit gas for the L1 leg; the settler never estimates in flight.
    pub l1_gas: u64,
    /// Consecutive unposted windows after which the settler halts (SV-4).
    pub window_halt: u32,
    /// Must match the node's `EEZ_MAX_USER_TXS_PER_BUNDLE`; it is env-only
    /// upstream and not readable from chain or RPC (EC-5).
    pub max_user_txs_per_bundle: u8,
    /// \[full\] `DexBridge` on L1. Unset in the genesis form.
    pub dex_bridge_l1: Option<String>,
    /// \[full\] `DexBridgeL2` on L2. Unset in the genesis form.
    pub dex_bridge_l2: Option<String>,
}

/// `Debug` never prints the settler key.
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("l1_rpc", &self.l1_rpc)
            .field("l2_rpc", &self.l2_rpc)
            .field("l2_front", &self.l2_front)
            .field("window_book", &self.window_book)
            .field("router", &self.router)
            .field("pool", &self.pool)
            .field("settler_key", &"<redacted>")
            .field("min_window_notional", &self.min_window_notional)
            .field("fee", &self.fee)
            .field("route_fee_model", &self.route_fee_model)
            .field("window_slots", &self.window_slots)
            .field("flow_threshold", &self.flow_threshold)
            .field("mirror_refresh_age", &self.mirror_refresh_age)
            .field("deadline_seconds", &self.deadline_seconds)
            .field("l1_gas", &self.l1_gas)
            .field("window_halt", &self.window_halt)
            .field("max_user_txs_per_bundle", &self.max_user_txs_per_bundle)
            .field("dex_bridge_l1", &self.dex_bridge_l1)
            .field("dex_bridge_l2", &self.dex_bridge_l2)
            .finish()
    }
}

impl Config {
    /// Reads the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(&|key| std::env::var(key).ok())
    }

    /// Reads a map. Used by tests, which must not race the process
    /// environment, and by anything that carries its own key set.
    pub fn from_map(map: &HashMap<String, String>) -> Result<Self, ConfigError> {
        Self::from_lookup(&|key| map.get(key).cloned())
    }

    /// The single parse. Empty values are treated as unset so an `.env` line
    /// left blank behaves like a missing one.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let read = |key: &'static str| -> Option<String> {
            get(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };

        let required = |key: &'static str| -> Result<String, ConfigError> {
            read(key).ok_or(ConfigError::Missing(key))
        };

        let fee = match (read("FEE_BPS"), read("FEE_FIXED")) {
            (Some(_), Some(_)) => {
                return Err(ConfigError::Invalid {
                    key: "FEE_BPS",
                    reason: "FEE_BPS and FEE_FIXED are alternatives; set exactly one (EC-1)".into(),
                });
            }
            (Some(bps), None) => FeeModel::Bps(parse("FEE_BPS", &bps)?),
            (None, Some(fixed)) => FeeModel::Fixed(parse("FEE_FIXED", &fixed)?),
            (None, None) => FeeModel::Bps(1),
        };

        let route_fee_model = match read("ROUTE_FEE_MODEL").as_deref() {
            None | Some("absorb") => RouteFeeModel::Absorb,
            Some("recover") => RouteFeeModel::Recover,
            Some(other) => {
                return Err(ConfigError::Invalid {
                    key: "ROUTE_FEE_MODEL",
                    reason: format!("expected absorb or recover, got {other}"),
                });
            }
        };

        let window_slots = match read("WINDOW_SLOTS").as_deref() {
            None | Some("2") => WindowSlots::Two,
            Some("1") => WindowSlots::One,
            Some(other) => {
                return Err(ConfigError::Invalid {
                    key: "WINDOW_SLOTS",
                    reason: format!("expected 1 or 2, got {other}"),
                });
            }
        };

        Ok(Self {
            l1_rpc: required("L1_RPC")?,
            l2_rpc: required("L2_RPC")?,
            l2_front: required("L2_FRONT")?,
            window_book: address("WINDOW_BOOK", &required("WINDOW_BOOK")?)?,
            router: address("ROUTER", &required("ROUTER")?)?,
            pool: address("POOL", &required("POOL")?)?,
            settler_key: secret_key("SETTLER_KEY", &required("SETTLER_KEY")?)?,
            min_window_notional: optional("MIN_WINDOW_NOTIONAL", read("MIN_WINDOW_NOTIONAL"), 0)?,
            fee,
            route_fee_model,
            window_slots,
            flow_threshold: optional("FLOW_THRESHOLD", read("FLOW_THRESHOLD"), 4.0)?,
            mirror_refresh_age: optional("MIRROR_REFRESH_AGE", read("MIRROR_REFRESH_AGE"), 5)?,
            deadline_seconds: optional("DEADLINE_SECONDS", read("DEADLINE_SECONDS"), 24)?,
            l1_gas: optional("L1_GAS", read("L1_GAS"), 1_000_000)?,
            window_halt: optional("WINDOW_HALT", read("WINDOW_HALT"), 3)?,
            max_user_txs_per_bundle: optional(
                "MAX_USER_TXS_PER_BUNDLE",
                read("MAX_USER_TXS_PER_BUNDLE"),
                3,
            )?,
            dex_bridge_l1: read("DEX_BRIDGE_L1")
                .map(|v| address("DEX_BRIDGE_L1", &v))
                .transpose()?,
            dex_bridge_l2: read("DEX_BRIDGE_L2")
                .map(|v| address("DEX_BRIDGE_L2", &v))
                .transpose()?,
        })
    }

    /// The profile this configuration selects. The full form is the one with a
    /// bridge pair; without one there is no ERC-20 leg and every order sells
    /// zone ETH.
    pub fn profile(&self) -> Profile {
        match (&self.dex_bridge_l1, &self.dex_bridge_l2) {
            (Some(_), Some(_)) => Profile::Full,
            _ => Profile::Genesis,
        }
    }
}

fn parse<T: std::str::FromStr>(key: &'static str, value: &str) -> Result<T, ConfigError>
where
    T::Err: fmt::Display,
{
    value.parse::<T>().map_err(|e| ConfigError::Invalid {
        key,
        reason: e.to_string(),
    })
}

fn optional<T: std::str::FromStr>(
    key: &'static str,
    value: Option<String>,
    default: T,
) -> Result<T, ConfigError>
where
    T::Err: fmt::Display,
{
    match value {
        Some(v) => parse(key, &v),
        None => Ok(default),
    }
}

/// A 20-byte hex address, normalised to lower case. Checksums are not verified
/// here: the chain is the authority on what an address means.
fn address(key: &'static str, value: &str) -> Result<String, ConfigError> {
    let body = value.strip_prefix("0x").ok_or(ConfigError::Invalid {
        key,
        reason: "expected a 0x-prefixed 20-byte address".into(),
    })?;
    if body.len() != 40 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ConfigError::Invalid {
            key,
            reason: format!("expected 40 hex digits after 0x, got {:?}", body.len()),
        });
    }
    Ok(format!("0x{}", body.to_ascii_lowercase()))
}

/// A 32-byte hex secret key.
fn secret_key(key: &'static str, value: &str) -> Result<String, ConfigError> {
    let body = value.strip_prefix("0x").unwrap_or(value);
    if body.len() != 64 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ConfigError::Invalid {
            key,
            reason: "expected a 32-byte hex key".into(),
        });
    }
    Ok(format!("0x{}", body.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> HashMap<String, String> {
        [
            ("L1_RPC", "https://eth.drpc.org"),
            ("L2_RPC", "http://127.0.0.1:8545"),
            ("L2_FRONT", "http://127.0.0.1:8547"),
            ("WINDOW_BOOK", "0x00000000000000000000000000000000000000B0"),
            ("ROUTER", "0x00000000000000000000000000000000000000A1"),
            ("POOL", "0x00000000000000000000000000000000000000C2"),
            (
                "SETTLER_KEY",
                "0x1111111111111111111111111111111111111111111111111111111111111111",
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn a5_defaults_are_the_ec1_and_ec6_launch_parameters() {
        let config = Config::from_map(&minimal()).expect("minimal config parses");
        assert_eq!(
            config.fee,
            FeeModel::Bps(1),
            "EC-1: FEE_BPS <= 1 at 2026 gas"
        );
        assert_eq!(
            config.route_fee_model,
            RouteFeeModel::Absorb,
            "EC-1: absorbed at launch"
        );
        assert_eq!(
            config.window_slots,
            WindowSlots::Two,
            "EC-6: two slots below the flow threshold"
        );
        assert_eq!(config.deadline_seconds, 24);
        assert_eq!(config.max_user_txs_per_bundle, 3);
        assert_eq!(config.mirror_refresh_age, 5);
        assert_eq!(config.window_halt, 3);
    }

    #[test]
    fn a5_every_required_endpoint_and_address_is_required() {
        for key in [
            "L1_RPC",
            "L2_RPC",
            "L2_FRONT",
            "WINDOW_BOOK",
            "ROUTER",
            "POOL",
            "SETTLER_KEY",
        ] {
            let mut map = minimal();
            map.remove(key);
            assert_eq!(
                Config::from_map(&map),
                Err(ConfigError::Missing(key)),
                "{key} must be required"
            );
        }
    }

    #[test]
    fn ec1_fee_bps_and_fee_fixed_are_alternatives() {
        let mut map = minimal();
        map.insert("FEE_BPS".into(), "1".into());
        map.insert("FEE_FIXED".into(), "1000".into());
        assert!(matches!(
            Config::from_map(&map),
            Err(ConfigError::Invalid { key: "FEE_BPS", .. })
        ));

        let mut fixed = minimal();
        fixed.insert("FEE_FIXED".into(), "1000".into());
        assert_eq!(Config::from_map(&fixed).unwrap().fee, FeeModel::Fixed(1000));
    }

    #[test]
    fn ec6_window_slots_is_one_or_two() {
        let mut map = minimal();
        map.insert("WINDOW_SLOTS".into(), "1".into());
        let config = Config::from_map(&map).unwrap();
        assert_eq!(config.window_slots, WindowSlots::One);
        assert_eq!(config.window_slots.as_u8(), 1);

        map.insert("WINDOW_SLOTS".into(), "3".into());
        assert!(matches!(
            Config::from_map(&map),
            Err(ConfigError::Invalid {
                key: "WINDOW_SLOTS",
                ..
            })
        ));
    }

    #[test]
    fn ec1_route_fee_model_is_absorb_or_recover() {
        let mut map = minimal();
        map.insert("ROUTE_FEE_MODEL".into(), "recover".into());
        assert_eq!(
            Config::from_map(&map).unwrap().route_fee_model,
            RouteFeeModel::Recover
        );
        map.insert("ROUTE_FEE_MODEL".into(), "socialise".into());
        assert!(matches!(
            Config::from_map(&map),
            Err(ConfigError::Invalid {
                key: "ROUTE_FEE_MODEL",
                ..
            })
        ));
    }

    #[test]
    fn addresses_fail_loudly_at_the_boundary() {
        let mut map = minimal();
        map.insert("ROUTER".into(), "not-an-address".into());
        assert!(matches!(
            Config::from_map(&map),
            Err(ConfigError::Invalid { key: "ROUTER", .. })
        ));

        map.insert("ROUTER".into(), "0xdeadbeef".into());
        assert!(matches!(
            Config::from_map(&map),
            Err(ConfigError::Invalid { key: "ROUTER", .. })
        ));
    }

    #[test]
    fn addresses_are_normalised_to_lower_case() {
        let config = Config::from_map(&minimal()).unwrap();
        assert_eq!(
            config.window_book,
            "0x00000000000000000000000000000000000000b0"
        );
    }

    #[test]
    fn a_blank_value_is_an_unset_value() {
        let mut map = minimal();
        map.insert("DEX_BRIDGE_L1".into(), "  ".into());
        assert_eq!(Config::from_map(&map).unwrap().dex_bridge_l1, None);
    }

    #[test]
    fn profile_is_configuration_never_a_fork() {
        let map = minimal();
        assert_eq!(Config::from_map(&map).unwrap().profile(), Profile::Genesis);

        let mut full = map;
        full.insert(
            "DEX_BRIDGE_L1".into(),
            "0x00000000000000000000000000000000000000D1".into(),
        );
        full.insert(
            "DEX_BRIDGE_L2".into(),
            "0x00000000000000000000000000000000000000D2".into(),
        );
        assert_eq!(Config::from_map(&full).unwrap().profile(), Profile::Full);
    }

    #[test]
    fn the_settler_key_is_never_printed() {
        let config = Config::from_map(&minimal()).unwrap();
        let rendered = format!("{config:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(
            !rendered.contains("1111111111111111111111111111111111111111111111111111111111111111")
        );
    }

    #[test]
    fn a5_metric_names_are_frozen() {
        assert_eq!(metrics::ALL.len(), 13, "A.5 lists thirteen metrics");
        let mut sorted = metrics::ALL;
        sorted.sort_unstable();
        let mut deduped = sorted.to_vec();
        deduped.dedup();
        assert_eq!(deduped.len(), 13, "metric names are unique");
        assert!(metrics::ALL.contains(&"selection_omitted_total"));
        assert!(metrics::ALL.contains(&"escrow_invariant_drift_wei"));
        assert!(metrics::ALL.contains(&"netting_ratio"));
        assert_eq!(
            metrics::WINDOW_OUTCOMES,
            ["settled", "evicted", "rolled_back", "empty"]
        );
    }
}
