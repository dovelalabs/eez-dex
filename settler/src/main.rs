//! The settler binary.
//!
//! Four tasks over one state store (SV-1), stepped once per L2 block. The
//! configuration is parsed first and whole, so a misconfigured deployment
//! fails at startup rather than at the first slot boundary.

use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::Address;
use eez_dex_settler::builder::WindowBuilder;
use eez_dex_settler::chain::{FrontRpc, L1Rpc, L2Rpc, LocalSettlementSigner, RpcClient};
use eez_dex_settler::config::metrics;
use eez_dex_settler::reconciler::Reconciler;
use eez_dex_settler::state::StateStore;
use eez_dex_settler::submitter::Submitter;
use eez_dex_settler::watcher::Watcher;
use eez_dex_settler::{Config, Task};

/// One L2 block: the cadence the tasks are stepped at (RD-2 §1).
const TICK: Duration = Duration::from_secs(2);

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "eez_dex_settler=info".into()),
        )
        .init();

    let config = Config::from_env()?;
    tracing::info!(
        profile = ?config.profile(),
        window_slots = config.window_slots.as_u8(),
        "eez-dex-settler starting"
    );

    let runtime = Arc::new(tokio::runtime::Runtime::new()?);
    let l1_client = RpcClient::connect(runtime.clone(), &config.l1_rpc)?;
    let l2_client = RpcClient::connect(runtime.clone(), &config.l2_rpc)?;
    let front_client = RpcClient::connect(runtime.clone(), &config.l2_front)?;

    let book: Address = config.window_book.parse()?;
    let router: Address = config.router.parse()?;
    let pool: Address = config.pool.parse()?;

    // The adapter is the router's own; until it is read from the router, the
    // pool address is what the state read is aimed at.
    let l1 = L1Rpc::new(l1_client, router, pool, pool, router);
    let l2 = L2Rpc::new(l2_client, book);
    let front = FrontRpc::new(front_client);
    let signer = LocalSettlementSigner::new(&config.settler_key, book)?;

    let mut state = StateStore::open(&config);
    let mut tasks: Vec<Box<dyn Task>> = vec![
        Box::new(Watcher::new(l2.clone(), l1.clone(), 0)),
        Box::new(WindowBuilder::new(&config, l1.clone())),
        Box::new(Submitter::new(&config, l2.clone(), front.clone(), signer)),
        Box::new(Reconciler::new(&config, l2, l1, front)),
    ];

    loop {
        for task in &mut tasks {
            if let Err(error) = task.tick(&mut state) {
                // A task that cannot make progress says so rather than
                // guessing. The loop continues: an RPC that did not answer
                // this block may answer the next, and nothing has been
                // submitted on a guess.
                tracing::warn!(task = task.name(), %error, "tick failed");
            }
        }

        if state.halted {
            tracing::error!(
                unposted = state.unposted_windows,
                "halted on the unposted-window threshold (SV-4); no settlements will be accepted"
            );
        }
        for violation in state.metrics.violations() {
            tracing::error!(
                metric = violation,
                value = state.metrics.get(violation),
                "invariant violated"
            );
        }
        tracing::debug!(
            window = state.window.id,
            blocks_remaining = state.blocks_remaining(),
            mirror_age = state.metrics.get(metrics::MIRROR_AGE_SLOTS),
            "tick"
        );

        std::thread::sleep(TICK);
    }
}
