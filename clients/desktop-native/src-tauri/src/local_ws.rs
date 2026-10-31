use anyhow::{bail, Context, Result};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;
use tungstenite::client::IntoClientRequest;
use tungstenite::{handshake::client::Response, WebSocket};

pub(crate) fn connect_local<R: IntoClientRequest>(
    request: R,
    read_timeout: Duration,
    write_timeout: Duration,
) -> Result<(WebSocket<TcpStream>, Response)> {
    let request = request
        .into_client_request()
        .map_err(|_| anyhow::anyhow!("Invalid local WebSocket request"))?;
    let uri = request.uri();
    if uri.scheme_str() != Some("ws") || uri.host() != Some("127.0.0.1") {
        bail!("TINA local WebSocket must use loopback");
    }
    let port = uri.port_u16().context("Local WebSocket port is required")?;
    let address = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port);
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .context("TINA Desktop is unavailable on loopback")?;
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(write_timeout))?;
    tungstenite::client(request, stream)
        .map_err(|_| anyhow::anyhow!("Local WebSocket handshake failed or timed out"))
}

#[cfg(test)]
mod tests {
    use super::connect_local;
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tungstenite::client::IntoClientRequest;

    #[test]
    fn bounds_a_peer_that_stalls_the_websocket_upgrade() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            socket.read(&mut request).unwrap();
            let mut until_client_closes = [0; 1];
            let _ = socket.read(&mut until_client_closes);
        });

        let (result_tx, result_rx) = mpsc::channel();
        thread::spawn(move || {
            let request = format!("ws://127.0.0.1:{}/ingest", address.port())
                .into_client_request()
                .unwrap();
            result_tx
                .send(connect_local(
                    request,
                    Duration::from_millis(100),
                    Duration::from_secs(1),
                ))
                .unwrap();
        });

        let result = result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("stalled WebSocket upgrade must be bounded");
        assert!(result.is_err());
        server.join().unwrap();
    }
}
