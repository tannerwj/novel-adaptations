"""Unauthenticated local CONNECT forwarder -> authenticated egress proxy.

Some sandboxed environments route outbound traffic through an authenticating
HTTP proxy that Chromium's built-in proxy-auth handshake cannot complete
(the CONNECT tunnel dies with ERR_EMPTY_RESPONSE). This forwarder terminates
Chromium's *unauthenticated* CONNECT requests on 127.0.0.1:18080 and
re-issues them upstream with Proxy-Authorization attached.

Upstream proxy credentials are read from the `https_proxy` environment
variable at startup and never printed. HTTPS only (CONNECT) — which is all
the test suite needs.

Usage:  python3 proxy_fwd.py   (runs forever on 127.0.0.1:18080)
"""
import base64
import os
import socket
import threading
from urllib.parse import urlparse

LISTEN = ("127.0.0.1", 18080)


def _upstream():
    up = urlparse(os.environ["https_proxy"])
    auth = "Basic " + base64.b64encode(f"{up.username}:{up.password}".encode()).decode()
    return (up.hostname, up.port or 8080), auth


UPSTREAM, AUTH = _upstream()


def _splice(a: socket.socket, b: socket.socket):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _handle(client: socket.socket):
    try:
        req = b""
        while b"\r\n\r\n" not in req:
            chunk = client.recv(4096)
            if not chunk:
                return
            req += chunk
        line = req.split(b"\r\n", 1)[0].decode("latin1")
        parts = line.split(" ")
        if len(parts) < 2 or parts[0] != "CONNECT":
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        target = parts[1]
        up = socket.create_connection(UPSTREAM, timeout=30)
        up.sendall(
            f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"
            f"Proxy-Authorization: {AUTH}\r\n\r\n".encode()
        )
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = up.recv(4096)
            if not chunk:
                return
            resp += chunk
        if b" 200" not in resp.split(b"\r\n", 1)[0]:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            up.close()
            return
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        t1 = threading.Thread(target=_splice, args=(client, up), daemon=True)
        t2 = threading.Thread(target=_splice, args=(up, client), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    except OSError:
        pass
    finally:
        client.close()


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(100)
    print(f"forwarding proxy on {LISTEN[0]}:{LISTEN[1]}", flush=True)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=_handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
