//! The settler's state, in the IX-2 event schema.
//!
//! `indexer/schema/` is frozen and is the normative copy; this module is the
//! Rust side of the same shapes, so what the settler exposes is what WP-5's
//! stream and WP-6's reducer already know how to read. Field names are
//! `camelCase` and every chain quantity wider than 2^53 travels as a decimal
//! string, because JSON has one number type and it is a double.
//!
//! Only the projection lives here. The settler is not the indexer: it holds no
//! socket, serves nothing, and exposes no write path (IX-1 is WP-5's). What it
//! owes is that its state can be rendered into the schema without inference,
//! which is what the scenario's recorded run (HX-5) is built from.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::attempt::AttemptState;
use crate::chain::BookEvent;
use crate::config::metrics as names;
use crate::state::{OrderPhase, StateStore};
use crate::types::{OrderId, PoolState, WindowResult};

/// `indexer/schema/version.ts`. Bumped only by a change an older reader would
/// mis-read; the frozen copy is the authority.
pub const SCHEMA_VERSION: u32 = 1;

/// A.1's `PoolState` on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStateJson {
    /// uint160, as a decimal string.
    pub sqrt_price_x96: String,
    /// uint128, as a decimal string.
    pub liquidity: String,
    /// int24.
    pub tick: i32,
}

impl From<&PoolState> for PoolStateJson {
    fn from(state: &PoolState) -> Self {
        Self {
            sqrt_price_x96: state.sqrt_price_x96.to_string(),
            liquidity: state.liquidity.to_string(),
            tick: state.tick,
        }
    }
}

/// IX-2's `Window`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowJson {
    /// The frozen schema version every top-level object carries.
    pub schema_version: u32,
    /// uint64, as a decimal string.
    pub window_id: String,
    /// One of A.4's window states.
    pub state: String,
    /// The EC-6 setting this window was opened under.
    pub slots: u8,
    /// The L2 block it opened at.
    pub opened_at_l2_block: u64,
    /// The unix second it opened at.
    pub opened_at_unix: u64,
    /// The L2 block that carried `settleWindow`, once there is one.
    pub sync_l2_block: Option<u64>,
    /// Every order that belonged to this window, in placement order.
    pub order_ids: Vec<String>,
    /// The ids the settler selected, ascending — a suggestion, not the fills.
    pub selected_order_ids: Vec<String>,
    /// The settlement that closed it, once there is one.
    pub settlement_id: Option<String>,
    /// Gross volume placed before crossing, in sell-asset units.
    pub gross_in: String,
    /// What actually went to L1 after crossing. Zero in a CT-6 refresh.
    pub residual_in: String,
    /// Which way the residual traded.
    pub residual_side: Option<String>,
    /// `1 - |residual| / gross`. Null until the window closes.
    pub netting_ratio: Option<f64>,
}

/// IX-2's `Order`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderJson {
    /// The frozen schema version.
    pub schema_version: u32,
    /// `keccak256(owner, nonce)` (CT-7).
    pub id: String,
    /// Who placed it.
    pub owner: String,
    /// Which way it trades.
    pub side: String,
    /// The escrowed input.
    pub sell_amount: String,
    /// The limit, net of fees and impact (CT-10).
    pub min_buy_amount: String,
    /// An L2 address \[full\] or an L1 address \[genesis\].
    pub recipient: String,
    /// Lifetime in windows.
    pub expires_after: u32,
    /// One of A.4's order states.
    pub state: String,
    /// The L2 block it was placed in.
    pub placed_at_l2_block: u64,
    /// The unix second it was placed at.
    pub placed_at_unix: u64,
    /// The window it currently belongs to.
    pub window_id: String,
    /// How many windows it has rolled through (`roll_rate`, FE-7).
    pub rolled_count: u32,
    /// Its fill, once it has one.
    pub fill: Option<OrderFillJson>,
}

/// IX-2's `OrderFill` — every deduction stated absolutely, so the indexer needs
/// no inference (CT-12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderFillJson {
    /// The window it filled in.
    pub window_id: String,
    /// Net output after every deduction. Never below `minBuyAmount`.
    pub amount_out: String,
    /// The EC-1 protocol fee.
    pub fee_amount: String,
    /// This order's share of the window's route fee.
    pub route_fee_amount: String,
    /// This order's share of the residual's impact. Zero if crossed.
    pub impact_amount: String,
    /// The price it cleared at.
    pub price_x96: String,
    /// True if it was matched inside the window rather than on L1.
    pub crossed: bool,
    /// The settlement that filled it.
    pub settlement_id: String,
}

/// IX-2's `MirrorSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSnapshotJson {
    /// The frozen schema version.
    pub schema_version: u32,
    /// The window whose settlement produced it.
    pub window_id: String,
    /// The pool state it copies.
    pub state: PoolStateJson,
    /// `P0` as of this snapshot (CT-14).
    pub reference_price_x96: String,
    /// The L1 block the state was read in.
    pub l1_block: u64,
    /// The Sync-block timestamp its age is measured from (CT-8).
    pub mirror_timestamp: u64,
    /// `(now - mirrorTimestamp) / 12`.
    pub age_slots: u32,
    /// Why this snapshot exists.
    pub source: String,
    /// When the settler observed it.
    pub observed_at_unix: u64,
}

/// IX-2's `MetricsEvent` body: the A.5 metrics under their frozen names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsJson {
    /// The frozen schema version.
    pub schema_version: u32,
    /// Every metric, by key.
    pub metrics: BTreeMap<String, f64>,
}

/// A hex string, lower case, as every address and hash travels.
fn hex_id(id: &OrderId) -> String {
    format!("{id:#x}")
}

/// The open window, as IX-2 describes it.
pub fn window(state: &StateStore) -> WindowJson {
    let order_ids: Vec<String> = state
        .orders
        .values()
        .filter(|tracked| tracked.order.placed_window == state.window.id)
        .map(|tracked| hex_id(&tracked.order.id))
        .collect();

    let evaluation = state
        .selection
        .as_ref()
        .and_then(|selection| selection.evaluation.as_ref());
    let (gross_in, residual_in, residual_side) = match evaluation {
        Some(evaluation) => {
            let price = state
                .mirror
                .state
                .as_ref()
                .and_then(|mirror| crate::mirror::spot_price_x96(mirror).ok());
            let gross = price
                .and_then(|price| evaluation.selection.gross_in_a(price).ok())
                .unwrap_or_default();
            (
                gross.to_string(),
                evaluation.built.leg.residual_in.to_string(),
                Some(evaluation.built.leg.residual_side.as_str().to_string()),
            )
        }
        None => ("0".into(), "0".into(), None),
    };

    WindowJson {
        schema_version: SCHEMA_VERSION,
        window_id: state.window.id.to_string(),
        state: state.window.phase.as_str().to_string(),
        slots: state.window.slots.as_u8(),
        opened_at_l2_block: state.window.opened_at_l2_block,
        opened_at_unix: state.window.opened_at_unix,
        sync_l2_block: state.window.sync_l2_block,
        order_ids,
        selected_order_ids: state.attempt.selection().iter().map(hex_id).collect(),
        settlement_id: state.attempt.tx_hash().map(|hash| format!("{hash:#x}")),
        gross_in,
        residual_in,
        residual_side,
        netting_ratio: match state.metrics.last(names::NETTING_RATIO) {
            ratio if state.window.sync_l2_block.is_some() || evaluation.is_some() => Some(ratio),
            _ => None,
        },
    }
}

/// Every order the settler knows about, ascending by id (SV-2).
pub fn orders(state: &StateStore) -> Vec<OrderJson> {
    state
        .orders
        .values()
        .map(|tracked| OrderJson {
            schema_version: SCHEMA_VERSION,
            id: hex_id(&tracked.order.id),
            owner: format!("{:#x}", tracked.order.owner),
            side: tracked.order.side.as_str().to_string(),
            sell_amount: tracked.order.sell_amount.to_string(),
            min_buy_amount: tracked.order.min_buy_amount.to_string(),
            recipient: format!("{:#x}", tracked.order.recipient),
            expires_after: tracked.order.expires_after,
            state: tracked.phase.as_str().to_string(),
            placed_at_l2_block: tracked.placed_at_l2_block,
            placed_at_unix: tracked.placed_at_unix,
            window_id: tracked.order.placed_window.to_string(),
            rolled_count: tracked.rolled_count,
            fill: fill_of(state, tracked.order.id, tracked.phase),
        })
        .collect()
}

fn fill_of(state: &StateStore, id: OrderId, phase: OrderPhase) -> Option<OrderFillJson> {
    if phase != OrderPhase::Filled {
        return None;
    }
    let evaluation = state.selection.as_ref()?.evaluation.as_ref()?;
    let fill = evaluation.fills.iter().find(|fill| fill.id == id)?;
    Some(OrderFillJson {
        window_id: state.window.id.to_string(),
        amount_out: fill.amount_out.to_string(),
        fee_amount: fill.fee_amount.to_string(),
        route_fee_amount: fill.route_fee_amount.to_string(),
        impact_amount: fill.impact_amount.to_string(),
        price_x96: fill.price_x96.to_string(),
        crossed: fill.crossed,
        settlement_id: state
            .attempt
            .tx_hash()
            .map(|hash| format!("{hash:#x}"))
            .unwrap_or_default(),
    })
}

/// The mirror as the settler last read it (FL-1, FE-8).
pub fn mirror_snapshot(state: &StateStore, now: u64) -> Option<MirrorSnapshotJson> {
    let pool = state.mirror.state.as_ref()?;
    Some(MirrorSnapshotJson {
        schema_version: SCHEMA_VERSION,
        window_id: state.window.id.to_string(),
        state: pool.into(),
        reference_price_x96: state.mirror.reference_price_x96.to_string(),
        l1_block: state.mirror.reference_l1_block,
        mirror_timestamp: state.mirror.stamped_at,
        age_slots: state.mirror.age_slots(now),
        source: mirror_source(state).to_string(),
        observed_at_unix: now,
    })
}

/// IX-2's `MirrorSource`: where this snapshot came from.
fn mirror_source(state: &StateStore) -> &'static str {
    if state.mirror.stamped_at == 0 {
        "genesis"
    } else if matches!(state.attempt.state, AttemptState::InFlight { .. })
        && state.attempt.selection().is_empty()
    {
        // A CT-6 empty settlement, taken because the mirror aged past
        // `MIRROR_REFRESH_AGE` (SV-3).
        "refresh"
    } else {
        "settlement"
    }
}

/// The A.5 metrics, ready for IX-2's `MetricsEvent`.
pub fn metrics(state: &StateStore) -> MetricsJson {
    MetricsJson {
        schema_version: SCHEMA_VERSION,
        metrics: state.metrics.snapshot(),
    }
}

/// A settled window's result, as IX-2's `WindowResult`.
pub fn window_result(result: &WindowResult) -> serde_json::Value {
    serde_json::json!({
        "amountIn": result.amount_in.to_string(),
        "amountOut": result.amount_out.to_string(),
        "referencePriceX96": result.reference_price_x96.to_string(),
        "executionPriceX96": result.execution_price_x96.to_string(),
        "post": PoolStateJson::from(&result.post),
        "l1Block": result.l1_block,
    })
}

/// The settlements the watcher has seen but the reconciler has not resolved.
pub fn pending_settlements(state: &StateStore) -> Vec<String> {
    state
        .observed_settlements
        .iter()
        .filter_map(|event| match event {
            BookEvent::Settled { tx_hash, .. } => Some(format!("{tx_hash:#x}")),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Task;
    use crate::builder::WindowBuilder;
    use crate::submitter::Submitter;
    use crate::testkit::{
        FakeFront, FakeL1, FakeL2, FakeSigner, fixture_config, fixture_mirror, order, store,
    };
    use crate::types::Side;
    use crate::watcher::Watcher;

    fn two_orders() -> Vec<crate::types::Order> {
        vec![
            order(
                1,
                Side::SellAForB,
                "10000000000000000000",
                "19000000000000000000000",
            ),
            order(
                2,
                Side::SellBForA,
                "10000000000000000000000",
                "4900000000000000000",
            ),
        ]
    }

    fn settled_state() -> StateStore {
        let l1 = FakeL1::at(2000);
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_open_orders(two_orders());
        l2.set_safe_block(6);
        let front = FakeFront::new();

        let mut state = store();
        Watcher::new(l2.clone(), l1.clone(), 0)
            .tick(&mut state)
            .unwrap();
        WindowBuilder::new(&fixture_config(), l1.simulator())
            .tick(&mut state)
            .unwrap();
        Submitter::new(&fixture_config(), l2, front, FakeSigner)
            .tick(&mut state)
            .unwrap();
        state
    }

    #[test]
    fn ix2_the_window_renders_with_the_schemas_field_names() {
        let state = settled_state();
        let json = serde_json::to_value(window(&state)).unwrap();

        for field in [
            "schemaVersion",
            "windowId",
            "state",
            "slots",
            "openedAtL2Block",
            "openedAtUnix",
            "syncL2Block",
            "orderIds",
            "selectedOrderIds",
            "settlementId",
            "grossIn",
            "residualIn",
            "residualSide",
            "nettingRatio",
        ] {
            assert!(
                json.get(field).is_some(),
                "IX-2's Window carries {field}, and the settler must too"
            );
        }
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["state"], "settling");
        assert_eq!(json["residualSide"], "SELL_A_FOR_B");
    }

    #[test]
    fn ix2_amounts_wider_than_a_double_travel_as_decimal_strings() {
        let state = settled_state();
        let json = serde_json::to_value(window(&state)).unwrap();
        // 10 A is 10^19 wei, past 2^53. It must be a string, exactly.
        assert!(json["grossIn"].is_string());
        assert!(json["residualIn"].is_string());
        assert!(json["windowId"].is_string());
        // And counts and blocks stay numbers.
        assert!(json["openedAtL2Block"].is_number());
        assert!(json["slots"].is_number());

        let orders = serde_json::to_value(orders(&state)).unwrap();
        assert_eq!(orders[0]["sellAmount"], "10000000000000000000");
        assert!(orders[0]["expiresAfter"].is_number());
    }

    #[test]
    fn a4_order_and_window_states_render_under_ix2_names() {
        let state = settled_state();
        let orders = orders(&state);
        assert_eq!(orders.len(), 2);
        for order in &orders {
            assert_eq!(order.state, "selected", "the settler suggested both");
            assert!(order.fill.is_none(), "nothing has settled yet");
        }
        assert_eq!(window(&state).state, "settling");
    }

    #[test]
    fn ix2_the_mirror_snapshot_carries_its_age_in_slots() {
        let state = settled_state();
        let snapshot = mirror_snapshot(&state, 1_800_000_060).unwrap();
        assert_eq!(snapshot.age_slots, 5, "CT-8: sixty seconds is five slots");
        assert_eq!(snapshot.schema_version, SCHEMA_VERSION);
        assert!(snapshot.state.sqrt_price_x96.parse::<u128>().is_ok());

        let json = serde_json::to_value(&snapshot).unwrap();
        for field in [
            "schemaVersion",
            "windowId",
            "state",
            "referencePriceX96",
            "l1Block",
            "mirrorTimestamp",
            "ageSlots",
            "source",
            "observedAtUnix",
        ] {
            assert!(
                json.get(field).is_some(),
                "IX-2's MirrorSnapshot carries {field}"
            );
        }
    }

    #[test]
    fn a5_the_metrics_event_carries_every_frozen_name() {
        let state = settled_state();
        let event = metrics(&state);
        for name in names::ALL {
            if name == names::WINDOWS_TOTAL {
                continue;
            }
            assert!(
                event.metrics.contains_key(name),
                "{name} must be on the wire"
            );
        }
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert!(json["metrics"].is_object());
    }

    #[test]
    fn ix2_every_object_round_trips_through_json() {
        // Replay cannot equal live if a recorded object does not read back as
        // itself (TS-5).
        let state = settled_state();

        let window = window(&state);
        let text = serde_json::to_string(&window).unwrap();
        assert_eq!(serde_json::from_str::<WindowJson>(&text).unwrap(), window);

        let orders = orders(&state);
        let text = serde_json::to_string(&orders).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<OrderJson>>(&text).unwrap(),
            orders
        );

        let snapshot = mirror_snapshot(&state, 1_800_000_012).unwrap();
        let text = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(
            serde_json::from_str::<MirrorSnapshotJson>(&text).unwrap(),
            snapshot
        );
    }

    #[test]
    fn ct2_a_window_result_renders_with_a1s_field_names() {
        let result = WindowResult {
            amount_in: crate::testkit::wei("4999500000000000000"),
            amount_out: crate::testkit::wei("9990000000000000000000"),
            reference_price_x96: crate::testkit::wei("158456325028528675187087900671953"),
            execution_price_x96: crate::testkit::wei("158456325028528675187087900671000"),
            post: fixture_mirror(),
            l1_block: 1_001,
        };
        let json = window_result(&result);
        assert_eq!(json["amountIn"], "4999500000000000000");
        assert_eq!(json["l1Block"], 1_001);
        assert_eq!(json["post"]["tick"], 0);
        assert!(json["post"]["sqrtPriceX96"].is_string());
    }

    #[test]
    fn ix2_a_side_is_named_not_numbered() {
        let state = settled_state();
        let json = serde_json::to_value(window(&state)).unwrap();
        assert_eq!(
            json["residualSide"], "SELL_A_FOR_B",
            "IX-2 carries a side by name so a recorded run stays readable"
        );
    }
}
