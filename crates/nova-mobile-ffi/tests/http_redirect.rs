use nova_mobile_ffi::probe_http_range;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut request = [0_u8; 4096];
    let read = stream.read(&mut request).expect("read HTTP request");
    String::from_utf8_lossy(&request[..read]).into_owned()
}

#[test]
fn range_probe_follows_http_redirect_and_preserves_range_request() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect test server");
    let address = listener.local_addr().expect("redirect test server address");

    let server = thread::spawn(move || {
        let (mut redirect_stream, _) = listener.accept().expect("accept redirect request");
        let redirect_request = read_request(&mut redirect_stream);
        assert!(redirect_request.starts_with("GET /redirect HTTP/"));
        assert!(redirect_request.contains("Range: bytes=2-5"));
        redirect_stream
            .write_all(
                b"HTTP/1.1 302 Found\r\nLocation: /payload.bin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .expect("write redirect response");
        drop(redirect_stream);

        let (mut payload_stream, _) = listener.accept().expect("accept redirected range request");
        let payload_request = read_request(&mut payload_stream);
        assert!(payload_request.starts_with("GET /payload.bin HTTP/"));
        assert!(
            payload_request.contains("Range: bytes=2-5"),
            "redirected request must preserve the byte range"
        );
        assert!(payload_request.contains("Accept-Encoding: identity"));
        payload_stream
            .write_all(
                b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-5/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\ncdef",
            )
            .expect("write redirected range response");
    });

    let url = format!("http://{address}/redirect");
    let probe = probe_http_range(url, 2, 5).expect("redirected native range must succeed");
    server.join().expect("redirect test server thread");

    assert_eq!(probe.response_status, 206);
    assert_eq!(probe.range_start, 2);
    assert_eq!(probe.range_end, 5);
    assert_eq!(probe.bytes_received, 4);
    assert_eq!(probe.effective_url, format!("http://{address}/payload.bin"));
}
