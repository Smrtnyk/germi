//! Run the Germi proxy engine WITHOUT the desktop shell.
//!
//!   cargo run -p proxy-core --example standalone
//!
//! Then point your browser/system proxy at 127.0.0.1:8080 and trust the CA
//! printed on startup. Captured flows are logged as JSON events.

use std::net::SocketAddr;

use proxy_core::ProxyController;
use tokio::sync::broadcast::error::RecvError;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let ca_dir = std::env::temp_dir().join("germi");
    let ca = ProxyController::load_or_generate_ca(&ca_dir)?;
    let controller = ProxyController::new(ca);

    let mut events = controller.subscribe();
    let addr: SocketAddr = "127.0.0.1:8080".parse()?;
    controller.start(addr).await?;

    println!("Germi proxy listening on http://{addr}");
    println!("CA certificate: {}", ca_dir.join("germi-ca.pem").display());
    println!("Trust that CA, set it as your HTTP/HTTPS proxy, then browse.\n");

    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    println!("{}", serde_json::to_string(&event).unwrap_or_default());
                }
                Err(RecvError::Lagged(n)) => eprintln!("(dropped {n} events: subscriber lagged)"),
                Err(RecvError::Closed) => break,
            }
        }
    });

    tokio::signal::ctrl_c().await?;
    println!("\nShutting down…");
    controller.stop().await;
    Ok(())
}
